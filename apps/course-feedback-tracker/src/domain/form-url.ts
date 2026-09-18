/** 只预填老师和学生姓名。业务方决定不用任务 ID，答卷按姓名匹配回任务。 */
export const FORM_PREFILL_KEYS = {
  teacher: "prefill_（必填）您本次评价的老师姓名：",
  student: "prefill_（必填）学生姓名：",
} as const;

export function buildPrefilledFormUrl(input: { baseUrl: string; teacherName: string; studentName: string }): string {
  const url = new URL(input.baseUrl);
  url.searchParams.set(FORM_PREFILL_KEYS.teacher, input.teacherName);
  url.searchParams.set(FORM_PREFILL_KEYS.student, input.studentName);
  return url.toString();
}

export function buildPublicTaskUrl(origin: string, publicToken: string): string {
  const normalizedOrigin = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(`t/${encodeURIComponent(publicToken)}`, normalizedOrigin).toString();
}
