import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIVE_SCORES_FROM, isFinalMonth, recomputeMonth } from "../src/server/scores/recompute";
import type { ScoreStore, StoredResult } from "../src/server/scores/recompute";

function memoryStore(snapshots: Record<string, string>) {
  const results = new Map<string, StoredResult>();
  const store: ScoreStore = {
    snapshot: async (kind, month) => snapshots[`${kind}:${month}`],
    result: async (month) => results.get(month),
    saveResult: async (row) => void results.set(row.course_month, row),
    aliases: async () => [],
    teacherNames: async () => ["应雁心"],
    courseTypeOverrides: async () => new Map(),
    detail: async () => undefined,
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

  it("stores the reason when a month cannot be scored yet", async () => {
    const { store, results } = memoryStore({ "schedule:2026-09": "s", "feedback:2026-10": "f" });
    await recomputeMonth({ store, compute: async () => ({ ok: false, error: "反馈表在提交月份 2026-10 没有数据" }), courseMonth: "2026-09", currentMonth: "2026-10" });
    assert.match(results.get("2026-09")?.error ?? "", /没有数据/);
    assert.deepEqual(results.get("2026-09")?.teachers, []);
  });
});
