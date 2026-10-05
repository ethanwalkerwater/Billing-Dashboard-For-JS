import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatScore } from "../src/web/report-types";
import type { MonthReport, TeacherScore } from "../src/web/report-types";
import { cumulative, rerankMonth } from "../src/web/scoring";

function teacher(name: string, hours: number, scores: [number | null, number | null, number | null]): TeacherScore {
  const [learning_effect, responsibility, charisma] = scores;
  return { teacher: name, rank: null, overall: null, hours, responses: 1, matchedResponses: 1, coverage: 1, scores: { learning_effect, responsibility, charisma } };
}

const MONTHS: MonthReport[] = [
  {
    month: "2026-07",
    source: "history",
    teachers: [
      teacher("甲", 10, [4.9995, 5, 5]),
      teacher("乙", 20, [4.8, 4.9, 4.7]),
      teacher("丙", 5, [5, 5, null]),
      teacher("丁", 8, [4.7, 4.8, 4.9]),
      teacher("戊", 3, [4.8, 4.8, 4.8]),
    ],
  },
  {
    month: "2026-08",
    source: "history",
    teachers: [teacher("甲", 30, [4.9, 4.95, 4.85]), teacher("乙", 10, [4.95, 4.95, 4.95]), teacher("丁", 8, [4.9, 4.8, 4.7])],
  },
];

describe("browser-side cumulative scores", () => {
  it("matches apps/teacher-feedback aggregate_monthly_summaries exactly", () => {
    // 期望值由 Python 的 aggregate_monthly_summaries 对同样输入跑出。
    // 丁、戊显示都是 4.800，但丁未截断的总分是 4.8000000000000007，所以名次不同。
    const expected = [
      ["1", "甲", "4.925", "4.963", "4.888", "4.925"],
      ["2", "乙", "4.850", "4.917", "4.783", "4.850"],
      ["3", "丁", "4.800", "4.800", "4.800", "4.800"],
      ["4", "戊", "4.800", "4.800", "4.800", "4.800"],
      ["", "丙", "5.000", "5.000", "无评分", "无评分"],
    ];
    const result = cumulative(MONTHS, new Set());
    assert.deepEqual(
      result.teachers.map((row) => [
        String(row.rank ?? ""),
        row.teacher,
        formatScore(row.scores.learning_effect),
        formatScore(row.scores.responsibility),
        formatScore(row.scores.charisma),
        formatScore(row.overall),
      ]),
      expected,
    );
    assert.deepEqual(result.months, ["2026-07", "2026-08"]);
  });

  it("rounds half up like Python Decimal, not like toFixed", () => {
    assert.equal(formatScore(4.9995), "5.000");
    assert.equal(formatScore(1.0005), "1.001");
    assert.equal((1.0005).toFixed(3), "1.000");
  });

  it("re-ranks the rest after excluding a teacher", () => {
    const month = cumulative(MONTHS, new Set(["甲"]));
    assert.deepEqual(month.teachers.map((row) => [row.teacher, row.rank]), [["乙", 1], ["丁", 2], ["戊", 3], ["丙", null]]);
    const ranked = rerankMonth(MONTHS[0].teachers, new Set(["乙"]));
    // 7 月单月：丁 4.7+4.8+4.9 与戊 4.8×3 十进制下完全相等，真正同分，并列第 2（同分按码点排，丁在前）
    assert.deepEqual(ranked.map((row) => [row.teacher, row.rank]), [["甲", 1], ["丁", 2], ["戊", 2], ["丙", null]]);
  });
});
