import assert from "node:assert/strict";
import { test } from "node:test";

import { courseMonthToCollectionMonth, monthOfShanghai } from "../src/domain/month";
import { PARENT_IDENTITY, STUDENT_IDENTITY } from "../src/domain/monthly-feedback";
import { ALL_MONTHLY_QUESTIONS, IDENTITY_FIELD, IDENTITY_OPTIONS } from "../src/domain/monthly-questions";
import { answerFields, formDrift } from "../src/server/monthly-answer";
import { monthlyLinkToken } from "../src/server/monthly-feedback";
import type { FeishuField } from "../src/server/feishu/types";

const TYPE = { single: 3, multi: 4, text: 1 } as const;
// The live answer table as read on 2026-11-26, rebuilt from the definitions plus the fields we know but never write.
function liveFields(): FeishuField[] {
  const field = (field_name: string, type: number, options?: readonly string[]): FeishuField => ({
    field_id: "fld" + field_name, field_name, type, property: options ? { options: options.map((name) => ({ name })) } : undefined,
  });
  return [
    field("学生姓名", 3, ["小禾", "其他学生"]), field("老师姓名", 3, ["甲老师"]), field("反馈课程月份", 1),
    field(IDENTITY_FIELD, 3, IDENTITY_OPTIONS), field("自动编号", 1005), field("提交时间", 1001), field("机构优势其他", 1),
    ...ALL_MONTHLY_QUESTIONS.flatMap((question) => [field(question.field, TYPE[question.type], question.options),
      ...(question.otherField ? [field(question.otherField, 1)] : [])]),
  ];
}
const task = { student_name: "小禾", teacher_canonical_name: "甲老师", course_month: "2026-11" };
const studentAnswers = {
  "【学生】学习提升效果": "帮助较大，有一定提升", "【学生】责任心与服务态度": "是的，始终如此，非常满意", "【学生】个人魅力": "较好，能够调动我的学习兴趣",
  "【学生】改进方面": ["更得体的着装形象与职业气质", "其他"], "（选填）在日常学习过程中，您希望老师可以在哪些方面进一步提升？-其他-补充内容": " 多讲例题 ",
  上课风格: "严谨专注型 — 讲解严密深入，注重知识的系统性与准确性，课堂专注高效", "（选填）您如何评价这位老师的整体授课风格？-其他-补充内容": "没选其他不写",
  建议: "",
};

test("answers become one whitelisted Feishu row; unknown fields, options and missing required answers are refused", () => {
  const built = answerFields(task, STUDENT_IDENTITY, studentAnswers);
  assert.ok("fields" in built);
  assert.deepEqual(built.fields, {
    学生姓名: "小禾", 老师姓名: "甲老师", 反馈课程月份: "2026-11", 身份: STUDENT_IDENTITY,
    "【学生】学习提升效果": "帮助较大，有一定提升", "【学生】责任心与服务态度": "是的，始终如此，非常满意", "【学生】个人魅力": "较好，能够调动我的学习兴趣",
    "【学生】改进方面": ["更得体的着装形象与职业气质", "其他"], "（选填）在日常学习过程中，您希望老师可以在哪些方面进一步提升？-其他-补充内容": "多讲例题",
    上课风格: "严谨专注型 — 讲解严密深入，注重知识的系统性与准确性，课堂专注高效",
  });
  assert.ok("error" in answerFields(task, "老师", studentAnswers));
  assert.ok("error" in answerFields(task, STUDENT_IDENTITY, { ...studentAnswers, "【学生】个人魅力": undefined }));
  assert.ok("error" in answerFields(task, STUDENT_IDENTITY, { ...studentAnswers, "【学生】个人魅力": "随便写的" }));
  assert.ok("error" in answerFields(task, STUDENT_IDENTITY, { ...studentAnswers, 学生姓名: "别人" }));
  assert.ok("error" in answerFields(task, STUDENT_IDENTITY, { ...studentAnswers, "【学生】改进方面": ["其他", "其他"] }));
  assert.ok("error" in answerFields(task, STUDENT_IDENTITY, { ...studentAnswers, 建议: "长".repeat(501) }));
  // The parent branch cannot smuggle student-only fields.
  assert.ok("error" in answerFields(task, PARENT_IDENTITY, studentAnswers));
});

test("drift check stays quiet on the live table and names renamed options and added or removed fields", () => {
  assert.deepEqual(formDrift(liveFields()), []);
  const live = liveFields();
  const style = live.find((field) => field.field_name === "上课风格")!;
  style.property!.options![0].name = "风趣幽默型";
  live.push({ field_id: "fldNew", field_name: "新加的题", type: 3 });
  const drift = formDrift(live.filter((field) => field.field_name !== "建议"));
  assert.ok(drift.some((line) => line.includes("少了选项「风趣幽默型 — 课堂氛围轻松活跃，善于调动学习热情」")));
  assert.ok(drift.some((line) => line.includes("多了选项「风趣幽默型」")));
  assert.ok(drift.includes("飞书新增了字段「新加的题」"));
  assert.ok(drift.some((line) => line.includes("「建议」")));
});

