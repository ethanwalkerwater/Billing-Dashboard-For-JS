import { canonicalizeName } from "./identity";

/**
 * 一节课算不算「课程」——问卷名单和老师评分共用这一个判断，两边不再各维护一份清单。
 *
 * 业务方 2026-10 定的口径：
 *   课程 = 授课类型为 1v1、刷题班、1v2班课、班课 的课；
 *   咨询、规划、考试、模考、会议、自习、作业、助教、答疑、文书等都不是课程：
 *   不生成反馈问卷，不计入老师总课时和评分权重。试听算课程。
 *
 * 判断顺序（第一条命中即定）：
 *   1. 教务在「课程类型」页手动设过的，以手动为准；
 *   2. 课程类型名命中非课程关键词 → 不是课程（1v1 的「申请咨询」也不是课）；
 *   3. 授课类型是 1v1 / 刷题班 / 1v2班课 / 班课 → 课程；
 *   4. 授课类型是其他值（学生规划、自习、作业、助教、模考、学生模测、其他会议…）→ 不是课程；
 *   5. 授课类型为空、课程类型名也没命中关键词 → 按课程处理，但标「未标注授课类型」让教务复核
 *      （实测「雅思刷题班」就有 227 小时没填授课类型，默认排除会漏掉真课）。
 * 课程类型是自由填写的（462 个选项），关键词兜不住的长尾靠第 1 条人工设定。
 */
export const COURSE_TEACHING_TYPES = ["1v1", "刷题班", "1v2班课", "班课"] as const;

export const NON_COURSE_KEYWORDS: ReadonlyArray<{ group: string; pattern: RegExp }> = [
  { group: "会议/行政", pattern: /会议|例会|对接|培训|面试|前台|课表确定/u },
  { group: "占位/假期/活动", pattern: /空出|请假|假期|团建|聚餐|活动|卡丁车|运动|体检/u },
  { group: "咨询/规划", pattern: /咨询|规划|选课/u },
  { group: "考试/模考", pattern: /考试|笔考|模考|模测|测试|陪考/u },
  { group: "自习/作业/助教", pattern: /自习|作业|助教|看管/u },
  { group: "答疑/文书/其他", pattern: /答疑|文书|翻译/u },
];

export type LessonKindSource = "manual" | "keyword" | "teaching-type" | "default";

export interface LessonKind {
  isCourse: boolean;
  /** 给教务看的一句话原因 */
  reason: string;
  source: LessonKindSource;
}

/** 课程类型 → 是否课程 的人工设定；键用 canonicalizeName 后的课程类型 */
export type CourseTypeOverrides = ReadonlyMap<string, boolean>;

export function classifyLesson(
  input: { courseTypes: readonly string[]; teachingTypes: readonly string[] },
  overrides: CourseTypeOverrides = new Map(),
): LessonKind {
  const courseTypes = input.courseTypes.map(canonicalizeName).filter(Boolean);
  const teachingTypes = input.teachingTypes.map(canonicalizeName).filter(Boolean);

  for (const courseType of courseTypes) {
    const manual = overrides.get(courseType);
    if (manual !== undefined) {
      return { isCourse: manual, reason: `教务设定：「${courseType}」${manual ? "算" : "不算"}课程`, source: "manual" };
    }
  }
  for (const courseType of courseTypes) {
    const hit = NON_COURSE_KEYWORDS.find((rule) => rule.pattern.test(courseType));
    if (hit) return { isCourse: false, reason: `${hit.group}：${courseType}`, source: "keyword" };
  }
  const courseMode = teachingTypes.find((type) => (COURSE_TEACHING_TYPES as readonly string[]).includes(type));
  if (courseMode) return { isCourse: true, reason: `授课类型 ${courseMode}`, source: "teaching-type" };
  if (teachingTypes.length > 0) {
    return { isCourse: false, reason: `授课类型「${teachingTypes.join("、")}」不是课程`, source: "teaching-type" };
  }
  return {
    isCourse: true,
    reason: `未标注授课类型，按课程处理：${courseTypes.join("、") || "（无课程类型）"}`,
    source: "default",
  };
}
