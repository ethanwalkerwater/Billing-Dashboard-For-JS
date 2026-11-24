/**
 * 给学员信息表里的学生生成「取消课程」专属链接；已有有效链接的学生沿用原链接。
 * 生成脚本（scripts/cancel-links.ts）和工作台「生成新学生链接」按钮共用。
 */
import { randomBytes } from "node:crypto";

import type { FeishuClient } from "../feishu/client";
import type { PostgrestLike } from "../../shared/rdb";
import { CANCEL_LINKS_TABLE } from "./store";

function plain(value: unknown): string {
  if (Array.isArray(value)) return value.map(plain).join("");
  if (value && typeof value === "object") return String((value as { text?: string }).text ?? "");
  return String(value ?? "");
}

/** 学员信息表的在读学生：记录 ID 就是课表「学生」关联里的 ID */
export async function listStudents(
  client: FeishuClient,
  input: { appToken: string; studentTableId: string; includeGraduated?: boolean },
): Promise<Map<string, string>> {
  const records = await client.searchRecords({
    appToken: input.appToken,
    tableId: input.studentTableId,
    fieldNames: ["学生姓名", "在读"],
    filter: { conjunction: "and", conditions: [] },
  });
  const students = new Map<string, string>();
  for (const record of records) {
    const name = plain(record.fields["学生姓名"]).trim();
    if (name && (input.includeGraduated || plain(record.fields["在读"]) !== "毕业")) students.set(record.record_id, name);
  }
  return students;
}

export interface EnsureLinksResult {
  created: Array<{ studentKey: string; studentName: string; token: string }>;
  existing: number;
}

export async function ensureLinks(
  db: PostgrestLike,
  students: Map<string, string>,
  options: { revokeKeys?: Set<string> } = {},
): Promise<EnsureLinksResult> {
  const current = await db.from(CANCEL_LINKS_TABLE).select<{ token: string; student_key: string }>("token,student_key").eq("active", true);
  if (current.error) throw new Error(`读取已有链接失败：${current.error.message}`);
  const activeByStudent = new Map((current.data ?? []).map((row) => [row.student_key, row.token]));

  const created: EnsureLinksResult["created"] = [];
  let existing = 0;
  for (const [studentKey, studentName] of students) {
    const old = activeByStudent.get(studentKey);
    if (old && !options.revokeKeys?.has(studentKey)) {
      existing += 1;
      continue;
    }
    if (old) {
      const result = await db.from(CANCEL_LINKS_TABLE).update({ active: false }).eq("token", old);
      if (result.error) throw new Error(`停用 ${studentName} 的旧链接失败：${result.error.message}`);
    }
    created.push({ studentKey, studentName, token: randomBytes(12).toString("base64url") });
  }
  if (created.length) {
    const result = await db.from(CANCEL_LINKS_TABLE).insert(
      created.map((row) => ({ token: row.token, student_key: row.studentKey, student_name: row.studentName })),
    );
    if (result.error) throw new Error(`保存新链接失败：${result.error.message}`);
  }
  return { created, existing };
}
