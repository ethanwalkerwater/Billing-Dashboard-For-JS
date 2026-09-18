import { isWithinMonthInShanghai } from "../../domain";
import type { FeishuRecord } from "../feishu/types";

/**
 * 导出给现有老师反馈系统（apps/teacher-feedback）的兼容 CSV。
 *
 * 那边的月度处理器用 `datetime.strptime` 解析裸的本地时间，再按 `%Y-%m` 比对月份，
 * 所以这里必须输出上海时区的墙上时间且不带时区后缀，否则整月数据会被判为"不在报表月份"。
 */
const SHANGHAI = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatShanghai(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const milliseconds = typeof value === "number" ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) return "";
  return SHANGHAI.format(new Date(milliseconds)).replace("T", " ");
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) lines.push(headers.map((header) => escape(row[header])).join(","));
  // BOM 让 Excel 正确识别 UTF-8 中文。
  return `﻿${lines.join("\r\n")}\r\n`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join("、");
  if (typeof value === "object" && "text" in value && typeof (value as { text: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  if (typeof value === "object" && "name" in value && typeof (value as { name: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

export const SCHEDULE_CSV_HEADERS = ["上课时间", "老师", "学生", "课程时长", "课程类型", "授课类型", "临时取消"];

export function buildScheduleCsv(input: {
  records: FeishuRecord[];
  courseMonth: string;
  studentNamesByRecordId: ReadonlyMap<string, string>;
}): string {
  const rows: Array<Record<string, unknown>> = [];
  for (const record of input.records) {
    const startsAt = record.fields["上课时间"];
    const formatted = formatShanghai(startsAt);
    if (!formatted || !isWithinMonthInShanghai(formatted.replace(" ", "T") + "+08:00", input.courseMonth)) continue;
    const studentIds = Array.isArray(record.fields["学生"])
      ? (record.fields["学生"] as unknown[]).map((item) =>
          typeof item === "string" ? item : cellText((item as { id?: string }).id ?? item),
        )
      : [];
    rows.push({
      上课时间: formatted,
      老师: cellText(record.fields["老师"]),
      学生: studentIds.map((id) => input.studentNamesByRecordId.get(id) ?? "").filter(Boolean).join("、"),
      课程时长: cellText(record.fields["课程时长"]),
      课程类型: cellText(record.fields["课程类型"]),
      授课类型: cellText(record.fields["授课类型"]),
      临时取消: cellText(record.fields["临时取消"]),
    });
  }
  return toCsv(SCHEDULE_CSV_HEADERS, rows);
}

/**
 * 答卷原样导出：飞书答卷表的列名就是老师反馈系统认的列名
 * （提交时间、身份、老师姓名、学生姓名、【学生】/【家长】各维度），不做重命名。
 */
export function buildFeedbackCsv(input: { records: FeishuRecord[]; collectionMonth: string }): string {
  const headers = [...new Set(input.records.flatMap((record) => Object.keys(record.fields)))];
  if (!headers.includes("提交时间")) headers.unshift("提交时间");
  const rows: Array<Record<string, unknown>> = [];
  for (const record of input.records) {
    const submittedAt = formatShanghai(record.fields["提交时间"] ?? record.created_time);
    if (!submittedAt || !submittedAt.startsWith(input.collectionMonth)) continue;
    const row: Record<string, unknown> = {};
    for (const header of headers) row[header] = cellText(record.fields[header]);
    row["提交时间"] = submittedAt;
    rows.push(row);
  }
  return toCsv(headers, rows);
}
