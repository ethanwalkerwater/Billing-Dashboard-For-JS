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

export async function callIelts<T>(data: Record<string, unknown>): Promise<T> {
  const result = await app.callFunction({ name: "ielts-api", data });
  const payload = result.result as T & { ok?: boolean; error?: string };
  if (payload?.ok === false) throw new Error(payload.error ?? "云函数返回失败");
  return payload;
}
