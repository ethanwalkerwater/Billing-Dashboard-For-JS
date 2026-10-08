import { classifyLesson, isWithinMonthInShanghai } from "../../domain";
import { readLinkIds } from "../feishu/parsers";
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
  return buildScheduleCsvWithCount(input).csv;
}

/** 同上，另外返回行数（快照里记一下，评分页显示「课表 N 节」）。 */
export function buildScheduleCsvWithCount(input: {
  records: FeishuRecord[];
  courseMonth: string;
  studentNamesByRecordId: ReadonlyMap<string, string>;
}): { csv: string; rows: number } {
  const rows: Array<Record<string, unknown>> = [];
  for (const record of input.records) {
    const startsAt = record.fields["上课时间"];
    const formatted = formatShanghai(startsAt);
    if (!formatted || !isWithinMonthInShanghai(formatted.replace(" ", "T") + "+08:00", input.courseMonth)) continue;
    // 关联字段形状是 [{ record_ids: [...] }]，不是 [{ id }]；只认 id 会让整列学生为空。
    const studentIds = readLinkIds(record.fields["学生"]);
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
  return { csv: toCsv(SCHEDULE_CSV_HEADERS, rows), rows: rows.length };
}

/**
 * 答卷原样导出：飞书答卷表的列名就是老师反馈系统认的列名
 * （提交时间、身份、老师姓名、学生姓名、【学生】/【家长】各维度），不做重命名。
 */
export function buildFeedbackCsv(input: { records: FeishuRecord[]; collectionMonth: string }): string {
  return buildFeedbackCsvWithCount(input).csv;
}

export function buildFeedbackCsvWithCount(input: { records: FeishuRecord[]; collectionMonth: string }): { csv: string; rows: number } {
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
  return { csv: toCsv(headers, rows), rows: rows.length };
}

/** 解析 toCsv 写出的 CSV（RFC 4180：引号包裹、"" 转义、字段里可有逗号和换行）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * 老师评分只算「课程」：把课表快照里不是课程的行（咨询、考试、会议、自习、作业…）先去掉再交给评分脚本，
 * 判断和问卷名单共用 classifyLesson，评分脚本本身一行不改。返回过滤后的 CSV 和被去掉的课时。
 */
export function keepCourseLessons(
  scheduleCsv: string,
  overrides?: ReadonlyMap<string, boolean>,
): { csv: string; removedRows: number; removedHours: number } {
  const [header, ...rows] = parseCsv(scheduleCsv);
  if (!header) return { csv: scheduleCsv, removedRows: 0, removedHours: 0 };
  const column = (name: string) => header.indexOf(name);
  const [courseIndex, modeIndex, hoursIndex] = [column("课程类型"), column("授课类型"), column("课程时长")];
  const kept: Array<Record<string, string>> = [];
  let removedRows = 0;
  let removedHours = 0;
  for (const cells of rows) {
    const split = (index: number) => (index < 0 ? [] : (cells[index] ?? "").split("、").filter(Boolean));
    if (classifyLesson({ courseTypes: split(courseIndex), teachingTypes: split(modeIndex) }, overrides).isCourse) {
      kept.push(Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
    } else {
      removedRows += 1;
      removedHours += Number(cells[hoursIndex]) || 0;
    }
  }
  return { csv: toCsv(header, kept), removedRows, removedHours };
}
