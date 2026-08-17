import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTeacherScoreAverages } from "../scripts/build-teacher-score-averages.mjs";

test("teacher score averages extend the historical weighted baseline instead of replacing it", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teacher-score-averages-"));
  const summaryPath = path.join(tempDir, "teacher_summary.csv");

  try {
    fs.writeFileSync(summaryPath, [
      "teacher,metric_learning_effect_total_value_count,metric_learning_effect_total_raw_avg,metric_responsibility_total_value_count,metric_responsibility_total_raw_avg,metric_charisma_total_value_count,metric_charisma_total_raw_avg",
      "ValentinaLin,2,4.0,2,4.5,2,3.5",
    ].join("\n"));

    const baselineCsvText = [
      "老师,学习提升效果,责任心与服务态度,个人魅力,统计月份数,学习提升效果有效评分数,学习提升效果统计月份数,学习提升效果原始加权平均,责任心与服务态度有效评分数,责任心与服务态度统计月份数,责任心与服务态度原始加权平均,个人魅力有效评分数,个人魅力统计月份数,个人魅力原始加权平均",
      "Valentina林,4.8,5.0,4.9,5,10,5,4.8,10,5,5.0,10,5,4.9",
    ].join("\n");

    const result = buildTeacherScoreAverages([
      { month: "2026-07", summaryPath },
    ], { baselineCsvText });

    assert.equal(result.length, 1);
    assert.equal(result[0].teacher, "Valentina林");
    assert.equal(result[0].monthsWithAnyScore, 6);
    assert.deepEqual(result[0].metrics["学习提升效果"], {
      weightedAverage: 4.666667,
      displayScore: "4.7",
      valueCount: 12,
      monthsWithScore: 6,
      months: [{ month: "2026-07", valueCount: 2, average: 4 }],
    });
    assert.equal(result[0].metrics["责任心与服务态度"].weightedAverage, 4.916667);
    assert.equal(result[0].metrics["个人魅力"].weightedAverage, 4.666667);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
