/**
 * 一次性：把老看板的历史数据带进新系统。可重复执行（全是 upsert）。
 *
 *   npx tsx scripts/backfill-teacher-scores.ts
 *
 * 1. 历史月度分数：读 outputs/teacher-feedback/cumulative/monthly_score_contributions.csv，
 *    LIVE_SCORES_FROM 之前的月份原样写进 feedback_score_history（老师名换成课表写法）。
 * 2. 老看板 name_mapping.csv 里新系统还没有的老师别名，写进 feedback_name_aliases。
 * 3. 从飞书读一次全表，补齐 2026-05 起各月的课表/答卷快照，评分页的明细和文字评价要用。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createServiceDb } from "../functions/feedback-api/service-db";
import { canonicalizeName, shiftMonth } from "../src/domain";
import { buildFeedbackCsvWithCount, buildScheduleCsvWithCount } from "../src/server/export/csv";
import { FeishuClient } from "../src/server/feishu/client";
import { loadFeishuConfig } from "../src/server/feishu/config";
import { parseStudentRecord } from "../src/server/feishu/parsers";
import { LIVE_SCORES_FROM } from "../src/server/scores/build-request";
import { ALIASES_TABLE, RdbFeedbackTaskRepository, SCORE_HISTORY_TABLE, TASKS_TABLE } from "../src/shared/rdb";

const REPO = resolve(import.meta.dirname, "../../..");
const SNAPSHOT_FROM = "2026-05";

for (const line of readFileSync(resolve(import.meta.dirname, "../server.env"), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match) process.env[match[1]] = match[2];
}

/** 与评分脚本的老师归一化一致：去空白、去「老师」后缀、忽略大小写。 */
function teacherKey(name: string): string {
  const text = canonicalizeName(name).replace(/\s+/g, "");
  return (text.endsWith("老师") ? text.slice(0, -2) : text).toLowerCase();
}

// 老看板 templates/name_mapping.csv 里的老师统一写法，改成指向课表写法。学生那几条只是空格差异，新系统本来就忽略空格。
const LEGACY_TEACHER_ALIASES = [
  { alias: "Valentina林", canonical: "Valentina Lin" },
  { alias: "刘峥", canonical: "Kevin Liu" },
  { alias: "高", canonical: "高志勇" },
];

const db = createServiceDb({ envId: process.env.CLOUDBASE_ENV_ID!, apiKey: process.env.CLOUDBASE_API_KEY! });
const repository = new RdbFeedbackTaskRepository(db);
const config = loadFeishuConfig();
const client = new FeishuClient({ appId: config.appId, appSecret: config.appSecret });

const check = (result: { error: { message: string } | null }, what: string) => {
  if (result.error) throw new Error(`${what}失败：${result.error.message}`);
};

// ---- 2. 别名 ----
check(
  await db.from(ALIASES_TABLE).upsert(
    LEGACY_TEACHER_ALIASES.map((row) => ({ kind: "teacher", ...row, created_by: "legacy-name-mapping" })),
    { onConflict: "kind,alias" },
  ),
  "写入老师别名",
);

// ---- 3. 快照 ----
const [schedule, students, responses] = await Promise.all([
  client.listAllRecords({ appToken: config.scheduleAppToken, tableId: config.scheduleTableId }),
  client.listAllRecords({ appToken: config.scheduleAppToken, tableId: config.studentTableId }),
  client.listAllRecords({ appToken: config.feedbackAppToken, tableId: config.responseTableId }),
]);
const studentNames = new Map<string, string>();
for (const record of students) {
  try {
    const student = parseStudentRecord(record);
    studentNames.set(student.recordId, student.name);
  } catch {
    // 缺姓名的学生在课表 CSV 里留空，和「导出课表」一致
  }
}
const currentMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
  .format(new Date())
  .slice(0, 7);
for (let courseMonth = SNAPSHOT_FROM; courseMonth < currentMonth; courseMonth = shiftMonth(courseMonth, 1)) {
  const lessons = buildScheduleCsvWithCount({ records: schedule, courseMonth, studentNamesByRecordId: studentNames });
  const answers = buildFeedbackCsvWithCount({ records: responses, collectionMonth: shiftMonth(courseMonth, 1) });
  await repository.saveSnapshot("schedule", courseMonth, lessons.csv, lessons.rows);
  await repository.saveSnapshot("feedback", shiftMonth(courseMonth, 1), answers.csv, answers.rows);
  console.log(`快照 ${courseMonth} 课表 ${lessons.rows} 节 · ${shiftMonth(courseMonth, 1)} 答卷 ${answers.rows} 份`);
}

// ---- 1. 历史分数 ----
const taskTeachers = await db.from(TASKS_TABLE).select<{ teacher_canonical_name: string }>("teacher_canonical_name");
check(taskTeachers, "读取老师名");
const scheduleTeachers = schedule.map((record) => record.fields["老师"]).filter((name): name is string => typeof name === "string");
const displayByKey = new Map<string, string>();
for (const name of [...scheduleTeachers, ...(taskTeachers.data ?? []).map((row) => row.teacher_canonical_name)]) {
  displayByKey.set(teacherKey(name), canonicalizeName(name));
}
const aliasByKey = new Map(LEGACY_TEACHER_ALIASES.map((row) => [teacherKey(row.alias), row.canonical]));
const display = (name: string) => {
  const resolved = aliasByKey.get(teacherKey(name)) ?? name;
  return displayByKey.get(teacherKey(resolved)) ?? resolved;
};

const csv = readFileSync(resolve(REPO, "outputs/teacher-feedback/cumulative/monthly_score_contributions.csv"), "utf8").replace(/^﻿/, "");
const [header, ...lines] = csv.trim().split(/\r?\n/);
const columns = header.split(",");
const score = (value: string) => (value === "" ? null : Number(value));
const rows = lines
  .map((line) => Object.fromEntries(line.split(",").map((value, index) => [columns[index], value])))
  .filter((row) => row.report_month < LIVE_SCORES_FROM)
  .map((row) => ({
    course_month: row.report_month,
    teacher: display(row.teacher),
    hours: Number(row.teacher_total_hours),
    responses: Number(row.response_record_count),
    matched_responses: Number(row.matched_response_record_count),
    coverage: Number(row.coverage_rate || 0),
    learning_effect: score(row["学习提升效果"]),
    responsibility: score(row["责任心与服务态度"]),
    charisma: score(row["个人魅力"]),
    source: row.source_kind,
  }));
check(await db.from(SCORE_HISTORY_TABLE).upsert(rows, { onConflict: "course_month,teacher" }), "写入历史分数");
const renamed = [...new Set(lines.map((line) => line.split(",")[columns.indexOf("teacher")]))].filter((name) => display(name) !== name);
console.log(`历史分数 ${rows.length} 行（${[...new Set(rows.map((row) => row.course_month))].join("、")}）`);
console.log(`老师名换成课表写法：${renamed.map((name) => `${name}→${display(name)}`).join("、")}`);
