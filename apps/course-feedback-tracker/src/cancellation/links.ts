/** 学生专属取消链接的公开地址（选课页部署在静态托管 /cancel/）。 */
export const CANCEL_PAGE_ORIGIN = "https://app.jsjy.asia/cancel/";

export function cancelLinkUrl(token: string): string {
  return `${CANCEL_PAGE_ORIGIN}?t=${encodeURIComponent(token)}`;
}
