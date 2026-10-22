import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FeedbackTaskDraft } from "../src/domain";
import { ownerResolver } from "../src/domain";
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

  it("removes unanswered tasks that are no longer courses, keeps answered ones", async () => {
    const created = await buildTaskSyncPlan({ existing: [], drafts: [draft(), draft({ taskId: "ft_meeting" }), draft({ taskId: "ft_answered" })], publicTokenPepper: pepper });
    const existing = created.create.map((task) =>
      task.taskId === "ft_answered" ? { ...task, status: "completed" as const, parentResponseId: "rec-1" } : task,
    );
    // 课程类型改判后，这次只生成了第一个任务
    const plan = await buildTaskSyncPlan({ existing, drafts: [draft()], publicTokenPepper: pepper });
    assert.deepEqual(plan.remove.map((task) => task.taskId), ["ft_meeting"]);
    assert.deepEqual(plan.orphaned.map((task) => task.taskId), ["ft_answered"]);
    assert.equal(plan.unchanged.length, 1);
  });

  it("freezes an answered task's lessons: later schedule changes no longer touch it", async () => {
    const lesson = (id: string, hours: string) => ({ 上课时间: "2026-10-20 10:00:00", 老师: "应雁心", 学生: "姚凯榕", 课程时长: hours, 记录ID: id });
    const created = await buildTaskSyncPlan({ existing: [], drafts: [draft({ lessons: [lesson("lesson-1", "2")] })], publicTokenPepper: pepper });
    const answered = { ...created.create[0]!, status: "completed" as const, studentResponseId: "rec-1" };
    // 评价后课表又加了一节、原来那节改了时长
    const later = draft({ courseNames: ["IG数学", "IG物理"], scheduleRecordIds: ["lesson-1", "lesson-2"], lessons: [lesson("lesson-1", "1"), lesson("lesson-2", "2")] });
    const plan = await buildTaskSyncPlan({ existing: [answered], drafts: [later], publicTokenPepper: pepper });
    assert.equal(plan.unchanged.length, 1);
    assert.deepEqual(plan.unchanged[0]?.lessons, [lesson("lesson-1", "2")]);

    // 没人评的照常跟着课表走
    const open = await buildTaskSyncPlan({ existing: [created.create[0]!], drafts: [later], publicTokenPepper: pepper });
    assert.equal(open.update[0]?.lessons?.length, 2);
  });

  it("carries an owner forward month by month until someone changes it", () => {
    const set = (fromMonth: string, owner: string, studentRecordId = "student-1", teacherCanonicalName = "应雁心") => ({ studentRecordId, teacherCanonicalName, fromMonth, owner });
    const resolve = ownerResolver([set("2026-09", "华心晨"), set("2026-11", "Tinko"), set("2026-10", "傅威程", "student-2", "黄钢")]);
    const at = (courseMonth: string, studentRecordId = "student-1", teacherCanonicalName = "应雁心") => resolve({ studentRecordId, teacherCanonicalName, courseMonth })?.owner;
    // 9 月设的，10 月没设 → 沿用；11 月改了 → 11、12 月都是新的；设之前的月份不受影响
    assert.deepEqual([at("2026-08"), at("2026-09"), at("2026-10"), at("2026-11"), at("2026-12")], [undefined, "华心晨", "华心晨", "Tinko", "Tinko"]);
    assert.equal(resolve({ studentRecordId: "student-1", teacherCanonicalName: "应雁心", courseMonth: "2026-10" })?.fromMonth, "2026-09");
    // 换了老师的新组合，用同一学生最近的设定
    assert.equal(at("2026-12", "student-2", "新老师"), "傅威程");
    assert.equal(at("2026-12", "student-3"), undefined);
  });
});
