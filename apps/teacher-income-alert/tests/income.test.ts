import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateSchedule, cleanStudentName, evaluateTeacher, parseScheduleRow } from "@/domain/income";

// 飞书 v1 records 接口的真实形状：单价是字符串，时长/总价是公式列返回的数字，学生是关联字段
const feishuFields = {
  上课时间: 1790769600000, // 2026-09-30 20:00 +08:00
  老师: "张劭景",
  学生: [{ record_ids: ["recv1bIzHDqhfp"], table_id: "tblQGkH5DweXpOW8", text: "张海錤 Linda-3777", text_arr: ["张海錤 Linda-3777"], type: "text" }],
  课程单价: "800",
  课程时长: 1,
  课程总价格: 800,
};

test("parseScheduleRow 读飞书真实字段形状", () => {
  assert.deepEqual(parseScheduleRow(feishuFields), {
    teacher: "张劭景",
    studentName: "张海錤 Linda",
    startsAt: 1790769600000,
    unitPrice: 800,
    hours: 1,
    amount: 800,
  });
  assert.equal(parseScheduleRow({ ...feishuFields, 老师: undefined }), null);
  // 日历占位（没单价）和时长为负的脏数据都不算课
  assert.equal(parseScheduleRow({ ...feishuFields, 课程单价: undefined, 课程时长: 23.5, 课程总价格: 0 }), null);
  assert.equal(parseScheduleRow({ ...feishuFields, 课程单价: "0", 课程总价格: 0 }), null);
  assert.equal(parseScheduleRow({ ...feishuFields, 课程时长: -143 }), null);
  assert.equal(cleanStudentName("Charlie-0601"), "Charlie");
  assert.equal(cleanStudentName("顾子言Tina-"), "顾子言Tina");
});

test("aggregateSchedule 只算当月、按老师汇总、取消课按总价格折后计入", () => {
  const rows = [
    parseScheduleRow(feishuFields),
    parseScheduleRow({ ...feishuFields, 课程总价格: 480, 课程时长: 2, 临时取消: "6h-30%", 学生: [{ text: "Charlie-0601" }, { text: "Nina-" }] }),
    parseScheduleRow({ ...feishuFields, 上课时间: 1793448000000 }), // 10 月，不算
    parseScheduleRow({ ...feishuFields, 老师: "汤朔", 课程单价: "900", 课程总价格: 900 }),
  ];
  const result = aggregateSchedule(rows, "2026-09");
  assert.deepEqual(
    result
      .map((item) => [item.teacher, item.lessonFee, item.lessons, item.hours, item.students, item.unitPriceAuto])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      // 均价 1280 ÷ 3h ≈ 427
      ["张劭景", 1280, 2, 3, ["Charlie", "Nina", "张海錤 Linda"].sort((a, b) => a.localeCompare(b, "zh-CN")), 427],
      ["汤朔", 900, 1, 1, ["张海錤 Linda"], 900],
    ],
  );
  // 9 月 1 日 00:00 上海时间算 9 月，前一毫秒算 8 月
  const boundary = Date.UTC(2026, 8, 1) - 8 * 3600_000;
  assert.equal(aggregateSchedule([{ ...parseScheduleRow(feishuFields)!, startsAt: boundary }], "2026-09").length, 1);
  assert.equal(aggregateSchedule([{ ...parseScheduleRow(feishuFields)!, startsAt: boundary - 1 }], "2026-09").length, 0);
});

test("evaluateTeacher 三种状态与差距、课时数", () => {
  const rates = { min: 0.47, max: 0.62 };
  const settings = { baseSalary: 20000, unitPrice: null, note: "" };
  // 课时费 20000：最高 12400 < 20000 → 预警
  const alert = evaluateTeacher({ lessonFee: 20000, unitPriceAuto: 800, settings, rates });
  assert.equal(alert.status, "alert");
  assert.equal(alert.predictedMin, 9400);
  assert.equal(alert.predictedMax, 12400);
  assert.equal(alert.marginToAlert, -7600);
  assert.equal(alert.marginToTarget, -10600);
  // 7600 ÷ (800 × 0.62) = 15.32 → 向上取到 15.4 小时
  assert.equal(alert.hoursToAlert, 15.4);
  assert.equal(alert.hoursToTarget, 28.2);
  // 课时费 36000：最低 16920 ≤ 20000 ≤ 最高 22320 → 区间内；已过预警线，课时数 0
  const between = evaluateTeacher({ lessonFee: 36000, unitPriceAuto: 800, settings, rates });
  assert.equal(between.status, "between");
  assert.equal(between.hoursToAlert, 0);
  assert.equal(between.marginToAlert, 2320);
  // 课时费 50000：最低 23500 > 20000 → 已达标
  assert.equal(evaluateTeacher({ lessonFee: 50000, unitPriceAuto: 800, settings, rates }).status, "reached");
  // 手填单价优先于课表推断的单价；没底薪时不判断
  assert.equal(evaluateTeacher({ lessonFee: 20000, unitPriceAuto: 800, settings: { ...settings, unitPrice: 1000 }, rates }).unitPrice, 1000);
  assert.equal(evaluateTeacher({ lessonFee: 20000, unitPriceAuto: null, settings: { ...settings, baseSalary: null }, rates }).status, "no-base");
  assert.equal(evaluateTeacher({ lessonFee: 20000, unitPriceAuto: null, settings, rates }).hoursToAlert, null);
});

test("Excel 导出列与页面口径一致，空值留空", async () => {
  const { buildExcelColumns } = await import("@/web/export-excel");
  const columns = buildExcelColumns({ min: 0.47, max: 0.62 });
  const line = {
    teacher: "汤朔",
    status: "reached" as const,
    lessonFee: 96100,
    lessons: 63,
    hours: 131.5,
    students: ["顾子言Tina", "潘奕恺"],
    unitPriceAuto: 731,
    settings: { baseSalary: 24000, unitPrice: null, note: "" },
    predictedMin: 45167,
    predictedMax: 59582,
    marginToAlert: 35582,
    marginToTarget: 21167,
    unitPrice: 731,
    hoursToAlert: 0,
    hoursToTarget: 0,
  };
  const headers = columns.map((column) => (column.header as { value: string }).value);
  assert.deepEqual(headers.slice(0, 4), ["老师", "状态", "基础薪水", "本月课时费"]);
  assert.equal(headers.at(-1), "学生");
  const cells = columns.map((column) => column.cell(line, 0));
  assert.deepEqual(cells[1], { value: "已达标", type: String });
  assert.deepEqual(cells[3], { value: 96100, type: Number, format: "#,##0" });
  assert.deepEqual(cells[8], { value: 35582, type: Number, format: "+#,##0;-#,##0;0" });
  assert.deepEqual(cells.at(-1), { value: "顾子言Tina、潘奕恺", type: String });
  // 没底薪的老师基础薪水一格留空，不写 0
  assert.equal(columns[2].cell({ ...line, settings: { ...line.settings, baseSalary: null } }, 0), null);
});
