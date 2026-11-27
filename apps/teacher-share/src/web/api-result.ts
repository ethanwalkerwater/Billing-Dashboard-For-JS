/** share-api 返回值 → 成功数据或带原因的错误。和 SDK 无关，单独放这里好测。 */
export type ApiReason = "NO_ACCESS" | "LOGIN" | "STALE";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly reason?: ApiReason,
  ) {
    super(message);
  }
}

/** 函数返回 { ok:false, reason, error }；字段不能叫 code，CloudBase js-sdk 见到 code 会直接抛错 */
export function parseApiResult<T>(payload: unknown): T {
  const p = payload as { ok?: boolean; error?: string; reason?: string } | null | undefined;
  if (!p || p.ok === false) {
    const reason = p?.reason === "NO_ACCESS" || p?.reason === "LOGIN" || p?.reason === "STALE" ? p.reason : undefined;
    throw new ApiError(p?.error ?? "云函数返回失败", reason);
  }
  return payload as T;
}
