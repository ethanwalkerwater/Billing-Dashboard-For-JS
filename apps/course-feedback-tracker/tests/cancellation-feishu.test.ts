import assert from "node:assert/strict";
import test from "node:test";

import { createFeishuCancellationAdapters, parseLesson } from "../src/server/cancellation/feishu";
import { FeishuClient } from "../src/server/feishu/client";

const record = {
  record_id: "recLesson",
  fields: {
    学生: ["recStudent"],
    老师: " 黄钢 ",
    "老师-日历": [{ id: "ou_teacher", name: "日历姓名" }],
    上课时间: 1_800_000_000_000,
    下课时间: 1_800_003_600_000,
  },
};

test("cancellation uses the teacher select first, then the calendar person's name", () => {
  assert.equal(parseLesson(record)?.teacherName, "黄钢");
  assert.equal(parseLesson({ ...record, fields: { ...record.fields, 老师: "" } })?.teacherName, "日历姓名");
  assert.equal(parseLesson({ ...record, fields: { ...record.fields, 老师: "", "老师-日历": [] } })?.teacherName, "");
});

test("the cancellation adapter links to this lesson in the configured schedule", async () => {
  const client = new FeishuClient({
    appId: "test", appSecret: "test",
    fetchImpl: async (url) => Response.json(String(url).includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "test", expire: 7200 }
      : { code: 0, data: { record } }),
  });
  const adapter = createFeishuCancellationAdapters(client, {
    scheduleAppToken: "baseTest", scheduleTableId: "tblSchedule",
    scheduleBaseUrl: "https://example.feishu.cn/base/baseTest?table=tblSchedule&view=vewTeacher",
    requestAppToken: "baseTest", requestTableId: "tblRequests",
  });
  assert.equal((await adapter.schedule.get("recLesson"))?.scheduleUrl,
    "https://example.feishu.cn/base/baseTest?table=tblSchedule&view=vewTeacher&record=recLesson");
});
