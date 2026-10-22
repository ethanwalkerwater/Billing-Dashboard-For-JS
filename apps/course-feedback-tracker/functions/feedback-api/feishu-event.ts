import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

export interface FeishuEventEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  header?: { token?: string; event_type?: string };
  event?: {
    /** drive.file.bitable_record_changed_v1：变更发生在哪张表 */
    table_id?: string;
    action_list?: Array<{ record_id?: string; action?: string }>;
    [key: string]: unknown;
  };
}

export type VerifyResult =
  | { ok: true; challenge: string; payload?: undefined }
  | { ok: true; challenge?: undefined; payload: FeishuEventEnvelope }
  | { ok: false; reason: string };

function headerValue(headers: Record<string, string>, name: string): string {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1] ?? "";
}

/** 飞书事件加密：AES-256-CBC，key = sha256(encryptKey)，前 16 字节是 IV。 */
export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  const buffer = Buffer.from(encrypted, "base64");
  const key = createHash("sha256").update(encryptKey).digest();
  const decipher = createDecipheriv("aes-256-cbc", key, buffer.subarray(0, 16));
  return Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString("utf8");
}

/** 签名：sha256(timestamp + nonce + encryptKey + body)，十六进制。 */
export function feishuSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  body: string;
}): string {
  return createHash("sha256")
    .update(input.timestamp + input.nonce + input.encryptKey + input.body)
    .digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyFeishuEvent(input: {
  body: string;
  headers: Record<string, string>;
  encryptKey?: string;
  verificationToken?: string;
}): VerifyResult {
  if (!input.body) return { ok: false, reason: "EMPTY_BODY" };

  let parsed: FeishuEventEnvelope & { encrypt?: string };
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return { ok: false, reason: "BAD_JSON" };
  }

  // 配了 Encrypt Key 就必须能证明是飞书发的，否则任何人都能伪造答卷事件：
  // 带了签名头就验签；飞书保存请求地址时的 url_verification 不一定带签名头，这时要求报文是加密的——
  // 用 Encrypt Key 解得开、里面的 Verification Token 又对得上，只有飞书做得到。
  if (input.encryptKey) {
    const timestamp = headerValue(input.headers, "x-lark-request-timestamp");
    const nonce = headerValue(input.headers, "x-lark-request-nonce");
    const signature = headerValue(input.headers, "x-lark-signature");
    if (timestamp && nonce && signature) {
      const expected = feishuSignature({ timestamp, nonce, encryptKey: input.encryptKey, body: input.body });
      if (!safeEqual(expected, signature)) return { ok: false, reason: "BAD_SIGNATURE" };
    } else if (!parsed.encrypt || !input.verificationToken) {
      return { ok: false, reason: "MISSING_SIGNATURE" };
    }
  }

  if (parsed.encrypt) {
    if (!input.encryptKey) return { ok: false, reason: "ENCRYPTED_WITHOUT_KEY" };
    try {
      parsed = JSON.parse(decryptFeishuPayload(parsed.encrypt, input.encryptKey));
    } catch {
      return { ok: false, reason: "BAD_ENCRYPTION" };
    }
  }

  const token = parsed.token ?? parsed.header?.token ?? "";
  if (input.verificationToken && !safeEqual(input.verificationToken, token)) {
    return { ok: false, reason: "BAD_TOKEN" };
  }

  if (parsed.type === "url_verification" && parsed.challenge) {
    return { ok: true, challenge: parsed.challenge };
  }
  return { ok: true, payload: parsed };
}
