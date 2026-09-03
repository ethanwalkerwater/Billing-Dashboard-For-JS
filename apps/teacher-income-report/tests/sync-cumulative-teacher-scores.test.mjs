import test from "node:test";
import assert from "node:assert/strict";

import { withCumulativeTeacherScores } from "../scripts/sync-cumulative-teacher-scores.mjs";

test("income defaults merge cumulative scores without erasing historical no-score rows", () => {
  const defaults = {
    baseSalaries: [{ teacher: "张老师" }],
    teacherScores: [
      { teacher: "旧数据", metrics: { learning: 1 } },
      { teacher: "马怡婷", metrics: { learning: 4.9, responsibility: 5, charisma: 4.9 } },
    ],
    nameAliases: {},
  };
  const updated = withCumulativeTeacherScores(defaults, [
    "排名,老师,学习提升效果,责任心与服务态度,个人魅力,总评分",
    "1,张老师,4.9,5,4.8,4.9",
    "2,李老师,4.8,4.9,4.7,4.8",
    ",马怡婷,无评分,无评分,无评分,无评分",
  ].join("\n"));

  assert.equal(updated.baseSalaries, defaults.baseSalaries);
  assert.deepEqual(updated.teacherScores.map((row) => row.teacher), ["旧数据", "马怡婷", "张老师", "李老师"]);
  assert.deepEqual(updated.teacherScores[2].metrics, {
    learning: 4.9,
    responsibility: 5,
    charisma: 4.8,
  });
  assert.deepEqual(updated.teacherScores[1].metrics, {
    learning: 4.9,
    responsibility: 5,
    charisma: 4.9,
  });
});
