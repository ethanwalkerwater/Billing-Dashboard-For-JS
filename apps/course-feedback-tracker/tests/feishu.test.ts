import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FeishuClient, FeishuConfigError, ensureSelectFieldOptions, loadFeishuConfig, parseFeedbackResponse, parseScheduleRecord, parseStudentRecord, planSelectOptionAppend } from "../src/server/feishu";
import type { FeishuField, FeishuRecord } from "../src/server/feishu";

describe("Feishu record parsers", () => {
  /**
   * 这是多维表格 v1 records 接口对 8594 条真实课表返回的实际形状：
   * 关联字段是 record_ids 数组，单选字段是裸字符串，时间是毫秒时间戳。
   * 之前这里用的是 lark-cli 归一化后的 [{ id }]，结果整月任务全部判成"缺少学生"。
   */
  it("normalizes schedule values from the verified Bitable field shapes", () => {
    const result = parseScheduleRecord({
      record_id: "rec_lesson_1",
      fields: {
        上课时间: 1_786_669_200_000,
        学生: [
          { record_ids: ["rec_student_1"], table_id: "tblQGkH5DweXpOW8", text: "陈语墨-", text_arr: ["陈语墨-"], type: "text" },
        ],
        老师: " 应雁心 ",
        课程类型: "IG数学",
        授课类型: "1v1",
      },
    });
    assert.deepEqual(result, {
      recordId: "rec_lesson_1",
      startsAt: "2026-08-14T01:00:00.000Z",
      studentRecordIds: ["rec_student_1"],
      teacherNames: ["应雁心"],
      courseNames: ["IG数学"],
      teachingTypes: ["1v1"],
      cancellationTags: [],
    });
  });

  it("reads linked record ids from every shape the API and CLI return", () => {
    const shapes: Array<[string, unknown]> = [
      ["record_ids", [{ record_ids: ["recA", "recB"], type: "text" }]],
      ["link_record_ids", { link_record_ids: ["recA", "recB"] }],
      ["id", [{ id: "recA" }, { id: "recB" }]],
      ["record_id", [{ record_id: "recA" }, { record_id: "recB" }]],
      ["plain strings", ["recA", "recB"]],
    ];
    for (const [label, 学生] of shapes) {
      const parsed = parseScheduleRecord({
        record_id: "rec_lesson_1",
        fields: { 上课时间: 1_786_669_200_000, 学生, 老师: "应雁心", 课程类型: "IG数学" },
      });
      assert.deepEqual(parsed.studentRecordIds, ["recA", "recB"], `关联字段形状 ${label} 未解析出学生`);
    }
    // 没有关联学生的记录（例如"文书"）必须是空数组，而不是把 text_arr 当成 ID。
    assert.deepEqual(
      parseScheduleRecord({
        record_id: "rec_lesson_2",
        fields: { 上课时间: 1_786_669_200_000, 学生: [{ table_id: "tbl", text_arr: [], type: "text" }], 老师: "应雁心", 课程类型: "文书" },
      }).studentRecordIds,
      [],
    );
  });

  it("accepts text arrays and preserves a missing task ID as an explicit exception candidate", () => {
    assert.deepEqual(
      parseStudentRecord({ record_id: "student-1", fields: { 学生姓名: [{ text: "姚凯榕" }] } }),
      { recordId: "student-1", name: "姚凯榕" },
    );
    const response = parseFeedbackResponse({
      record_id: "response-1",
      created_time: 1_788_713_600_000,
      fields: { 任务ID: null, 学生姓名: ["姚凯榕"], 老师姓名: ["应雁心"] },
    });
    assert.equal(response.taskId, null);
    assert.deepEqual(response.studentNames, ["姚凯榕"]);
  });
});

describe("Feishu configuration", () => {
  it("lists every missing server variable without leaking supplied values", () => {
    assert.throws(() => loadFeishuConfig({ FEISHU_APP_ID: "provided" }), (error) => {
      assert.ok(error instanceof FeishuConfigError);
      assert.match(error.message, /FEISHU_APP_SECRET/);
      assert.doesNotMatch(error.message, /provided/);
      return true;
    });
  });
});

describe("Feishu form options", () => {
  it("only appends missing normalized names and preserves every historical option", () => {
    const plan = planSelectOptionAppend({
      fields: [
        {
          field_id: "field-teacher",
          field_name: "老师姓名",
          type: 3,
          property: { options: [{ id: "old-1", name: "应雁心", color: 1 }] },
        },
      ],
      fieldName: "老师姓名",
      requiredNames: [" 应雁心 ", "Jack Hou", "Jack Hou"],
    });
    assert.deepEqual(plan.missingNames, ["Jack Hou"]);
    assert.deepEqual(plan.nextOptions.map((option) => option.name), ["应雁心", "Jack Hou"]);
    assert.equal(plan.nextOptions[0]?.id, "old-1");
  });

  it("re-reads the field after update so a silently rejected option cannot become sendable", async () => {
    let fields: FeishuField[] = [
      {
        field_id: "field-teacher",
        field_name: "老师姓名",
        type: 3,
        property: { options: [{ id: "old-1", name: "应雁心" }] },
      },
    ];
    let reads = 0;
    const result = await ensureSelectFieldOptions({
      client: {
        async listAllFields() {
          reads += 1;
          return fields;
        },
        async updateFieldOptions(input) {
          fields = [{ ...input.field, property: { ...input.field.property, options: input.options } }];
          return fields[0]!;
        },
      },
      appToken: "base",
      tableId: "responses",
      fieldName: "老师姓名",
      requiredNames: ["应雁心", "Jack Hou"],
    });
    assert.deepEqual(result.addedNames, ["Jack Hou"]);
    assert.equal(reads, 2);
  });
});

describe("Feishu pagination", () => {
  it("fetches all record pages and reuses the tenant token", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("tenant_access_token")) {
        return Response.json({ code: 0, msg: "ok", tenant_access_token: "test-token", expire: 7200 });
      }
      const secondPage = url.includes("page_token=next-page");
      const items: FeishuRecord[] = [
        { record_id: secondPage ? "record-2" : "record-1", fields: {} },
      ];
      return Response.json({
        code: 0,
        msg: "ok",
        data: { items, has_more: !secondPage, page_token: secondPage ? undefined : "next-page" },
      });
    };
    const client = new FeishuClient({ appId: "app-id", appSecret: "app-secret", fetchImpl, maxRetries: 0 });
    const records = await client.listAllRecords({ appToken: "base", tableId: "table" });
    assert.deepEqual(records.map((record) => record.record_id), ["record-1", "record-2"]);
    assert.equal(calls.filter((url) => url.includes("tenant_access_token")).length, 1);
  });
});
