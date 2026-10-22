import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTeacherStats } from "../src/server/site/teacher-stats";
import type { ScoreResultRow } from "../src/server/site/teacher-stats";

const teacher = (name: string, hours: number, value: number) => ({
  teacher: name,
  rank: 1,
  overall: value,
  hours,
  responses: 1,
  matchedResponses: 1,
  coverage: 1,
  scores: { learning_effect: value, responsibility: value, charisma: value },
});

const rows: ScoreResultRow[] = [
  {
    course_month: "2026-08",
    status: "final",
    source: "history",
    teachers: [teacher("黄钢", 30, 5)],
    preferences: { 黄钢: { classStyle: { weighted: 3, hours: 30, responses: 4 } } },
  },
  {
    course_month: "2026-09",
    status: "final",
    source: "history",
    teachers: [teacher("黄钢", 10, 4)],
    preferences: {
      黄钢: { classStyle: { weighted: 7, hours: 10, responses: 2 } },
      只有偏好: { teachingPace: { weighted: 1, hours: 2, responses: 1 } },
    },
  },
  // 收集中的月份不算
  { course_month: "2026-10", status: "draft", source: "live", teachers: [teacher("黄钢", 100, 1)], preferences: {} },
];

describe("site teacher stats", () => {
  it("weights final months by hours and sums preferences", () => {
    const stats = buildTeacherStats(rows);
    assert.deepEqual(stats.months, ["2026-08", "2026-09"]);
    const huang = stats.teachers.find((row) => row.name === "黄钢")!;
    // (5×30 + 4×10) ÷ 40
    assert.equal(huang.scores.learning_effect, 4.75);
    assert.equal(huang.overall, 4.75);
    assert.equal(huang.hours, 40);
    // (3 + 7) ÷ (30 + 10) = 25%
    assert.deepEqual(huang.preferences.classStyle, { position: 25, responseCount: 6 });
    assert.equal(huang.preferences.teachingPace, null);
    const onlyPrefs = stats.teachers.find((row) => row.name === "只有偏好")!;
    assert.equal(onlyPrefs.overall, null);
    assert.deepEqual(onlyPrefs.preferences.teachingPace, { position: 50, responseCount: 1 });
  });
});
