import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIVE_SCORES_FROM, buildScoreRequest } from "../src/server/scores/build-request";

describe("teacher score request", () => {
  it("pairs course month M with feedback collected in M+1 and freezes months before the cutoff", () => {
    const request = buildScoreRequest({
      snapshots: [
        { kind: "schedule", month: "2026-08", csv: "s08" },
        { kind: "feedback", month: "2026-09", csv: "f09" },
        { kind: "schedule", month: LIVE_SCORES_FROM, csv: "s09" },
        { kind: "feedback", month: "2026-10", csv: "f10" },
        // 10 月课表有了，但 11 月还没收反馈：算不出来，不发给评分函数
        { kind: "schedule", month: "2026-10", csv: "s10" },
      ],
      history: [
        { course_month: "2026-08", teacher: "应雁心", hours: "148.5", responses: 3, matched_responses: 3, coverage: "0.5", learning_effect: "4.9", responsibility: null, charisma: "5" },
        // 截止月及之后的历史行不该再用（实时计算接管）
        { course_month: LIVE_SCORES_FROM, teacher: "应雁心", hours: 1, responses: 1, matched_responses: 1, coverage: 1, learning_effect: 1, responsibility: 1, charisma: 1 },
      ],
      aliases: [],
      excludedTeachers: [],
      teacherNames: [],
    });

    assert.deepEqual(
      request.months.map((month) => [month.courseMonth, month.scheduleCsv, month.feedbackCsv, month.dedupeKeep, month.countsTowardCumulative]),
      [
        ["2026-08", "s08", "f09", "last", false],
        ["2026-09", "s09", "f10", "first", true],
      ],
    );
    assert.deepEqual(request.history, [
      {
        month: "2026-08",
        rows: [
          {
            teacher: "应雁心",
            hours: 148.5,
            responses: 3,
            matchedResponses: 3,
            coverage: 0.5,
            scores: { learning_effect: 4.9, responsibility: null, charisma: 5 },
          },
        ],
      },
    ]);
  });
});
