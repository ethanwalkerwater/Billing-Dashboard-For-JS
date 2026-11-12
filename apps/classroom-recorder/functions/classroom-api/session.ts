import { createHmac, timingSafeEqual } from "node:crypto";
import { DAY } from "../../src/server/logic";

export type Session = { _id: string; openId: string; name: string; scheduleName: string };
type SignedSession = Session & { exp: number };
export const SESSION_RENEW_MS = 7 * DAY;

const sign = (payload: string, key: string) =>
  createHmac("sha256", key).update("classroom.desktop.session.v1\0").update(payload).digest();

export function issueSession({ _id, openId, name, scheduleName }: Session, key: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ _id, openId, name, scheduleName, exp: now + 30 * DAY })).toString("base64url");
  return `s1.${payload}.${sign(payload, key).toString("base64url")}`;
}

export function readSession(token: string, key: string, now = Date.now()): SignedSession | undefined {
  const match = /^s1\.([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return;
  const [, payload, signature] = match;
  const expected = sign(payload, key);
  if (!timingSafeEqual(Buffer.from(signature, "base64url"), expected)) return;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString()) as SignedSession;
    if (typeof session?._id === "string" && /^[a-f0-9]{64}$/.test(session._id) &&
        typeof session.openId === "string" && session.openId &&
        typeof session.name === "string" && typeof session.scheduleName === "string" && session.scheduleName &&
        Number.isSafeInteger(session.exp) && session.exp > now) return session;
  } catch {
    return;
  }
}
