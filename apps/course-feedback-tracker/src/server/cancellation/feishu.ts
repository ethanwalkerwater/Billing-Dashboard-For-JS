/**
 * 取消课程用到的飞书读写：课表（读窗口内的课、写「临时取消」）和「取消申请」问卷表。
 * 字段名集中在这里，切换到主课表时只改配置，不改代码。
 */
import type { CancellableLesson, CancellationReason, CancellationTier } from "../../cancellation/rules";
import type { CancelRequest } from "../../cancellation/service";
import { FORM_INTENT_FIELD } from "../../cancellation/service";
import type { FeishuClient } from "../feishu/client";
import { readLinkIds } from "../feishu/parsers";
import type { FeishuRecord } from "../feishu/types";

export interface CancelFeishuConfig {
  scheduleAppToken: string;
  scheduleTableId: string;
  requestAppToken: string;
  requestTableId: string;
}

export const SCHEDULE_FIELDS = ["学生", "老师", "老师-日历", "课程类型", "上课时间", "下课时间", "临时取消"] as const;

export const REQUEST_FIELDS = {
  intent: FORM_INTENT_FIELD,
  reason: "取消原因",
  note: "补充说明",
  sickProof: "病假证明",
  result: "处理结果",
} as const;

function plainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(",");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // 公式/查找引用在 search 接口里是 {type, value: [...]}
    if ("value" in record) return plainText(record.value);
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.name === "string") return record.name.trim();
  }
  return "";
}

function readMs(value: unknown): number | null {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (value && typeof value === "object" && "value" in value) return readMs((value as { value: unknown }).value);
  if (Array.isArray(value)) return readMs(value[0]);
  return null;
}

/** 人员字段：[{ id: "ou_xxx", name }]；取第一位 */
function readPersonOpenId(value: unknown): string | null {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === "string" && id.startsWith("ou_")) return id;
    }
  }
  return null;
}

/** 学生是关联字段时用学生表记录 ID；测试表若是文本字段，退回用逗号拆开的学生名 */
function readStudentKeys(value: unknown): string[] {
  const ids = readLinkIds(value).filter((id) => id.startsWith("rec"));
  if (ids.length) return ids;
  return plainText(value)
    .split(/[,，、]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function parseLesson(record: FeishuRecord): CancellableLesson | null {
  const fields = record.fields;
  const startMs = readMs(fields["上课时间"]);
  const endMs = readMs(fields["下课时间"]);
  if (startMs == null || endMs == null) return null;
  return {
    recordId: record.record_id,
    studentRecordIds: readStudentKeys(fields["学生"]),
    teacherName: plainText(fields["老师"]),
    teacherOpenId: readPersonOpenId(fields["老师-日历"]),
    courseName: plainText(fields["课程类型"]),
    startMs,
    endMs,
    cancellation: plainText(fields["临时取消"]),
  };
}

function parseReason(value: unknown): CancellationReason {
  return /病/.test(plainText(value)) ? "sick" : "personal";
}

export function parseRequest(record: FeishuRecord): CancelRequest {
  const fields = record.fields;
  const proof = fields[REQUEST_FIELDS.sickProof];
  return {
    recordId: record.record_id,
    intentId: plainText(fields[REQUEST_FIELDS.intent]),
    reason: parseReason(fields[REQUEST_FIELDS.reason]),
    note: plainText(fields[REQUEST_FIELDS.note]),
    hasSickProof: Array.isArray(proof) && proof.length > 0,
    // 问卷提交即创建记录，创建时间就是提交时间
    submittedMs: readMs(record.created_time) ?? Date.now(),
    processed: Boolean(plainText(fields[REQUEST_FIELDS.result])),
  };
}

const DAY = 24 * 3_600_000;

export function createFeishuCancellationAdapters(client: FeishuClient, config: CancelFeishuConfig) {
  const schedule = { appToken: config.scheduleAppToken, tableId: config.scheduleTableId };
  const requests = { appToken: config.requestAppToken, tableId: config.requestTableId };
  return {
    schedule: {
      async listWindow(fromMs: number, toMs: number): Promise<CancellableLesson[]> {
        // 飞书 ExactDate 只精确到天，前后各放宽一天取超集
        const records = await client.searchRecords({
          ...schedule,
          fieldNames: [...SCHEDULE_FIELDS],
          filter: {
            conjunction: "and",
            conditions: [
              { field_name: "上课时间", operator: "isGreater", value: ["ExactDate", String(fromMs - DAY)] },
              { field_name: "上课时间", operator: "isLess", value: ["ExactDate", String(toMs + DAY)] },
            ],
          },
        });
        return records.map(parseLesson).filter((lesson): lesson is CancellableLesson => lesson !== null);
      },
      async get(recordId: string): Promise<CancellableLesson | null> {
        const record = await client.getRecord({ ...schedule, recordId });
        return record ? parseLesson(record) : null;
      },
      async writeCancellation(recordId: string, tier: CancellationTier): Promise<void> {
        await client.updateRecord({ ...schedule, recordId, fields: { 临时取消: tier } });
      },
    },
    requests: {
      async get(recordId: string): Promise<CancelRequest | null> {
        const record = await client.getRecord({ ...requests, recordId });
        return record ? parseRequest(record) : null;
      },
      async writeResult(recordId: string, result: string): Promise<void> {
        await client.updateRecord({ ...requests, recordId, fields: { [REQUEST_FIELDS.result]: result } });
      },
    },
  };
}
