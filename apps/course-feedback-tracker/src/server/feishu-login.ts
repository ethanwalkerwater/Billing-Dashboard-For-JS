import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 教务网站（反馈工作台 /feedback/、取消课程 /cancellations/、雅思正向率 /ielts/）的飞书登录。
 *
 * 流程：网页跳到 feedback-api 的 /auth/feishu/start → 飞书授权 → /auth/feishu/callback 用 open_id 查
 * feedback_admins 白名单 → 签 CloudBase 自定义登录 ticket，带着它跳回网页 →
 * 网页 signInWithCustomTicket 后调 bind-feishu，把这个 CloudBase 用户 ID 写进白名单行的 user_id。
 * RLS 的 auth.uid() 和各云函数的 getUserInfo().uid 都还按 user_id 判断，所以业务表一条都不用改。
 *
 * 这里只放纯逻辑（签名、校验、回跳地址白名单），方便单测；网络与数据库 IO 在 feedback-api。
 */

export const STATE_TTL_MS = 10 * 60_000;

type Signed<T> = T & { exp: number };

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`feishu-login:${payload}`).digest("base64url");
}

/** 把一个小对象签成 `payload.signature`，供 state（回跳地址）和 bind token（open_id）使用。 */
export function seal<T extends object>(value: T, secret: string, now = Date.now(), ttlMs = STATE_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ ...value, exp: now + ttlMs, n: randomBytes(6).toString("base64url") })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** 签名不对、格式不对或过期都返回 null，调用方统一当「链接已过期」处理。 */
export function unseal<T extends object>(token: string, secret: string, now = Date.now()): Signed<T> | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Signed<T>;
    return typeof value.exp === "number" && value.exp > now ? value : null;
  } catch {
    return null;
  }
}

/** 只允许跳回自己的网站，防止被拿去做开放重定向。去掉 # 后面的部分，ticket 会接在 # 后。 */
export function safeNext(next: string | undefined, allowedOrigins: string[]): string | null {
  if (!next) return null;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return null;
  }
  if (!allowedOrigins.includes(url.origin)) return null;
  url.hash = "";
  return url.href;
}

export function parseOrigins(value: string | undefined): string[] {
  return (value || "https://app.jsjy.asia")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * CloudBase 自定义登录的用户 ID 只能 4–32 位，飞书 open_id（ou_ + 32 位）超长，取哈希前缀。
 * 同一个飞书账号每次得到同一个 ID，所以重复登录还是同一个 CloudBase 用户。
 */
export function customUserId(openId: string): string {
  return `fs_${createHash("sha256").update(openId).digest("base64url").slice(0, 24)}`;
}

export function loginRedirect(next: string, ticket: string, bindToken: string): string {
  return `${next}#feishu_ticket=${encodeURIComponent(ticket)}&feishu_bind=${encodeURIComponent(bindToken)}`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** 登录失败时飞书回调落在 API 域名上，给一个能看懂的页面，而不是 JSON。 */
export function loginPage(statusCode: number, title: string, message: string, back?: string) {
  const link = back ? `<p><a href="${escapeHtml(back)}">返回重新登录</a></p>` : "";
  return {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font:15px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:18vh auto;padding:0 20px;color:#1a1d1b">
<h1 style="font-size:20px">${escapeHtml(title)}</h1><p style="word-break:break-all">${escapeHtml(message)}</p>${link}</body>`,
  };
}
