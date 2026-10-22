import cloudbase from "@cloudbase/js-sdk/app";
// 按需引入：只要登录、云函数、rdb()，各模块 import 时自行注册。全量引入会带上 AI、存储、实时等，包体多 1/3。
import "@cloudbase/js-sdk/auth";
import "@cloudbase/js-sdk/functions";
import "@cloudbase/js-sdk/mysql";

import type { PostgrestLike } from "../shared/postgrest";

const envId = import.meta.env.VITE_CLOUDBASE_ENV_ID;
if (!envId) throw new Error("缺少 VITE_CLOUDBASE_ENV_ID");

// 同步要读飞书约 20 秒，SDK 默认 15 秒超时不够。
export const app = cloudbase.init({ env: envId, region: import.meta.env.VITE_CLOUDBASE_REGION, timeout: 120_000 });
export const auth = app.auth;

// rdb() 不传 schema 会把环境 ID 当 schema 报 "Invalid schema"，必须显式 public。RLS 决定这个会话能看到什么。
export const db = (app as unknown as { rdb: (options?: { schema?: string }) => PostgrestLike }).rdb({ schema: "public" });

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

export async function callIelts<T>(data: Record<string, unknown>): Promise<T> {
  const result = await app.callFunction({ name: "ielts-api", data });
  const payload = result.result as T & { ok?: boolean; error?: string };
  if (payload?.ok === false) throw new Error(payload.error ?? "云函数返回失败");
  return payload;
}
