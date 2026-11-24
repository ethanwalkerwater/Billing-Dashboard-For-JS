import { createHmac, timingSafeEqual } from "node:crypto";

const lifetime = 8 * 60 * 60_000;
const openIdPattern = /^ou_[A-Za-z0-9_-]{8,64}$/;
const grantPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function signature(payload: string, key: string) {
  return createHmac("sha256", key).update("fupan-session:v1:" + payload).digest("base64url");
}

export function issueReviewSession(openId: string, grant: string, key: string, now = Date.now()) {
  if (!openIdPattern.test(openId) || !grantPattern.test(grant)) throw new Error("主管授权记录无效");
  const payload = [openId, grant, now + lifetime].join(".");
  return "fp1." + payload + "." + signature(payload, key);
}

export function readReviewSession(auth: string, key: string, now = Date.now()) {
  const match = /^Bearer fp1\.([\w-]{1,70})\.([\w-]{36})\.(\d{13})\.([\w-]{43})$/i.exec(auth);
  if (!match) return;
  const [, openId, grant, expires, mac] = match;
  if (!openIdPattern.test(openId) || !grantPattern.test(grant) || +expires <= now || +expires > now + lifetime) return;
  const expected = signature([openId, grant, expires].join("."), key);
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return;
  return { openId, grant };
}
