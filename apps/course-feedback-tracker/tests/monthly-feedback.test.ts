import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { monthlyFeedbackTitle, monthlyTeacherDone, nextMonthlyTeacher, PARENT_IDENTITY, STUDENT_IDENTITY, uniqueStudentMonths } from "../src/domain/monthly-feedback";
import { monthlyFeedback, monthlyLinkScope, monthlyLinkToken } from "../src/server/monthly-feedback";
import type { MonthlyTaskRow } from "../src/server/monthly-feedback";
import { courseMonthToCollectionMonth, monthOfShanghai } from "../src/domain/month";

const secret = "unit-test-secret";
const task: MonthlyTaskRow = {
  task_id: "task-a", course_month: "2026-11", collection_month: "2026-12", student_name: "小禾",
  teacher_canonical_name: "甲老师", course_names: ["英语"], student_response_id: null, parent_response_id: null, closed: false,
};
const openDate = new Date("2026-12-15T00:00:00Z");

test("one signed capability per student and course month, independent of teacher changes", () => {
  const token = monthlyLinkToken("2026-11", "recStudent", secret);
  assert.equal(monthlyLinkToken("2026-11", "recStudent", secret), token);
  assert.notEqual(monthlyLinkToken("2026-12", "recStudent", secret), token);
  assert.deepEqual(monthlyLinkScope(token, secret), { courseMonth: "2026-11", studentId: "recStudent" });
  assert.equal(monthlyLinkScope(token.replace("recStudent", "recOther"), secret), null);
  assert.equal(monthlyLinkScope(token.replace("2611", "2612"), secret), null);
  assert.match(token, /^2611\.recStudent\.[A-Za-z0-9_-]{16}$/);
  // Links already sent in the long format keep working.
  const long = "2026-11.recStudent." + createHmac("sha256", secret).update("monthly-feedback:2026-11.recStudent").digest("base64url");
  assert.deepEqual(monthlyLinkScope(long, secret), { courseMonth: "2026-11", studentId: "recStudent" });
  assert.equal(monthlyLinkScope(long.slice(0, -1) + (long.endsWith("A") ? "B" : "A"), secret), null);
  assert.equal(monthlyLinkScope(token.slice(0, -1), secret), null);
  assert.equal(monthlyLinkScope(token, "another-secret"), null);
  assert.equal(uniqueStudentMonths([
    { courseMonth: "2026-11", studentRecordId: "a" }, { courseMonth: "2026-11", studentRecordId: "a" },
    { courseMonth: "2026-11", studentRecordId: "b" }, { courseMonth: "2026-12", studentRecordId: "a" },
  ]).length, 3);
  assert.equal(monthlyFeedbackTitle("2026-11", "小禾"), "11月 · 小禾 · 月度反馈");
});

test("server progress resumes the first remaining teacher and keeps identities separate", () => {
  const a = { ...task, student_response_id: "recAnswer" };
  const b = { ...task, task_id: "task-b", parent_response_id: "recParent" };
  const c = { ...task, task_id: "task-c" };
  const { teachers, closed } = monthlyFeedback([a, b, c], openDate);
  assert.equal(closed, false);
  assert.equal(nextMonthlyTeacher(teachers)?.id, "task-c");
  assert.equal(monthlyTeacherDone(teachers[1]), true);
  assert.equal(nextMonthlyTeacher(teachers, STUDENT_IDENTITY)?.id, "task-b");
  assert.equal(nextMonthlyTeacher(teachers, PARENT_IDENTITY)?.id, "task-a");
  assert.equal(nextMonthlyTeacher(teachers, STUDENT_IDENTITY, "task-b")?.id, "task-c");
  assert.equal(nextMonthlyTeacher(teachers, STUDENT_IDENTITY, "task-c")?.id, "task-b");
  assert.equal(monthlyFeedback([{ ...task, closed: true }], openDate).closed, true);
  assert.equal(monthlyFeedback([task], new Date("2026-12-31T16:00:00Z")).closed, true);
});

