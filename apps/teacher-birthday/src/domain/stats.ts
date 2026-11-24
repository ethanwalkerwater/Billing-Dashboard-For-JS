/** 「这一年」= 今天往前 365 天。只算计费课（有单价、时长 > 0，口径同薪资预警）且非临时取消。 */
import type { LessonStats } from "./dates";

const DAY = 86_400_000;
export const SCHEDULE_STAT_FIELDS = ["老师", "学生", "上课时间", "课程单价", "课程时长", "临时取消"];

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[,¥￥\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "text" in value[0]) return readNumber((value[0] as { text: unknown }).text);
  if (value && typeof value === "object" && Array.isArray((value as { value?: unknown }).value)) return readNumber((value as { value: unknown[] }).value[0]);
  return null;
}

/** search 接口条件：老师 + 上课时间（ExactDate 只精确到天，前后各放宽一天，精确边界在 scheduleStats 里判） */
export function scheduleFilter(scheduleName: string, todayMs: number) {
  return {
    conjunction: "and" as const,
    conditions: [
      { field_name: "老师", operator: "is", value: [scheduleName] },
      { field_name: "上课时间", operator: "isGreater", value: ["ExactDate", String(todayMs - 366 * DAY)] },
      { field_name: "上课时间", operator: "isLess", value: ["ExactDate", String(todayMs + DAY)] },
    ],
  };
}

export function scheduleStats(records: Array<{ fields: Record<string, unknown> }>, todayMs: number): LessonStats {
  let lessons = 0;
  let hours = 0;
  const students = new Set<string>();
  for (const { fields } of records) {
    const startsAt = fields["上课时间"];
    if (typeof startsAt !== "number" || startsAt >= todayMs || startsAt < todayMs - 365 * DAY) continue;
    const length = readNumber(fields["课程时长"]) ?? 0;
    const cancelled = typeof fields["临时取消"] === "string" ? fields["临时取消"].trim() !== "" : Boolean(fields["临时取消"]);
    if (!readNumber(fields["课程单价"]) || length <= 0 || cancelled) continue;
    lessons += 1;
    hours += length;
    const ids = (fields["学生"] as { link_record_ids?: unknown } | undefined)?.link_record_ids;
    if (Array.isArray(ids)) for (const id of ids) students.add(String(id));
  }
  return { lessons, students: students.size, hours: Math.round(hours * 10) / 10 };
}
