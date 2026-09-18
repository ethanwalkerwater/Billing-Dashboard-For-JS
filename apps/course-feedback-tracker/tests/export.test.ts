import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFeedbackCsv, buildScheduleCsv, formatShanghai } from "../src/server/export/csv";
import type { FeishuRecord } from "../src/server/feishu/types";

/**
 * 老师反馈系统（apps/teacher-feedback/scripts/monthly_teacher_feedback.py）用
 * `datetime.strptime` 解析裸的本地时间，再用 `%Y-%m` 比对月份。
 * 带时区后缀或 UTC 时间会让整月数据被判成"不在报表月份"，所以这里锁死格式。
 */
describe("teacher-feedback CSV compatibility", () => {
  it("writes Shanghai wall-clock time in a format the report parser accepts", () => {
    // 2026-09-01 00:30 +08:00 在 UTC 里还是 8 月 31 日，必须导出成 9 月。
    assert.equal(formatShanghai("2026-08-31T16:30:00.000Z"), "2026-09-01 00:30:00");
    assert.equal(formatShanghai(1_788_191_400), "2026-08-31 23:50:00");
    assert.equal(formatShanghai(""), "");
    assert.equal(formatShanghai("not-a-date"), "");
  });

  it("exports the schedule columns the report requires and resolves linked students", () => {
    const records: FeishuRecord[] = [
      {
        record_id: "lesson-1",
        fields: {
          上课时间: Date.parse("2026-08-12T02:00:00.000Z"),
          老师: "应雁心",
          学生: [{ id: "student-1" }],
          课程时长: 1.5,
          课程类型: "IG数学",
          授课类型: "1v1",
          临时取消: "",
        },
      },
      {
        record_id: "other-month",
        fields: { 上课时间: Date.parse("2026-07-12T02:00:00.000Z"), 老师: "应雁心", 学生: [{ id: "student-1" }] },
      },
    ];

    const csv = buildScheduleCsv({
      records,
      courseMonth: "2026-08",
      studentNamesByRecordId: new Map([["student-1", "姚凯榕"]]),
    });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");

    assert.equal(lines[0], "上课时间,老师,学生,课程时长,课程类型,授课类型,临时取消");
    assert.equal(lines[1], "2026-08-12 10:00:00,应雁心,姚凯榕,1.5,IG数学,1v1,");
    // 只导出课程月份内的记录。
    assert.equal(lines.length, 2);
  });

  it("exports feedback rows untouched so the report's dimension columns still match", () => {
    const records: FeishuRecord[] = [
      {
        record_id: "rec-1",
        fields: {
          提交时间: Date.parse("2026-09-03T02:00:00.000Z"),
          身份: "学生",
          老师姓名: "应雁心",
          学生姓名: "姚凯榕",
          "【学生】学习提升效果": "非常满意",
          任务ID: "ft_202608_aaa",
        },
      },
      { record_id: "rec-old", fields: { 提交时间: Date.parse("2026-08-03T02:00:00.000Z"), 身份: "家长" } },
    ];

    const csv = buildFeedbackCsv({ records, collectionMonth: "2026-09" });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");

    for (const column of ["提交时间", "身份", "老师姓名", "学生姓名", "【学生】学习提升效果"]) {
      assert.ok(lines[0].includes(column), `缺少列 ${column}`);
    }
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith("2026-09-03 10:00:00,"));
  });

  it("escapes separators so a course name with a comma cannot shift columns", () => {
    const csv = buildScheduleCsv({
      records: [
        {
          record_id: "lesson-1",
          fields: {
            上课时间: Date.parse("2026-08-12T02:00:00.000Z"),
            老师: "应雁心",
            学生: [{ id: "student-1" }],
            课程类型: 'Alevel数学 P3,S1 "强化"',
          },
        },
      ],
      courseMonth: "2026-08",
      studentNamesByRecordId: new Map([["student-1", "姚凯榕"]]),
    });
    assert.ok(csv.includes('"Alevel数学 P3,S1 ""强化"""'));
  });
});
