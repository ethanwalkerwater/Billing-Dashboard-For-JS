import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FeedbackTaskDraft } from "../src/domain";
import { buildTaskSyncPlan } from "../src/server/tasks";

const pepper = "this-test-pepper-is-longer-than-thirty-two-characters";

function draft(overrides: Partial<FeedbackTaskDraft> = {}): FeedbackTaskDraft {
  return {
    taskId: "ft_202608_demo",
    courseMonth: "2026-08",
    collectionMonth: "2026-09",
    studentRecordId: "student-1",
    studentName: "姚凯榕",
    teacherSourceName: "应雁心",
    teacherCanonicalName: "应雁心",
    courseNames: ["IG数学"],
    scheduleRecordIds: ["lesson-1"],
    ...overrides,
  };
}

describe("task sync reconciliation", () => {
  it("creates new tasks as unsent and is idempotent on the next sync", async () => {
    const first = await buildTaskSyncPlan({
      existing: [],
      drafts: [draft()],
      publicTokenPepper: pepper,
      now: "2026-09-17T00:00:00.000Z",
    });
    assert.equal(first.create.length, 1);
    assert.equal(first.create[0]?.status, "unsent");

    const second = await buildTaskSyncPlan({
      existing: first.create,
      drafts: [draft()],
      publicTokenPepper: pepper,
      now: "2026-09-17T01:00:00.000Z",
    });
    assert.equal(second.create.length, 0);
    assert.equal(second.update.length, 0);
    assert.equal(second.unchanged.length, 1);
  });

  it("updates changed course facts while preserving a manually managed status", async () => {
    const initial = await buildTaskSyncPlan({ existing: [], drafts: [draft()], publicTokenPepper: pepper });
    const sent = { ...initial.create[0]!, status: "sent" as const, sentAt: "2026-09-03T08:00:00.000Z" };
    const next = await buildTaskSyncPlan({
      existing: [sent],
      drafts: [draft({ courseNames: ["数学刷题班", "IG数学"], scheduleRecordIds: ["lesson-2", "lesson-1"] })],
      publicTokenPepper: pepper,
      now: "2026-09-17T01:00:00.000Z",
    });
    assert.equal(next.update.length, 1);
    assert.equal(next.update[0]?.status, "sent");
    assert.equal(next.update[0]?.sentAt, "2026-09-03T08:00:00.000Z");
    assert.deepEqual(new Set(next.update[0]?.courseNames), new Set(["IG数学", "数学刷题班"]));
  });
});

