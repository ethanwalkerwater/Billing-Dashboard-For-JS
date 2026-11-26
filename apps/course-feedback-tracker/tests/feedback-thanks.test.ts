import assert from "node:assert/strict";
import test from "node:test";
import { submitThanks } from "../src/server/feedback-thanks";
import type { createServiceDb } from "../functions/feedback-api/service-db";

const scope = { studentId: "signed-student", courseMonth: "2026-11" };
const gift = { taskId: "confirmed-task", giftId: "coffee", note: " 谢谢老师 ", expectedValue: 35, expectedLabel: "请老师喝一杯" };
type Rpc = Pick<ReturnType<typeof createServiceDb>, "rpc">;

test("thanks validates the request before writing and binds its identity to the signed scope", async () => {
  const calls: unknown[] = [];
  const db: Rpc = { rpc: async <T>(name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    return { data: [{ done: true } as T], error: null };
  } };
  for (const note of ["  ", "长".repeat(201), null]) {
    assert.equal((await submitThanks(db, scope, { ...gift, note })).status, 400);
  }
  assert.equal(calls.length, 0);
  const result = await submitThanks(db, scope, { ...gift, ...{ studentId: "untrusted", courseMonth: "2099-11" } });
  assert.deepEqual(calls, [["submit_feedback_thanks", { p_month: scope.courseMonth, p_student_id: scope.studentId,
    p_task_id: gift.taskId, p_gift_id: gift.giftId, p_note: "谢谢老师", p_expected_label: gift.expectedLabel, p_expected_value: 35 }]]);
  assert.deepEqual(result, { status: 200, body: { ok: true } });
});

test("changed gifts return updated choices; an ineligible student cannot query another task's catalog", async () => {
  for (const message of ["THANKS_GIFT_CHANGED", "THANKS_NOT_ELIGIBLE"]) {
    const calls: string[] = [];
    const db: Rpc = { rpc: async (name) => {
      calls.push(name);
      return name === "feedback_thanks_options" ? { data: [], error: null } : { data: null, error: { message } };
    } };
    assert.equal((await submitThanks(db, scope, gift)).status, 409);
    assert.deepEqual(calls, message === "THANKS_GIFT_CHANGED"
      ? ["submit_feedback_thanks", "feedback_thanks_options"] : ["submit_feedback_thanks"]);
  }
});
