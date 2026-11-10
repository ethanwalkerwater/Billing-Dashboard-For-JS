import { nameMatchKey } from "./identity";

/**
 * 月度课程反馈的初始管理员。只认飞书账号上的姓名，密码账号即使改成同名也不放行。
 * 数据库里的同一份名单在 migrations/202609170005_feishu_admin_allowlist.sql，两边要一起改。
 */
export const FEEDBACK_ADMIN_NAMES = ["包天翊", "黄钢", "徐翰超"] as const;

const ADMIN_NAME_KEYS = new Set(FEEDBACK_ADMIN_NAMES.map((name) => nameMatchKey(name)));
const FEISHU_PROVIDERS = new Set(["feishu", "lark"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isFeishuProvider(value: string): boolean {
  return FEISHU_PROVIDERS.has(value.trim().toLowerCase());
}

/** 飞书登录，且姓名在管理员名单里。其他身份源一律拒绝。 */
export function claimsAllowFeedbackAdmin(claims: unknown): boolean {
  const token = record(claims);
  if (!token) return false;
  const userMetadata = record(token.user_metadata);
  const appMetadata = record(token.app_metadata);
  const name = text(token.name) ?? text(userMetadata?.name) ?? text(userMetadata?.nickname);
  if (!name || !ADMIN_NAME_KEYS.has(nameMatchKey(name))) return false;

  const providers = [text(appMetadata?.provider), text(token.provider)].filter((value): value is string => value !== null);
  if (Array.isArray(appMetadata?.providers)) {
    for (const item of appMetadata.providers) {
      const value = text(item);
      if (value) providers.push(value);
    }
  }
  return providers.some(isFeishuProvider);
}
