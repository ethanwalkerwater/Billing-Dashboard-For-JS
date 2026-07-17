import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanStudentName,
  parseRawRows,
  safeFileName,
  parseCompleteBillingCsv,
  buildRawScheduleLookup,
  buildStudentMonthReports,
} from "../src/student-billing-batch-data.mjs";

test("cleanStudentName removes trailing ids and dangling dashes", () => {
  assert.equal(cleanStudentName("Daniel 周恩东-3735"), "Daniel 周恩东");
  assert.equal(cleanStudentName("Mobby-3140"), "Mobby");
  assert.equal(cleanStudentName("Archer-"), "Archer");
  assert.equal(cleanStudentName("沈佑一"), "沈佑一");
});

test("safeFileName strips path-hostile characters", () => {
  assert.equal(safeFileName("Daniel/周恩东:2026"), "Daniel周恩东2026");
  assert.equal(safeFileName("  Ivy   Wang  "), "Ivy Wang");
});

test("parseRawRows reads whitespace-separated raw row numbers", () => {
  assert.deepEqual(parseRawRows("6031 6032 6444"), [6031, 6032, 6444]);
  assert.deepEqual(parseRawRows(""), []);
});

test("parseCompleteBillingCsv parses grouped billing rows", () => {
  const csv = `学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
"Daniel 周恩东-3735",2026-03,李品轩,Alevel物理,1v1,正常上课,2,0,"1,000",100,,2000,2000,"2 3"
"Archer-",2026-03,高老师,IG物理,1v1,正常上课,1,0,800,100,,800,800,"4"`;

  const rows = parseCompleteBillingCsv(csv, "fixture.csv");

  assert.equal(rows.length, 2);
  assert.equal(rows[0].studentName, "Daniel 周恩东-3735");
  assert.equal(rows[0].displayStudentName, "Daniel 周恩东");
  assert.equal(rows[0].month, "2026-03");
  assert.equal(rows[0].unitPrice, 1000);
  assert.equal(rows[0].grossAmount, 2000);
  assert.equal(rows[0].payableAmount, 2000);
  assert.deepEqual(rows[0].rawRows, [2, 3]);
  assert.equal(rows[1].displayStudentName, "Archer");
});

test("buildRawScheduleLookup normalizes raw schedule rows by CSV line number", () => {
  const scheduleCsv = `学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,上课地点,学员课程ID,老师课程ID,日程 ID
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/07 15:15,2026/03/07 17:15,1000,2,2000,,校区,S1,T1,D1
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/22 10:00,2026/03/22 12:00,650,2,910,0h-70%,校区,S2,T2,D2`;

  const lookup = buildRawScheduleLookup(scheduleCsv);

  assert.equal(lookup.get(2).courseType, "Alevel物理");
  assert.equal(lookup.get(2).date, "2026-03-07");
  assert.equal(lookup.get(3).isCancelled, true);
  assert.equal(lookup.get(3).cancellationStatus, "0h-70%");
});

test("buildStudentMonthReports joins grouped billing rows to raw schedule details", () => {
  const billingRows = parseCompleteBillingCsv(`学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
Ivy-2488,2026-03,李品轩,Alevel物理,1v1,正常上课,2,0,1000,100,,2000,2000,"2"
Ivy-2488,2026-03,李品轩,Alevel物理,1v1,0h-70%,2,2,650.8,70,临时请假,1301.6,910.8,"3"`);
  const scheduleLookup = buildRawScheduleLookup(`学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,上课地点,学员课程ID,老师课程ID,日程 ID
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/07 15:15,2026/03/07 17:15,1000,2,2000,,校区,S1,T1,D1
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/22 10:00,2026/03/22 12:00,650,2,910,0h-70%,校区,S2,T2,D2`);

  const reports = buildStudentMonthReports(billingRows, scheduleLookup);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].studentName, "Ivy");
  assert.equal(reports[0].studentId, "Ivy-2488");
  assert.equal(reports[0].month, "2026-03");
  assert.equal(reports[0].totals.grossAmount, 3301.6);
  assert.equal(reports[0].totals.payableAmount, 2910.8);
  assert.equal(reports[0].courseLines[1].unitPriceLabel, "650");
  assert.equal(reports[0].courseLines.length, 2);
  assert.equal(reports[0].lessons.length, 2);
  assert.equal(reports[0].lessons[1].isLeave, true);
  assert.deepEqual(reports[0].activeTeacherNames, ["李品轩"]);
});

test("buildStudentMonthReports matches calendar lessons by student and month instead of raw rows", () => {
  const billingRows = parseCompleteBillingCsv(`学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
Ivy-2488,2026-03,李品轩,Alevel物理,1v1,正常上课,2,0,1000,100,,2000,2000,"2"`);
  const scheduleLookup = buildRawScheduleLookup(`学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,上课地点,学员课程ID,老师课程ID,日程 ID
Other-0001,张文豪,Alevel数学,1v1,2026/03/01 10:00,2026/03/01 12:00,1000,2,2000,,校区,S0,T0,D0
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/07 15:15,2026/03/07 17:15,1000,2,2000,,校区,S1,T1,D1
Ivy-2488,李品轩,Alevel物理,1v1,2026/04/07 15:15,2026/04/07 17:15,1000,2,2000,,校区,S2,T2,D2`);

  const reports = buildStudentMonthReports(billingRows, scheduleLookup);

  assert.equal(reports[0].lessons.length, 1);
  assert.equal(reports[0].lessons[0].teacher, "李品轩");
  assert.equal(reports[0].lessons[0].date, "2026-03-07");
});