test("native submit writes one Feishu row, binds it, offers thanks, and is idempotent on retry", async (t) => {
  const secret = "unit-test-secret";
  const settings = {
    PUBLIC_TOKEN_PEPPER: secret, CLOUDBASE_ENV_ID: "test-env", CLOUDBASE_API_KEY: "mock", FEISHU_APP_ID: "mock", FEISHU_APP_SECRET: "mock",
    FEISHU_SCHEDULE_APP_TOKEN: "mock", FEISHU_SCHEDULE_TABLE_ID: "mock", FEISHU_STUDENT_TABLE_ID: "mock", FEISHU_FEEDBACK_APP_TOKEN: "app",
    FEISHU_RESPONSE_TABLE_ID: "tbl", FEISHU_FORM_URL: "https://example.com", FORM_ALERT_OPEN_IDS: "ou_dev",
  };
  for (const [key, value] of Object.entries(settings)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  const current = monthOfShanghai(new Date().toISOString());
  const row = { ...task, task_id: "task-a", course_month: current, collection_month: courseMonthToCollectionMonth(current), course_names: ["英语"],
    student_response_id: null as string | null, parent_response_id: null as string | null, closed: false };
  const live = liveFields();
  live.push({ field_id: "fldNew", field_name: "新加的题", type: 1 });
  const created: Record<string, unknown>[] = [];
  const messages: string[] = [];
  const rpcs: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path.endsWith("/feedback_monthly_link_tasks")) return Response.json([row]);
    if (path.endsWith("/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "mock" });
    if (path.endsWith("/apps/app/tables/tbl/fields")) return Response.json({ code: 0, data: { items: live } });
    if (path.endsWith("/apps/app/tables/tbl/records") && init?.method === "POST") {
      created.push(JSON.parse(String(init.body)).fields);
      return Response.json({ code: 0, data: { record: { record_id: "recNative" + created.length, fields: {} } } });
    }
    if (path.endsWith("/im/v1/messages")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.receive_id, "ou_dev");
      messages.push(JSON.parse(body.content).text);
      return Response.json({ code: 0, data: {} });
    }
    const rpc = /\/rpc\/(\w+)$/.exec(path)?.[1];
    if (rpc) {
      rpcs.push(rpc);
      const args = JSON.parse(String(init?.body));
      if (rpc === "confirm_monthly_feedback") {
        assert.deepEqual([args.p_task_id, args.p_record_id, args.p_identity], ["task-a", "recNative1", "student"]);
        row.student_response_id = args.p_record_id;
        return Response.json([{ student_done: true, parent_done: false }]);
      }
      if (rpc === "feedback_thanks_options") return Response.json([{ id: "coffee", label: "请老师喝一杯", description: "", value: 35, photo: null, enabled: true }]);
      if (rpc === "submit_feedback_thanks") {
        assert.equal(row.student_response_id, "recNative1");
        return Response.json([{ done: true }]);
      }
    }
    throw new Error("Unexpected network request " + path);
  });

  const { main } = await import("../functions/feedback-api/index");
  const token = monthlyLinkToken(current, "recStudent", secret);
  const request = async (payload: object) => {
    const result = await main({ httpMethod: "POST", path: "/auth/monthly-feedback", body: JSON.stringify({ token, ...payload }) });
    assert.ok("statusCode" in result && "body" in result);
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  const submit = { action: "submit", taskId: "task-a", identity: STUDENT_IDENTITY, includeThanks: true };
  assert.equal((await request({ ...submit, answers: { ...studentAnswers, "【学生】个人魅力": "随便写的" } })).status, 400);
  assert.equal(created.length, 0);

  const done = await request({ ...submit, answers: studentAnswers });
  assert.equal(done.status, 200);
  assert.equal(done.body.teachers[0].studentDone, true);
  assert.equal(done.body.thanks.gifts[0].id, "coffee");
  assert.equal(created.length, 1);
  assert.equal(created[0]["身份"], STUDENT_IDENTITY);
  assert.equal(created[0]["老师姓名"], "甲老师");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /新增了字段「新加的题」/);

  // A retry after a lost response does not write a second row or send a second alert.
  assert.equal((await request({ ...submit, answers: studentAnswers })).status, 200);
  assert.equal(created.length, 1);
  assert.equal(messages.length, 1);

  const thanks = await request({ action: "thanks", taskId: "task-a", giftId: "coffee", note: "谢谢老师", expectedLabel: "请老师喝一杯", expectedValue: 35 });
  assert.deepEqual(thanks, { status: 200, body: { ok: true } });
  assert.deepEqual(rpcs, ["confirm_monthly_feedback", "feedback_thanks_options", "feedback_thanks_options", "submit_feedback_thanks"]);
});
