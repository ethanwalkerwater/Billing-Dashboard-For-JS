/** share-api 的分发和权限：入口文件只负责接线，这里可以直接测。 */
import { createHash, timingSafeEqual } from "node:crypto";

import { InputError, SHARE_CODE, makeCode, parseShareInput, toSiteShares } from "../domain/share";
import type { ShareRow } from "../domain/share";

export interface AdminRow {
  display_name?: string | null;
  email?: string | null;
  role?: string | null;
}

export interface Store {
  /** 全部分享页，最近改过的在前 */
  list(): Promise<ShareRow[]>;
  /** 编号撞了返回 undefined */
  insert(row: Omit<ShareRow, "created_at" | "updated_at"> & { created_at: string; updated_at: string }): Promise<ShareRow | undefined>;
  /** 只在 updated_at 还是 expectUpdatedAt 时改；别人先改过（或编号不存在）返回 undefined */
  update(code: string, expectUpdatedAt: string, patch: Partial<ShareRow>): Promise<ShareRow | undefined>;
}

export interface HandlerDeps {
  /** 当前登录的 CloudBase uid；匿名或没登录返回 undefined */
  currentUid: () => string | undefined;
  /** 查 feedback_admins（active=true）里这个 uid 的一行 */
  findAdmin: (uid: string) => Promise<AdminRow | undefined>;
  store: Store;
  /** 通知官网作废分享页缓存；成功返回 true */
  refreshSite: () => Promise<boolean>;
  siteKey: string | undefined;
  now: () => Date;
  randomBytes: (n: number) => Uint8Array;
  log: (message: string) => void;
}

export interface ShareEvent {
  action?: string;
  code?: unknown;
  updatedAt?: unknown;
  title?: unknown;
  intro?: unknown;
  teachers?: unknown;
  active?: unknown;
  httpMethod?: string;
  path?: string;
  headers?: Record<string, string | undefined>;
}

class AuthError extends Error {}

function sameKey(given: unknown, expected: string | undefined): boolean {
  if (!expected || expected.length < 32 || typeof given !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** 教务 = feedback_admins 里 role 是 admin / super（和排课黑名单同一份）。返回显示名，记进「建的人」 */
async function requireStaff(h: HandlerDeps): Promise<string> {
  const uid = h.currentUid();
  if (!uid) throw new AuthError("LOGIN");
  const row = await h.findAdmin(uid);
  if (!row || (row.role !== "admin" && row.role !== "super")) throw new AuthError("NO_ACCESS");
  return row.display_name?.trim() || row.email?.split("@")[0] || "教务";
}

function codeOf(value: unknown): string {
  if (typeof value !== "string" || !SHARE_CODE.test(value)) throw new InputError("链接编号不对，请刷新后再试");
  return value;
}

function stampOf(value: unknown): string {
  if (typeof value !== "string" || !value) throw new InputError("请刷新后再改");
  return value;
}

const STALE = "别人刚改过这个分享页，已经帮你刷新，请再改一次";

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

export function createHandler(h: HandlerDeps) {
  /** 官网取全部有效分享页：GET /share-api/site/shares，请求头 x-site-key */
  async function http(event: ShareEvent) {
    const path = (event.path ?? "").replace(/^\/share-api(?=\/|$)/, "").replace(/\/$/, "");
    if (event.httpMethod !== "GET" || path !== "/site/shares") return json(404, { ok: false, error: "NOT_FOUND" });
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (!sameKey(headers["x-site-key"], h.siteKey)) return json(401, { ok: false });
    try {
      return json(200, { ok: true, shares: toSiteShares(await h.store.list()) });
    } catch (error) {
      h.log(`官网取分享页失败：${error instanceof Error ? error.message : String(error)}`);
      return json(500, { ok: false });
    }
  }

  return async function handle(event: ShareEvent) {
    if (typeof event.httpMethod === "string") return http(event);
    try {
      const me = await requireStaff(h);
      switch (event.action) {
        case "list":
          return { ok: true, me, shares: await h.store.list() };
        case "save": {
          const input = parseShareInput(event);
          const now = h.now().toISOString();
          let share: ShareRow | undefined;
          if (event.code === undefined || event.code === null) {
            // 编号撞了换一个再试；8 位随机撞上的概率极小，试 3 次还撞就是出问题了
            for (let i = 0; i < 3 && !share; i++) {
              share = await h.store.insert({ code: makeCode(h.randomBytes(8)), ...input, active: true, created_by: me, created_at: now, updated_by: me, updated_at: now });
            }
            if (!share) throw new Error("生成编号连续撞车");
          } else {
            share = await h.store.update(codeOf(event.code), stampOf(event.updatedAt), { ...input, updated_by: me, updated_at: now });
            if (!share) return { ok: false, reason: "STALE", error: STALE };
          }
          return { ok: true, share, refreshed: await h.refreshSite() };
        }
        case "set-active": {
          if (typeof event.active !== "boolean") throw new InputError("请刷新后再试");
          const share = await h.store.update(codeOf(event.code), stampOf(event.updatedAt), { active: event.active, updated_by: me, updated_at: h.now().toISOString() });
          if (!share) return { ok: false, reason: "STALE", error: STALE };
          return { ok: true, share, refreshed: await h.refreshSite() };
        }
        case "refresh":
          return { ok: true, refreshed: await h.refreshSite() };
        default:
          return { ok: false, error: `未知操作：${event.action ?? "(空)"}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 字段不能叫 code：CloudBase js-sdk 见到返回值里有 code 就当调用失败直接抛错
      if (error instanceof AuthError) return { ok: false, reason: message, error: message === "LOGIN" ? "请先登录" : "只有教务能用老师分享" };
      if (error instanceof InputError) return { ok: false, error: message };
      h.log(message);
      return { ok: false, error: "服务暂时出错，请稍后再试" };
    }
  };
}
