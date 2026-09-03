import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReportFromCsv } from "../web/assets/report-core.js";
import {
  buildFeedbackRanking,
  buildPayrollReport,
  parseBaseSalaryCsv,
  parseTeacherScoresCsv,
} from "../web/assets/payroll-core.js";

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const lessonsCsv = fs.readFileSync(path.join(FIXTURE_DIR, "monthly-lessons.csv"), "utf8");
const scoresCsv = fs.readFileSync(path.join(FIXTURE_DIR, "monthly-scores.csv"), "utf8");
const baseSalaries = parseBaseSalaryCsv([
  "老师名,雇佣属性,基础薪水",
  "黄钢,全职,30000",
  "朱毅博,全职,20000",
].join("\n"));

test("monthly score upload drives the selected month's ranking and feedback rates", () => {
  const scores = parseTeacherScoresCsv(scoresCsv);
  const ranking = buildFeedbackRanking(baseSalaries, scores);
  const payroll = buildPayrollReport(buildReportFromCsv(lessonsCsv, "monthly-lessons.csv"), {
    baseSalaries,
    teacherScoresByMonth: { "2026-09": scores },
  });

  assert.deepEqual(ranking.teachers.map((row) => row.teacher), ["黄钢", "朱毅博"]);
  assert.deepEqual(ranking.teachers[0].qualifiedMetricKeys, ["learning", "charisma"]);
  assert.equal(payroll.byMonth["2026-09"]["黄钢"].feedbackRate, 0.57);
  assert.equal(payroll.byMonth["2026-09"]["朱毅博"].feedbackRate, 0.52);
  assert.ok(payroll.byMonth["2026-09"]["黄钢"].bonusSalary < 0);
  assert.equal(payroll.byMonth["2026-09"]["黄钢"].appliedBonusSalary, 0);
  assert.equal(payroll.byMonth["2026-09"]["黄钢"].personalTotalIncome, 30000);
});

test("a full-time teacher without a monthly score uses the base feedback rate", () => {
  const payroll = buildPayrollReport(buildReportFromCsv(lessonsCsv, "monthly-lessons.csv"), {
    baseSalaries,
    teacherScoresByMonth: {},
  });
  const row = payroll.byMonth["2026-09"]["黄钢"];

  assert.equal(row.feedbackRate, 0.47);
  assert.equal(row.qualifiedMetrics, 0);
  assert.equal(row.feedbackMissingScore, true);
  assert.match(row.issues.find((issue) => issue.code === "missing_feedback_score").label, /当月评分.*47%/);
});
