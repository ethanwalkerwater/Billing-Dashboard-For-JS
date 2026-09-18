import type { ScheduleRecord, StudentRecord } from "../../domain";
import { canonicalizeName } from "../../domain";
import { FeishuSchemaError } from "./errors";
import type { FeishuRecord } from "./types";

export interface FeedbackResponseRecord {
  recordId: string;
  /** 问卷里虽有这个字段，但业务方决定不用它绑定；保留只为诊断。 */
  taskId: string | null;
  studentNames: string[];
  teacherNames: string[];
  /** 「身份」字段原始值：学生本人 / 家长/监护人 */
  identity: string[];
  submittedAt: string;
}

function requiredRecordId(record: FeishuRecord): string {
  if (!record.record_id) throw new FeishuSchemaError({ recordId: "未知", fieldName: "record_id", message: "为空" });
  return record.record_id;
}

function readTextValue(value: unknown): string | null {
  if (typeof value === "string") return canonicalizeName(value) || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
    return canonicalizeName(text) || null;
  }
  return null;
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") return canonicalizeName(value) ? [canonicalizeName(value)] : [];
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => {
          if (typeof item === "string") return canonicalizeName(item);
          if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
            return canonicalizeName(item.text);
          }
          return "";
        })
        .filter(Boolean),
    ),
  ];
}

/**
 * 关联字段的值形状随接口和工具而变，实测至少有这几种：
 *   多维表格 v1 records 接口：[{ record_ids: ["recX"], table_id, text, text_arr, type }]
 *   其他模式：{ link_record_ids: [...] }、[{ id }]、[{ record_id }]、["recX"]
 * 只认其中一种会静默得到空数组，整月任务全部变成"缺少学生"。
 */
function readLinkIds(value: unknown): string[] {
  const ids: string[] = [];
  const collect = (item: unknown): void => {
    if (typeof item === "string") {
      if (item) ids.push(item);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    for (const key of ["record_ids", "link_record_ids"]) {
      const list = record[key];
      if (Array.isArray(list)) for (const id of list) if (typeof id === "string" && id) ids.push(id);
    }
    for (const key of ["id", "record_id"]) {
      const single = record[key];
      if (typeof single === "string" && single) ids.push(single);
    }
  };

  if (Array.isArray(value)) for (const item of value) collect(item);
  else collect(value);
  return [...new Set(ids)];
}

function readDateTime(value: unknown): string | null {
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : value;
  }
  return null;
}

export function parseStudentRecord(record: FeishuRecord): StudentRecord {
  const recordId = requiredRecordId(record);
  const name = readTextValue(record.fields["学生姓名"]);
  if (!name) throw new FeishuSchemaError({ recordId, fieldName: "学生姓名", message: "为空或格式无法识别" });
  return { recordId, name };
}

export function parseScheduleRecord(record: FeishuRecord): ScheduleRecord {
  const recordId = requiredRecordId(record);
  const startsAt = readDateTime(record.fields["上课时间"]);
  if (!startsAt) throw new FeishuSchemaError({ recordId, fieldName: "上课时间", message: "为空或格式无法识别" });
  return {
    recordId,
    startsAt,
    studentRecordIds: readLinkIds(record.fields["学生"]),
    teacherNames: readStringList(record.fields["老师"]),
    courseNames: readStringList(record.fields["课程类型"]),
    teachingTypes: readStringList(record.fields["授课类型"]),
    cancellationTags: readStringList(record.fields["临时取消"]),
  };
}

export function parseFeedbackResponse(record: FeishuRecord): FeedbackResponseRecord {
  const recordId = requiredRecordId(record);
  const submittedAt = readDateTime(record.fields["提交时间"] ?? record.created_time);
  if (!submittedAt) throw new FeishuSchemaError({ recordId, fieldName: "提交时间", message: "为空或格式无法识别" });
  return {
    recordId,
    taskId: readTextValue(record.fields["任务ID"]),
    studentNames: readStringList(record.fields["学生姓名"]),
    teacherNames: readStringList(record.fields["老师姓名"]),
    identity: readStringList(record.fields["身份"]),
    submittedAt,
  };
}

