/**
 * share-api —— 老师分享页唯一的云函数。
 *
 * 后台 /share/：callFunction({ name: 'share-api', data: { action: 'list' | 'save' | 'set-active' | 'refresh', ... } })，要求教务（admin / super）。
 * 官网：GET https://app.jsjy.asia/share-api/site/shares（x-site-key），一次取回全部有效分享页，官网自己缓存；家长打开不会调到这里。
 * 分发和权限在 src/server/handler.ts（有测试），这里只接线。
 */
import { randomBytes } from "node:crypto";

import cloudbase from "@cloudbase/node-sdk";

import type { ShareRow } from "../../src/domain/share";
import { createHandler } from "../../src/server/handler";
import type { AdminRow, Store } from "../../src/server/handler";

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少服务端配置 ${name}`);
  return value;
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = `https://${requireEnv("CLOUDBASE_ENV_ID")}.api.tcloudbasegateway.com/v1/rdb/rest`;
  return fetch(`${base}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${requireEnv("CLOUDBASE_API_KEY")}`,
      accept: "application/json",
      "accept-profile": "public",
      "content-profile": "public",
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function rows<T>(response: Response, what: string): Promise<T[]> {
  if (!response.ok) throw new Error(`${what}失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T[];
}

const store: Store = {
  async list() {
    return rows<ShareRow>(await rest("teacher_shares?order=updated_at.desc&limit=2000"), "读分享页");
  },
  async insert(row) {
    const response = await rest("teacher_shares", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(row) });
    if (response.status === 409) return undefined;
    return (await rows<ShareRow>(response, "新建分享页"))[0];
  },
  async update(code, expectUpdatedAt, patch) {
    const search = new URLSearchParams({ code: `eq.${code}`, updated_at: `eq.${expectUpdatedAt}` });
    const response = await rest(`teacher_shares?${search}`, { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify(patch) });
    return (await rows<ShareRow>(response, "修改分享页"))[0];
  },
};

async function findAdmin(uid: string): Promise<AdminRow | undefined> {
  const search = new URLSearchParams({ select: "display_name,email,role", user_id: `eq.${uid}`, active: "eq.true" });
  return (await rows<AdminRow>(await rest(`feedback_admins?${search}`), "读取管理员名单"))[0];
}

async function refreshSite(): Promise<boolean> {
  const url = process.env.SITE_REVALIDATE_URL?.trim() || "https://jsjy.asia/api/revalidate";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-site-key": requireEnv("SITE_KEY"), "content-type": "application/json" },
      body: JSON.stringify({ target: "shares" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) console.error("[share-api] 通知官网失败", response.status);
    return response.ok;
  } catch (error) {
    console.error("[share-api] 通知官网失败", error instanceof Error ? error.message : error);
    return false;
  }
}

export const main = createHandler({
  currentUid: () => {
    try {
      const user = app.auth().getUserInfo();
      return user?.isAnonymous ? undefined : user?.uid || undefined;
    } catch {
      return undefined;
    }
  },
  findAdmin,
  store,
  refreshSite,
  siteKey: process.env.SITE_KEY?.trim(),
  now: () => new Date(),
  randomBytes: (n) => randomBytes(n),
  log: (message) => console.error("[share-api]", message),
});
