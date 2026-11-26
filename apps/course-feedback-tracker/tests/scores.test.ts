import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIVE_SCORES_FROM, isFinalMonth, recomputeMonth } from "../src/server/scores/recompute";
import type { ScoreHistoryMonth, ScoreStore, StoredResult } from "../src/server/scores/recompute";

function memoryStore(snapshots: Record<string, string>) {
  const results = new Map<string, StoredResult>();
  const store: ScoreStore = {
    snapshot: async (kind, month) => snapshots[`${kind}:${month}`],
    result: async (month) => results.get(month),
    saveResult: async (row) => void results.set(row.course_month, row),
    aliases: async () => [],
    teacherNames: async () => ["应雁心"],
    courseTypeOverrides: async () => new Map(),
    history: async () => [],
    frozenLessons: async () => [],
    excludedStudents: async () => [],
  };
  return { store, results };
}

describe("stored teacher scores", () => {
  it("finalizes a course month once its collection month is over", () => {
    assert.equal(isFinalMonth("2026-09", "2026-10"), false);
    assert.equal(isFinalMonth("2026-09", "2026-11"), true);
  });

  it("only calls the score function when inputs change, and never touches history or final months", async () => {
    const snapshots = { "schedule:2026-09": "s1", "feedback:2026-10": "f1" };
    const { store, results } = memoryStore(snapshots);
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { ok: true, teachers: [{ teacher: "应雁心" }], stats: {}, detail: [] };
    };
    const run = (currentMonth = "2026-10") => recomputeMonth({ store, compute, courseMonth: "2026-09", currentMonth });

    assert.equal(await run(), "computed");
    assert.equal(results.get("2026-09")?.status, "draft");
    // 刷新后答卷没变：不再调用评分函数
    assert.equal(await run(), "unchanged");
    assert.equal(calls, 1);
    // 答卷变了：重算
    snapshots["feedback:2026-10"] = "f2";
    assert.equal(await run(), "computed");
    // 收集月份过完：再算一次并定稿，之后不再自动重算
    assert.equal(await run("2026-11"), "computed");
    assert.equal(results.get("2026-09")?.status, "final");
    snapshots["feedback:2026-10"] = "f3";
    assert.equal(await run("2026-11"), "final");
    assert.equal(calls, 3);

    assert.equal(await recomputeMonth({ store, compute, courseMonth: "2026-08", currentMonth: "2026-10" }), "history");
    assert.ok("2026-08" < LIVE_SCORES_FROM);
  });

  it("publishes a month early and keeps it final through forced recomputes", async () => {
    const { store, results } = memoryStore({ "schedule:2026-09": "s", "feedback:2026-10": "f" });
    const compute = async () => ({ ok: true, teachers: [{ teacher: "应雁心" }], stats: {}, detail: [] });
    const run = (options: { publish?: boolean; force?: boolean } = {}) =>
      recomputeMonth({ store, compute, courseMonth: "2026-09", currentMonth: "2026-10", ...options });

    assert.equal(await run(), "computed");
    assert.equal(results.get("2026-09")?.status, "draft");
    // 输入没变也要定稿
    assert.equal(await run({ publish: true }), "computed");
    assert.equal(results.get("2026-09")?.status, "final");
    assert.equal(await run(), "final");
    assert.equal(await run({ force: true }), "computed");
    assert.equal(results.get("2026-09")?.status, "final");
  });

  it("stores the reason when a month cannot be scored yet", async () => {
    const { store, results } = memoryStore({ "schedule:2026-09": "s", "feedback:2026-10": "f" });
    await recomputeMonth({ store, compute: async () => ({ ok: false, error: "反馈表在提交月份 2026-10 没有数据" }), courseMonth: "2026-09", currentMonth: "2026-10" });
    assert.match(results.get("2026-09")?.error ?? "", /没有数据/);
    assert.deepEqual(results.get("2026-09")?.teachers, []);
  });

  it("passes all raw historical scores, excludes this month and future, and hashes history changes", async () => {
    const { store, results } = memoryStore({ "schedule:2026-09": "s", "feedback:2026-10": "f" });
    const row = { student: "学生甲", teacher: "老师甲", matched: true, scores: { learning_effect_student: 4 } };
    const history: ScoreHistoryMonth[] = [
      { course_month: "2026-08", detail: [{ ...row, scores: { learning_effect_student: 5 } }] },
      { course_month: "2026-01", detail: [row] },
      { course_month: "2026-09", detail: [row] },
      { course_month: "2026-10", detail: [row] },
    ];
    store.history = async (beforeMonth) => {
      assert.equal(beforeMonth, "2026-09");
      return history;
    };
    let calls = 0;
    const run = () => recomputeMonth({ store, courseMonth: "2026-09", currentMonth: "2026-10", compute: async (request) => {
      calls++;
      assert.deepEqual(request.priorDetails.map((month) => month.course_month), ["2026-01", "2026-08"]);
      assert.equal(request.priorDetails[1].detail[0].scores.learning_effect_student, history[0].detail[0].scores.learning_effect_student);
      return { ok: true, detail: [row] };
    } });
    assert.equal(await run(), "computed");
    assert.equal(await run(), "unchanged");
    history[0].detail[0].scores.learning_effect_student = 4;
    assert.equal(await run(), "computed");
    assert.equal(calls, 2);
    assert.deepEqual(results.get("2026-09")?.detail, [row]);
  });
});
