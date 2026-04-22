import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateRecords,
  buildReportData,
  normalizeRow,
  parseCancellationRate,
  parseCsv,
} from "../assets/report-core.js";

function makeRow(overrides = {}) {
  return {
    "学员课程ID": "id-1",
    "课程类型": "Alevel数学",
    "老师": "张老师",
    "学生": "学生A-101",
    "上课时间": "2026/03/01 10:00",
    "下课时间": "2026/03/01 12:00",
    "课程单价": "1000",
    "课程时长": "2",
    "课程总价格": "2000",
    "临时取消": "",
    "授课类型": "1v1",
    "上课地点": "文定",
    "日程 ID": "event-1",
    ...overrides,
  };
}

test("parseCancellationRate supports configured labels", () => {
  assert.equal(parseCancellationRate("0h-70%"), 0.7);
  assert.equal(parseCancellationRate("2h-50%"), 0.5);
  assert.equal(parseCancellationRate("6h-30%"), 0.3);
  assert.equal(parseCancellationRate("请假"), null);
});

test("parseCsv handles quoted commas and utf-8 bom", () => {
  const rows = parseCsv('\ufeff学生,老师,课程类型\n"学生A,学生B",张老师,Alevel数学\n');
  assert.deepEqual(rows, [{ 学生: "学生A,学生B", 老师: "张老师", 课程类型: "Alevel数学" }]);
});

test("student view separates teaching type and cancellation status", () => {
  const records = [
    normalizeRow(makeRow(), 2),
    normalizeRow(
      makeRow({
        授课类型: "刷题班",
        课程单价: "350",
        课程时长: "1.5",
        课程总价格: "525",
        上课时间: "2026/03/02 10:00",
      }),
      3,
    ),
    normalizeRow(
      makeRow({
        临时取消: "0h-70%",
        课程总价格: "1400",
        上课时间: "2026/03/03 10:00",
      }),
      4,
    ),
  ];

  const result = aggregateRecords(records, "student", "2026-03", "学生A-101");

  assert.equal(result.totals.amount, 3925);
  assert.equal(result.totals.duration, 5.5);
  assert.equal(result.totals.cancelledAmount, 1400);
  assert.equal(result.groups.length, 3);
  assert.deepEqual(
    new Set(result.groups.map((group) => `${group.courseType}|${group.teachingType}|${group.cancellationStatus}`)),
    new Set(["Alevel数学|1v1|正常上课", "Alevel数学|刷题班|正常上课", "Alevel数学|1v1|0h-70%"]),
  );
});

test("buildReportData exposes month options and raw row lookup", () => {
  const records = [normalizeRow(makeRow(), 2), normalizeRow(makeRow({ 学生: "" }), 3)];
  const data = buildReportData(records, "unit.csv");

  assert.deepEqual(data.months, ["2026-03"]);
  assert.equal(data.views.student["2026-03"]["学生A-101"].totals.amount, 2000);
  assert.equal(data.recordsByRow["2"].teacher, "张老师");
  assert.equal(data.issueCounts.missing_student, 1);
});
