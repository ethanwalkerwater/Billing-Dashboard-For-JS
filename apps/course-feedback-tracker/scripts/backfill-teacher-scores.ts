/**
 * 一次性：把老看板的历史数据带进新系统，并把每个月的评分结果算好存进 feedback_score_results。
 * 可重复执行（全是 upsert）。需要本机 python3。
 *
 *   npx tsx scripts/backfill-teacher-scores.ts
 *
 * 1. 老看板 name_mapping.csv 里新系统还没有的老师别名 → feedback_name_aliases。
 * 2. 从飞书读一次全表，补齐各月的课表/答卷快照（飞书里分别从 2026-05 课表、2026-06 答卷开始才有数据；
 *    更早的课表用老看板当时用的 data/local/shared/schedule.csv）。
 * 3. 历史月度分数：outputs/teacher-feedback/cumulative/monthly_score_contributions.csv 里
 *    LIVE_SCORES_FROM 之前的月份原样写进 feedback_score_history（老师名换成课表写法）。
 * 4. 历史月份的结果：分数用第 3 步的定稿，学生/家长分项和逐条明细按原始反馈补算——
 *    2026-05 起用飞书答卷快照，更早的用老看板留下的 outputs/teacher-feedback/<月>/respondent_detail.csv。
 * 5. LIVE_SCORES_FROM 起的月份：走和云函数完全相同的 recomputeMonth，只是计算在本机跑。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createServiceDb } from "../functions/feedback-api/service-db";
import { canonicalizeName, courseMonthToCollectionMonth, shiftMonth } from "../src/domain";
import { buildFeedbackCsvWithCount, buildScheduleCsvWithCount } from "../src/server/export/csv";
import { FeishuClient } from "../src/server/feishu/client";
import { loadFeishuConfig } from "../src/server/feishu/config";
import { parseStudentRecord } from "../src/server/feishu/parsers";
import { LIVE_SCORES_FROM, recomputeMonth } from "../src/server/scores/recompute";
import type { PriorDetailRow, ScoreResponse, ScoreStore, StoredResult } from "../src/server/scores/recompute";
import { ALIASES_TABLE, RdbFeedbackTaskRepository, SCORE_HISTORY_TABLE, SCORE_RESULTS_TABLE, SNAPSHOTS_TABLE, TASKS_TABLE } from "../src/shared/rdb";

const APP = resolve(import.meta.dirname, "..");
const REPO = resolve(APP, "../..");
const HISTORY_FROM = "2026-02";

for (const line of readFileSync(resolve(APP, "server.env"), "utf8").split("\n")) {
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
const currentMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
  .format(new Date())
  .slice(0, 7);

/** 在本机跑 functions/feedback-score/index.py（和云函数同一份代码）。脚本会往 stdout 打日志，所以结果走临时文件。 */
function computeLocally(event: Record<string, unknown>): ScoreResponse {
  const dir = mkdtempSync(join(tmpdir(), "feedback-score-"));
  writeFileSync(join(dir, "in.json"), JSON.stringify(event));
  const run = spawnSync(
    "python3",
    ["-c", "import json,sys,index; json.dump(index.main(json.load(open(sys.argv[1]))), open(sys.argv[2], 'w'), ensure_ascii=False)", join(dir, "in.json"), join(dir, "out.json")],
    { cwd: resolve(APP, "functions/feedback-score"), env: { ...process.env, PYTHONPATH: resolve(APP, "../teacher-feedback/scripts") }, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`评分脚本失败：${run.stderr}`);
  return JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as ScoreResponse;
}

// ---- 1. 别名 ----
check(
  await db.from(ALIASES_TABLE).upsert(
    LEGACY_TEACHER_ALIASES.map((row) => ({ kind: "teacher", ...row, created_by: "legacy-name-mapping" })),
    { onConflict: "kind,alias" },
  ),
  "写入老师别名",
);

// ---- 2. 快照 ----
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
const scheduleCsv = new Map<string, string>();
const feedbackCsv = new Map<string, string>();
for (let courseMonth = HISTORY_FROM; courseMonth < currentMonth; courseMonth = shiftMonth(courseMonth, 1)) {
  const lessons = buildScheduleCsvWithCount({ records: schedule, courseMonth, studentNamesByRecordId: studentNames });
  const answers = buildFeedbackCsvWithCount({ records: responses, collectionMonth: courseMonthToCollectionMonth(courseMonth) });
  // 飞书课表里 2026-05 之前的课已经没有了；这些月份用老看板当时用的本地课表（只在本机补算时用，不存快照）
  if (lessons.rows > 0) {
    await repository.saveSnapshot("schedule", courseMonth, lessons.csv, lessons.rows);
    scheduleCsv.set(courseMonth, lessons.csv);
  }
  // 飞书答卷表从 2026-06 才有数据，更早的月份没有答卷快照（用老看板的逐条明细）
  if (answers.rows > 0) {
    await repository.saveSnapshot("feedback", courseMonthToCollectionMonth(courseMonth), answers.csv, answers.rows);
    feedbackCsv.set(courseMonth, answers.csv);
  }
  console.log(`快照 ${courseMonth} 课表 ${lessons.rows} 节 · ${courseMonthToCollectionMonth(courseMonth)} 答卷 ${answers.rows} 份`);
}

// ---- 3. 历史分数 ----
const taskTeachers = await db.from(TASKS_TABLE).select<{ teacher_canonical_name: string }>("teacher_canonical_name");
check(taskTeachers, "读取老师名");
const teacherNames = [...new Set((taskTeachers.data ?? []).map((row) => row.teacher_canonical_name))];
const scheduleTeachers = schedule.map((record) => record.fields["老师"]).filter((name): name is string => typeof name === "string");
const displayByKey = new Map<string, string>();
for (const name of [...scheduleTeachers, ...teacherNames]) displayByKey.set(teacherKey(name), canonicalizeName(name));
const aliasByKey = new Map(LEGACY_TEACHER_ALIASES.map((row) => [teacherKey(row.alias), row.canonical]));
const display = (name: string) => {
  const resolved = aliasByKey.get(teacherKey(name)) ?? name;
  return displayByKey.get(teacherKey(resolved)) ?? resolved;
};

const csv = readFileSync(resolve(REPO, "outputs/teacher-feedback/cumulative/monthly_score_contributions.csv"), "utf8").replace(/^﻿/, "");
const [header, ...lines] = csv.trim().split(/\r?\n/);
const columns = header.split(",");
const score = (value: string) => (value === "" ? null : Number(value));
const historyRows = lines
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
check(await db.from(SCORE_HISTORY_TABLE).upsert(historyRows, { onConflict: "course_month,teacher" }), "写入历史分数");
console.log(`历史分数 ${historyRows.length} 行`);

// ---- 4. 历史月份的结果 ----
const aliases = await repository.listAliases();
const saveResult = async (row: StoredResult) =>
  check(await db.from(SCORE_RESULTS_TABLE).upsert([row as unknown as Record<string, unknown>], { onConflict: "course_month" }), "保存评分结果");

for (const courseMonth of [...new Set(historyRows.map((row) => row.course_month))].sort()) {
  const legacyDetail = resolve(REPO, `outputs/teacher-feedback/${courseMonth}/respondent_detail.csv`);
  const feedback = feedbackCsv.get(courseMonth);
  const response = computeLocally({
    courseMonth,
    scheduleCsv: scheduleCsv.get(courseMonth) ?? readFileSync(resolve(REPO, "data/local/shared/schedule.csv"), "utf8"),
    ...(feedback ? { feedbackCsv: feedback } : existsSync(legacyDetail) ? { legacyDetailCsv: readFileSync(legacyDetail, "utf8") } : {}),
    dedupeKeep: "last",
    aliases,
    teacherNames,
    history: historyRows
      .filter((row) => row.course_month === courseMonth)
      .map((row) => ({
        teacher: row.teacher,
        hours: row.hours,
        responses: row.responses,
        matchedResponses: row.matched_responses,
        coverage: row.coverage,
        scores: { learning_effect: row.learning_effect, responsibility: row.responsibility, charisma: row.charisma },
      })),
  });
  if (!response.ok) throw new Error(`${courseMonth} 补算失败：${response.error}`);
  await saveResult({
    course_month: courseMonth,
    status: "final",
    source: "history",
    teachers: response.teachers ?? [],
    stats: { ...(response.stats ?? {}), breakdownFrom: feedback ? "feishu" : "legacy-detail" },
    detail: response.detail ?? [],
    error: null,
    inputs_hash: null,
    computed_at: new Date().toISOString(),
  });
  console.log(`结果 ${courseMonth}（定稿）${(response.teachers ?? []).length} 位老师 · 明细 ${(response.detail ?? []).length} 条 · 分项来自${feedback ? "飞书答卷" : "老看板逐条明细"}`);
}

// ---- 5. 实时月份 ----
const store: ScoreStore = {
  snapshot: async (kind, month) => {
    const result = await db.from(SNAPSHOTS_TABLE).select<{ csv: string }>("csv").eq("kind", kind).eq("month", month);
    return result.data?.[0]?.csv;
  },
  result: async (courseMonth) => {
    const result = await db.from(SCORE_RESULTS_TABLE).select<StoredResult>("status,source,inputs_hash").eq("course_month", courseMonth);
    return result.data?.[0];
  },
  saveResult,
  aliases: async () => aliases,
  teacherNames: async () => teacherNames,
  courseTypeOverrides: () => repository.listCourseTypeOverrides(),
  detail: async (courseMonth) => {
    const result = await db.from(SCORE_RESULTS_TABLE).select<{ detail: PriorDetailRow[] }>("detail").eq("course_month", courseMonth);
    return result.data?.[0]?.detail;
  },
  // 回填的都是提前评价上线前的月份，没有定稿课时
  frozenLessons: async () => [],
};
for (let courseMonth = LIVE_SCORES_FROM; courseMonth < currentMonth; courseMonth = shiftMonth(courseMonth, 1)) {
  const outcome = await recomputeMonth({ store, compute: async (request) => computeLocally({ ...request }), courseMonth, currentMonth, force: true });
  console.log(`结果 ${courseMonth}（实时）${outcome}`);
}
