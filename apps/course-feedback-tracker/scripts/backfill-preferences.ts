/**
 * 一次性：给导入的历史月份（2026-05 起有飞书答卷、LIVE_SCORES_FROM 之前）补算官网「课堂体验」偏好，
 * 只写 feedback_score_results.preferences 这一列，不动已定稿的分数。可重复执行。需要本机 python3。
 *
 *   npx tsx scripts/backfill-preferences.ts
 *
 * 先用飞书全表重建这几轮的答卷快照：2026-10 中旬三道偏好题改过名，旧快照里没有「上课风格 / 教学节奏 / 课堂互动」列。
 * 这几轮的快照只有历史月份在用，历史月份不会自动重算，所以重建不影响任何分数。
 * LIVE_SCORES_FROM 起的月份由 feedback-api 重算时一起算（SCORE_ENGINE_VERSION 5）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createServiceDb } from "../functions/feedback-api/service-db";
import { courseMonthToCollectionMonth, shiftMonth } from "../src/domain";
import { buildFeedbackCsvWithCount } from "../src/server/export/csv";
import { FeishuClient } from "../src/server/feishu/client";
import { loadFeishuConfig } from "../src/server/feishu/config";
import { LIVE_SCORES_FROM } from "../src/server/scores/recompute";
import { listResponseRecords } from "../src/server/sync/reconcile-responses";
import { RdbFeedbackTaskRepository, SCORE_RESULTS_TABLE, SNAPSHOTS_TABLE } from "../src/shared/rdb";
import { computeLocally } from "./compute-locally";

const FROM = "2026-05";

for (const line of readFileSync(resolve(import.meta.dirname, "../server.env"), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match) process.env[match[1]] = match[2];
}

const db = createServiceDb({ envId: process.env.CLOUDBASE_ENV_ID!, apiKey: process.env.CLOUDBASE_API_KEY! });
const repository = new RdbFeedbackTaskRepository(db);
const config = loadFeishuConfig();
const client = new FeishuClient({ appId: config.appId, appSecret: config.appSecret });
const records = await listResponseRecords(client, config);
const aliases = await repository.listAliases();

for (let courseMonth = FROM; courseMonth < LIVE_SCORES_FROM; courseMonth = shiftMonth(courseMonth, 1)) {
  const collectionMonth = courseMonthToCollectionMonth(courseMonth);
  const feedback = buildFeedbackCsvWithCount({ records, collectionMonth });
  await repository.saveSnapshot("feedback", collectionMonth, feedback.csv, feedback.rows);

  const schedule = await db.from(SNAPSHOTS_TABLE).select<{ csv: string }>("csv").eq("kind", "schedule").eq("month", courseMonth);
  const stored = await db.from(SCORE_RESULTS_TABLE).select<{ teachers: Array<{ teacher: string }> }>("teachers").eq("course_month", courseMonth);
  const scheduleCsv = schedule.data?.[0]?.csv;
  const teachers = stored.data?.[0]?.teachers;
  if (!scheduleCsv || !teachers) throw new Error(`${courseMonth} 缺课表快照或评分结果`);

  // 和导入历史月份时同一套入参（backfill-teacher-scores.ts 第 4 步）；老师显示名用这个月已存的写法，偏好才能和分数对上
  const response = computeLocally({ courseMonth, scheduleCsv, feedbackCsv: feedback.csv, dedupeKeep: "last", aliases, teacherNames: teachers.map((row) => row.teacher) });
  if (!response.ok) throw new Error(`${courseMonth} 补算失败：${response.error}`);
  const saved = await db.from(SCORE_RESULTS_TABLE).update({ preferences: response.preferences ?? {} }).eq("course_month", courseMonth);
  if (saved.error) throw new Error(`${courseMonth} 保存失败：${saved.error.message}`);
  console.log(`${courseMonth}：答卷 ${feedback.rows} 份，${Object.keys(response.preferences ?? {}).length} 位老师有课堂体验`);
}
