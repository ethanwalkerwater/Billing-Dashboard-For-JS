import cloudbase from "@cloudbase/js-sdk";

import { RdbFeedbackTaskRepository } from "../shared/rdb";
import type { PostgrestLike } from "../shared/rdb";
import type { Role } from "../shared/roles";

const envId = import.meta.env.VITE_CLOUDBASE_ENV_ID;
if (!envId) throw new Error("缺少 VITE_CLOUDBASE_ENV_ID");

export const app = cloudbase.init({ env: envId, region: import.meta.env.VITE_CLOUDBASE_REGION });
export const auth = app.auth;

/** PostgREST 客户端；RLS 决定这个浏览器会话到底能看到什么。 */
// rdb() 不传 schema 时会把环境 ID 当成 schema，报 "Invalid schema"，必须显式指定 public。
export const db = (app as unknown as { rdb: (options?: { schema?: string }) => PostgrestLike }).rdb({ schema: "public" });
export const taskRepository = new RdbFeedbackTaskRepository(db);

/**
 * 已登录且在 feedback_admins 里启用才算登录，顺带读出自己的权限（src/shared/roles.ts）。
 * 读不到自己那一行（旧的账号密码登录态、被停用）就直接登出，免得页面能进、数据却被 RLS 挡成空白。
 */
export async function getSignedInUser(): Promise<{ uid: string; role: Role; feishuMember: boolean } | null> {
  const user = (await auth.getCurrentUser()) as { uid?: string; isAnonymous?: boolean } | null;
  if (!user?.uid || user.isAnonymous) return null;
  const me = await db.from("feedback_admins").select<{ role: Role; feishu_open_id: string | null }>("role,feishu_open_id").eq("user_id", user.uid).limit(1);
  const member = me.data?.[0];
  if (me.error || !member?.role) {
    await auth.signOut().catch(() => undefined);
    return null;
  }
  return { uid: user.uid, role: member.role, feishuMember: Boolean(member.feishu_open_id) };
}

// ---- 飞书登录：流程见 src/server/feishu-login.ts ----

const LOGIN_URL = (import.meta.env.VITE_FEISHU_LOGIN_URL || "https://app.jsjy.asia/auth").replace(/\/$/, "");
const RETURN_HASH_KEY = "feishu-login-return-hash";

/** 跳去飞书授权。# 后的页面路由（如 #/scores）先存起来，回来后恢复。 */
export function startFeishuLogin() {
  try {
    sessionStorage.setItem(RETURN_HASH_KEY, window.location.hash);
  } catch {
    // 无痕模式存不了就算了，回来落在首页
  }
  const next = window.location.origin + window.location.pathname + window.location.search;
  window.location.assign(`${LOGIN_URL}/feishu/start?next=${encodeURIComponent(next)}`);
}

/**
 * 飞书授权回跳时地址是 #feishu_ticket=…&feishu_bind=…：用 ticket 登录 CloudBase，
 * 再让云函数把这个 CloudBase 账号绑到白名单。返回 null 表示没有要处理的回跳或已成功，否则返回错误文案。
 */
export async function completeFeishuLogin(): Promise<string | null> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const ticket = params.get("feishu_ticket");
  const bindToken = params.get("feishu_bind");
  if (!ticket || !bindToken) return null;
  let back = "";
  try {
    back = sessionStorage.getItem(RETURN_HASH_KEY) ?? "";
    sessionStorage.removeItem(RETURN_HASH_KEY);
  } catch {
    back = "";
  }
  // ticket 立刻从地址栏清掉，免得被复制或留在浏览记录里
  window.history.replaceState(null, "", window.location.pathname + window.location.search + back);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  try {
    const result = (await auth.signInWithCustomTicket(() => Promise.resolve(ticket))) as { error?: { message?: string } | null };
    if (result?.error) return result.error.message || "飞书登录失败，请重试";
    const bound = await app.callFunction({ name: "feedback-api", data: { action: "bind-feishu", bindToken } });
    const payload = bound.result as { ok?: boolean; error?: string };
    if (payload?.ok) return null;
    await auth.signOut();
    return payload?.error ?? "飞书登录失败，请重试";
  } catch (cause) {
    await auth.signOut().catch(() => undefined);
    return cause instanceof Error ? cause.message : "飞书登录失败，请重试";
  }
}

export async function callFeedbackApi<T>(data: Record<string, unknown>): Promise<T> {
  const result = await app.callFunction({ name: "feedback-api", data });
  const payload = result.result as T & { ok?: boolean; error?: string };
  if (payload?.ok === false) throw new Error(payload.error ?? "云函数返回失败");
  return payload;
}