test("monthly HTTP entry reads one scoped roster and only confirms a real Feishu record", async (t) => {
  const settings = {
    PUBLIC_TOKEN_PEPPER: secret, CLOUDBASE_ENV_ID: "test-env", CLOUDBASE_API_KEY: "mock",
    FEISHU_APP_ID: "mock", FEISHU_APP_SECRET: "mock", FEISHU_SCHEDULE_APP_TOKEN: "mock",
    FEISHU_SCHEDULE_TABLE_ID: "mock", FEISHU_STUDENT_TABLE_ID: "mock", FEISHU_FEEDBACK_APP_TOKEN: "mock",
    FEISHU_RESPONSE_TABLE_ID: "mock", FEISHU_FORM_URL: "https://example.com",
  };
  for (const [key, value] of Object.entries(settings)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const current = monthOfShanghai(new Date().toISOString());
  const first = { ...task, course_month: current, collection_month: courseMonthToCollectionMonth(current) };
  const other = { ...first, task_id: "task-b", teacher_canonical_name: "乙老师" };
  const scopeToken = monthlyLinkToken(current, "recStudent", secret);
  const calls: string[] = [];
  let landed: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname;
    calls.push(path);
    if (path.endsWith("/feedback_monthly_link_tasks")) {
      assert.equal(url.searchParams.get("student_record_id"), "eq.recStudent");
      assert.equal(url.searchParams.get("course_month"), "eq." + current);
      return Response.json([first, other]);
    }
    if (path.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "mock" });
    if (path.endsWith("/records/search")) {
      const filters = JSON.parse(String(init?.body)).filter.conditions;
      assert.deepEqual(Object.fromEntries(filters.map((item: { field_name: string; value: string[] }) => [item.field_name, item.value[0]])), {
        学生姓名: first.student_name, 老师姓名: first.teacher_canonical_name, 反馈课程月份: current,
      });
      const fields = { 学生姓名: first.student_name, 老师姓名: first.teacher_canonical_name, 反馈课程月份: current };
      return Response.json({ code: 0, data: { items: [
        { record_id: "recUnrelated", fields: { ...fields, 老师姓名: "其他老师", 身份: PARENT_IDENTITY }, created_time: Date.now() },
        { record_id: "recUnknown", fields: { ...fields, 身份: "其他" }, created_time: Date.now() },
        ...landed.map((identity) => ({
          record_id: identity === STUDENT_IDENTITY ? "recStudentAnswer" : "recParentAnswer",
          fields: { ...fields, 身份: identity }, created_time: Date.now(),
        })),
      ] } });
    }
    if (path.endsWith("/rpc/confirm_monthly_feedback")) {
      const receipt = JSON.parse(String(init?.body));
      if (receipt.p_record_id === "recParentAnswer") {
        assert.equal(receipt.p_identity, "parent");
        first.parent_response_id = receipt.p_record_id;
      } else {
        assert.equal(receipt.p_record_id, "recStudentAnswer");
        assert.equal(receipt.p_identity, "student");
        first.student_response_id = receipt.p_record_id;
      }
      return Response.json([{ student_done: Boolean(first.student_response_id), parent_done: Boolean(first.parent_response_id) }]);
    }
    throw new Error("Unexpected network request " + path);
  });

  const { main } = await import("../functions/feedback-api/index");
  const request = async (payload: object) => {
    const result = await main({ httpMethod: "POST", path: "/auth/monthly-feedback", body: JSON.stringify({ token: scopeToken, ...payload }) });
    assert.ok("statusCode" in result && "body" in result);
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  assert.equal((await request({ token: "bad" })).status, 404);
  assert.equal(calls.length, 0);
  const firstLoad = await request({});
  assert.equal(firstLoad.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(firstLoad.body.teachers[0].formUrl, undefined);
  assert.equal((await request({ taskId: "other-student", action: "confirm" })).status, 409);
  assert.equal((await request({ taskId: first.task_id, identity: STUDENT_IDENTITY, answers: {} })).status, 409);
  const confirmation = { taskId: first.task_id, action: "confirm", studentDone: false, parentDone: false };
  assert.equal((await request(confirmation)).status, 409);
  const rpcCalls = () => calls.filter((path) => path.endsWith("/rpc/confirm_monthly_feedback")).length;
  assert.equal(rpcCalls(), 0);

  landed = [PARENT_IDENTITY];
  const completed = await request(confirmation);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.teachers.find((entry: { id: string }) => entry.id === first.task_id).parentDone, true);
  assert.equal(completed.body.teachers.find((entry: { id: string }) => entry.id === first.task_id).studentDone, false);
  assert.equal(nextMonthlyTeacher(completed.body.teachers, PARENT_IDENTITY)?.id, other.task_id);
  assert.equal((await request(confirmation)).status, 200);
  assert.equal(rpcCalls(), 1);

  const afterParent = { ...confirmation, parentDone: true };
  assert.equal((await request(afterParent)).status, 409);
  landed = [PARENT_IDENTITY, STUDENT_IDENTITY];
  assert.equal((await request(afterParent)).status, 200);
  assert.equal(first.student_response_id, "recStudentAnswer");
  assert.equal(calls.filter((path) => path.endsWith("/records")).length, 0);
  assert.equal(calls.filter((path) => path.endsWith("/records/search")).length, 4);
  assert.equal(rpcCalls(), 2);
});
