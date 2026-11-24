/**
 * 学生自助取消课程的业务规则（纯函数，不碰飞书和数据库）。
 *
 * 收费档位按「提交问卷的时间」距上课时间计算，取值就是课表「临时取消」单选的选项名，
 * 写回课表后由 billing-core 的 CANCELLATION_RATES 计费。
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 选课页展示的时间窗：正在上的课 + 接下来 14 天。 */
export const LISTING_WINDOW_MS = 14 * DAY;

export type CancellationTier = "0h-70%" | "2h-50%" | "6h-30%" | "提前取消-0%" | "学生病假-0%";
export type CancellationReason = "personal" | "sick";

export interface CancellableLesson {
  /** 课表记录 ID */
  recordId: string;
  /** 飞书课表中本节课的定位链接，沿用原有访问权限。 */
  scheduleUrl?: string;
  /** 课表「学生」关联到学生表的记录 ID */
  studentRecordIds: string[];
  teacherName: string;
  /** 「老师-日历」人员字段里的飞书 open_id；拿不到时为 null，改由教务群提醒 */
  teacherOpenId: string | null;
  courseName: string;
  startMs: number;
  endMs: number;
  /** 课表「临时取消」当前值，空串表示正常上课 */
  cancellation: string;
}

export interface TierResult {
  tier: CancellationTier;
  /** 收费比例 0–1 */
  rate: number;
  /** 距上课的毫秒数，已开课为负数 */
  leadMs: number;
}

export function cancellationTier(
  lesson: Pick<CancellableLesson, "startMs">,
  submittedMs: number,
  reason: CancellationReason,
): TierResult {
  const leadMs = lesson.startMs - submittedMs;
  if (reason === "sick") return { tier: "学生病假-0%", rate: 0, leadMs };
  if (leadMs <= 0) return { tier: "0h-70%", rate: 0.7, leadMs };
  if (leadMs <= 2 * HOUR) return { tier: "2h-50%", rate: 0.5, leadMs };
  if (leadMs <= 6 * HOUR) return { tier: "6h-30%", rate: 0.3, leadMs };
  return { tier: "提前取消-0%", rate: 0, leadMs };
}

export type RejectionCode = "NOT_OWN_LESSON" | "ALREADY_CANCELLED" | "LESSON_ENDED" | "GROUP_LESSON";

export const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  NOT_OWN_LESSON: "这节课不属于该学生",
  ALREADY_CANCELLED: "这节课已经取消过",
  LESSON_ENDED: "这节课已经下课，不能再取消",
  GROUP_LESSON: "多人同上的课程不能自助取消，请联系教务",
};

export type ValidationResult = { ok: true } | { ok: false; code: RejectionCode; message: string };

export function validateCancellation(input: {
  lesson: CancellableLesson;
  studentRecordId: string;
  submittedMs: number;
}): ValidationResult {
  const { lesson } = input;
  const reject = (code: RejectionCode): ValidationResult => ({ ok: false, code, message: REJECTION_MESSAGES[code] });
  if (!lesson.studentRecordIds.includes(input.studentRecordId)) return reject("NOT_OWN_LESSON");
  // 多人共用一条课表记录，写「临时取消」会把其他同学也一起取消计费
  if (lesson.studentRecordIds.length > 1) return reject("GROUP_LESSON");
  if (lesson.cancellation.trim()) return reject("ALREADY_CANCELLED");
  if (input.submittedMs >= lesson.endMs) return reject("LESSON_ENDED");
  return { ok: true };
}

export type ListingStatus = "available" | "cancelled" | "group";

export interface ListedLesson {
  lesson: CancellableLesson;
  status: ListingStatus;
  /** 按「现在」提交时的收费档位，选课页提示用；以实际提交时间为准 */
  preview: TierResult;
}

export function listCancellableLessons(
  lessons: CancellableLesson[],
  studentRecordId: string,
  nowMs: number,
): ListedLesson[] {
  return lessons
    .filter((lesson) => lesson.studentRecordIds.includes(studentRecordId))
    .filter((lesson) => lesson.endMs > nowMs && lesson.startMs <= nowMs + LISTING_WINDOW_MS)
    .sort((a, b) => a.startMs - b.startMs || a.recordId.localeCompare(b.recordId))
    .map((lesson) => ({
      lesson,
      status: lesson.cancellation.trim() ? "cancelled" : lesson.studentRecordIds.length > 1 ? "group" : "available",
      preview: cancellationTier(lesson, nowMs, "personal"),
    }));
}
