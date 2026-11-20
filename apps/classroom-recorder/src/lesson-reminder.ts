/** 老报告把无作业、未定安排写成文字；家长页不展示这些占位语。 */
export function reminderText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^(?:课上没有明确布置作业|具体内容待老师安排|本课数据不足|无|暂无|无作业|未布置作业|无明确作业|无课后提醒|暂无课后提醒|无明确安排)[。！.!]?$/u.test(text) ? "" : text;
}

export function lessonReminder(report: { reminder?: string; homework: string; next: string }): string {
  if (report.reminder !== undefined) return reminderText(report.reminder);
  const prep = /准备好|提前准备|带来|带上|带到|预习|整理好|发给|发来|提交/.test(report.next) ? report.next : "";
  return [...new Set([report.homework, prep].map(reminderText).filter(Boolean))].join("\n");
}
