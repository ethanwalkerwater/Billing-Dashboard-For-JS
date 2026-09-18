export function canonicalizeName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * 姓名匹配用的键：全角转半角、去掉所有空格、忽略大小写。
 * "Kevin Liu" / "kevin liu" / "Kevin　Liu" 视为同一个人；不做更多猜测。
 */
export function nameMatchKey(value: string): string {
  return canonicalizeName(value).replace(/\s+/g, "").toLowerCase();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createStableTaskId(input: {
  courseMonth: string;
  studentRecordId: string;
  teacherCanonicalName: string;
}): Promise<string> {
  const canonical = [input.courseMonth, input.studentRecordId, canonicalizeName(input.teacherCanonicalName)].join("\u001f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `ft_${input.courseMonth.replace("-", "")}_${bytesToHex(new Uint8Array(digest)).slice(0, 24)}`;
}

export function createPublicToken(byteLength = 18): string {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new Error("公开 token 至少需要 16 字节随机数据");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToHex(bytes);
}

export async function createDeterministicPublicToken(taskId: string, pepper: string): Promise<string> {
  if (pepper.length < 32) throw new Error("PUBLIC_TOKEN_PEPPER 至少需要 32 个字符");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(taskId));
  return bytesToHex(new Uint8Array(signature));
}
