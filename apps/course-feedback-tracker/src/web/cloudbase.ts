import cloudbase from "@cloudbase/js-sdk";

import { RdbFeedbackTaskRepository } from "../shared/rdb";
import type { PostgrestLike } from "../shared/rdb";

const envId = import.meta.env.VITE_CLOUDBASE_ENV_ID;
if (!envId) throw new Error("缺少 VITE_CLOUDBASE_ENV_ID");

export const app = cloudbase.init({ env: envId, region: import.meta.env.VITE_CLOUDBASE_REGION });
export const auth = app.auth;

/** PostgREST 客户端；RLS 决定这个浏览器会话到底能看到什么。 */
// rdb() 不传 schema 时会把环境 ID 当成 schema，报 "Invalid schema"，必须显式指定 public。
export const db = (app as unknown as { rdb: (options?: { schema?: string }) => PostgrestLike }).rdb({ schema: "public" });
export const taskRepository = new RdbFeedbackTaskRepository(db);

export async function getSignedInUser() {
  const user = await auth.getCurrentUser();
  return user && !(user as { isAnonymous?: boolean }).isAnonymous ? user : null;
}

export async function callFeedbackApi<T>(data: Record<string, unknown>): Promise<T> {
  const result = await app.callFunction({ name: "feedback-api", data });
  const payload = result.result as T & { ok?: boolean; error?: string };
  if (payload?.ok === false) throw new Error(payload.error ?? "云函数返回失败");
  return payload;
}

/** 飞书问卷分享链接。二维码直接编码它 + 预填参数，不再经过我们的短链接中转。 */
export function feishuFormUrl(): string {
  const url = import.meta.env.VITE_FEISHU_FORM_URL;
  if (!url) throw new Error("缺少 VITE_FEISHU_FORM_URL");
  return url;
}
