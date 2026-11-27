import cloudbase from "@cloudbase/js-sdk";

import { parseApiResult } from "./api-result";

const envId = import.meta.env.VITE_CLOUDBASE_ENV_ID;
if (!envId) throw new Error("缺少 VITE_CLOUDBASE_ENV_ID");

// 只读写一张小表，20 秒足够
export const app = cloudbase.init({ env: envId, region: import.meta.env.VITE_CLOUDBASE_REGION, timeout: 20_000 });
export const auth = app.auth;
// 本地联调用自定义登录 ticket（docs/口径/cloudbase.md「本地联调飞书登录的应用」）
if (import.meta.env.DEV) (window as unknown as { __tcb: unknown }).__tcb = app;

export async function getSignedInUser() {
  const user = await auth.getCurrentUser();
  return user && !(user as { isAnonymous?: boolean }).isAnonymous ? user : null;
}

// ---- 飞书登录：登录端点在反馈追踪系统的 feedback-api（apps/course-feedback-tracker/src/server/feishu-login.ts） ----

const LOGIN_URL = (import.meta.env.VITE_FEISHU_LOGIN_URL || "https://app.jsjy.asia/auth").replace(/\/$/, "");

export function startFeishuLogin() {
  const next = window.location.origin + window.location.pathname + window.location.search;
  window.location.assign(`${LOGIN_URL}/feishu/start?next=${encodeURIComponent(next)}`);
}

/**
 * 飞书授权回跳时地址是 #feishu_ticket=…&feishu_bind=…：用 ticket 登录 CloudBase，
 * 再让 feedback-api 把这个 CloudBase 账号绑到白名单。返回 null 表示没有要处理的回跳或已成功，否则返回错误文案。
 */
export async function completeFeishuLogin(): Promise<string | null> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const ticket = params.get("feishu_ticket");
  const bindToken = params.get("feishu_bind");
  if (!ticket || !bindToken) return null;
  // ticket 立刻从地址栏清掉，免得被复制或留在浏览记录里
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
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

export { ApiError } from "./api-result";

export async function callShareApi<T>(data: Record<string, unknown>): Promise<T> {
  const result = await app.callFunction({ name: "share-api", data });
  return parseApiResult<T>(result.result);
}
