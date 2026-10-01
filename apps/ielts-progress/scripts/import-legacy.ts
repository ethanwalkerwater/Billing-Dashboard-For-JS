/**
 * 一次性导入旧系统导出的 teacher_score_records_*.csv，整行替换 ielts_snapshots.legacy。
 *   npm run import:legacy -w @jingshi/ielts-progress -- ../../data/local/ielts-progress/teacher_score_records_xxx.csv
 * 老师名对照课表「老师」单选字段的选项；对不上的名字直接失败，到 TEACHER_ALIASES 里补。
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { legacySamples } from "../src/domain/progress";
import type { LegacyRow } from "../src/domain/progress";
import { FeishuClient } from "../src/server/feishu/client";
import { SNAPSHOTS_TABLE } from "../src/shared/postgrest";
import { createServiceDb } from "../functions/ielts-api/service-db";

const TEACHER_ALIASES: Record<string, string> = {
  Kevin: "Kevin Liu",
  "Valentina 林": "Valentina Lin",
};

const file = process.argv[2];
if (!file) throw new Error("用法：npm run import:legacy -- <csv 路径>");
process.loadEnvFile(resolve(import.meta.dirname, "../server.env"));
const env = (name: string) => process.env[name] || (() => { throw new Error(`server.env 缺少 ${name}`); })();

// 旧系统导出没有带引号的字段；出现引号说明格式变了，宁可停下也不错切列
const text = readFileSync(file, "utf8").replace(/^﻿/, "");
if (text.includes('"')) throw new Error("CSV 含引号字段，这个脚本只认简单逗号分隔");
const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
const columns = header!.split(",");
const rows = lines.map((line, index) => {
  const cells = line.split(",");
  if (cells.length !== columns.length) throw new Error(`第 ${index + 2} 行有 ${cells.length} 列，表头 ${columns.length} 列`);
  return Object.fromEntries(columns.map((name, i) => [name, cells[i]!])) as unknown as LegacyRow;
});

const client = new FeishuClient({ appId: env("FEISHU_APP_ID"), appSecret: env("FEISHU_APP_SECRET") });
const fields = await client.listAllFields({ appToken: env("FEISHU_SCHEDULE_APP_TOKEN"), tableId: env("FEISHU_SCHEDULE_TABLE_ID") });
const teacherField = fields.find((field) => field.field_name === "老师");
const knownTeachers = new Set((teacherField?.property?.options ?? []).map((option) => option.name));
if (knownTeachers.size === 0) throw new Error("读不到课表「老师」字段的选项");

const samples = legacySamples(rows, TEACHER_ALIASES, knownTeachers);
const importedAt = new Date().toISOString();
const db = createServiceDb({ envId: env("CLOUDBASE_ENV_ID"), apiKey: env("CLOUDBASE_API_KEY") });
const written = await db
  .from(SNAPSHOTS_TABLE)
  .upsert([{ key: "legacy", data: { samples, sourceFile: basename(file), importedAt }, updated_at: importedAt }], { onConflict: "key" });
if (written.error) throw new Error(`写入失败：${written.error.message}`);
console.log(`已导入 ${rows.length} 行 → ${samples.length} 条样本`);
