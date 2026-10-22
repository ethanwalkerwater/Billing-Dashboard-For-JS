/**
 * 答卷表里的「反馈课程月份」字段（文本，值如 2026-10）。二维码预填，答卷靠它归到哪一轮，
 * 所以每个月的二维码和链接都不一样。字段由 scripts/setup-feishu.ts 建好。
 */
export const FEEDBACK_MONTH_FIELD = "反馈课程月份";

/**
 * 预填老师、学生姓名和反馈课程月份。业务方决定不用任务 ID，答卷按姓名匹配回任务。
 * 注意 key 是表单里的**问题标题**，不是字段名（学生姓名字段的标题是「（必填）学生姓名：」）。
 */
export const FORM_PREFILL_KEYS = {
  teacher: "prefill_（必填）您本次评价的老师姓名：",
  student: "prefill_（必填）学生姓名：",
  courseMonth: `prefill_${FEEDBACK_MONTH_FIELD}`,
} as const;

/** 飞书表单的 hide_<题目>=1：预填后把这道题藏起来，学生看不到也改不了月份。 */
export const FORM_HIDE_COURSE_MONTH = `hide_${FEEDBACK_MONTH_FIELD}`;

export function buildPrefilledFormUrl(input: { baseUrl: string; teacherName: string; studentName: string; courseMonth: string }): string {
  const url = new URL(input.baseUrl);
  url.searchParams.set(FORM_PREFILL_KEYS.teacher, input.teacherName);
  url.searchParams.set(FORM_PREFILL_KEYS.student, input.studentName);
  url.searchParams.set(FORM_PREFILL_KEYS.courseMonth, input.courseMonth);
  url.searchParams.set(FORM_HIDE_COURSE_MONTH, "1");
  return url.toString();
}

export function buildPublicTaskUrl(origin: string, publicToken: string): string {
  const normalizedOrigin = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(`t/${encodeURIComponent(publicToken)}`, normalizedOrigin).toString();
}
