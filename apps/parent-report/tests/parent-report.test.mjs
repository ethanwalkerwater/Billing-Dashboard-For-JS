import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildParentReportData } from "../src/parent-report-data.mjs";

const csv = fs.readFileSync("data/raw/schedule.csv", "utf8");

test("buildParentReportData summarizes Ivy March billing", () => {
  const report = buildParentReportData(csv, {
    student: "Ivy-2488",
    month: "2026-03",
  });

  assert.equal(report.studentId, "Ivy-2488");
  assert.equal(report.studentName, "Ivy");
  assert.equal(report.monthLabel, "2026年3月");
  assert.equal(report.totals.payableAmount, 37160);
  assert.equal(report.totals.grossAmount, 37550);
  assert.equal(report.totals.discountAmount, 390);
  assert.equal(report.totals.duration, 80);
  assert.equal(report.totals.lessonCount, 32);
  assert.equal(report.courseLines.length, 7);
});

test("buildParentReportData exposes the leave/cancellation lesson in the calendar", () => {
  const report = buildParentReportData(csv, {
    student: "Ivy-2488",
    month: "2026-03",
  });

  const cancelled = report.lessons.find((lesson) => lesson.rawRow === 5726);
  assert.ok(cancelled);
  assert.equal(cancelled.leaveLabel, "请假 · 临时取消");
  assert.equal(cancelled.payableAmount, 910);
  assert.equal(cancelled.discountAmount, 390);
  assert.equal(cancelled.cancellationChargeAmount, 910);
  assert.equal(cancelled.waivedAmount, 390);
  assert.equal(cancelled.billingNote, "请假扣费 70%");
  assert.equal(cancelled.date, "2026-03-22");
});

test("buildParentReportData labels leave billing without discount language", () => {
  const report = buildParentReportData(csv, {
    student: "Ivy-2488",
    month: "2026-03",
  });

  const leaveLine = report.courseLines.find((line) => line.status === "0h-70%");
  assert.ok(leaveLine);
  assert.equal(leaveLine.isLeave, true);
  assert.equal(leaveLine.cancellationChargeAmount, 910);
  assert.equal(leaveLine.waivedAmount, 390);
  assert.equal(leaveLine.billingNote, "请假扣费 70%");
});

test("buildParentReportData builds teacher team facts from raw lessons", () => {
  const report = buildParentReportData(csv, {
    student: "Ivy-2488",
    month: "2026-03",
  });

  assert.deepEqual(
    report.teachers.map((teacher) => teacher.name),
    ["应雁心", "李品轩", "高老师"],
  );
  assert.equal(report.teachers.find((teacher) => teacher.name === "李品轩").studentDuration, 36);
  assert.equal(report.teachers.find((teacher) => teacher.name === "李品轩").monthlyTotalDuration, 419.5);
  assert.equal(report.teachers.find((teacher) => teacher.name === "应雁心").image, "apps/parent-report/assets/teachers/应老师.png");
  assert.equal(report.teachers.find((teacher) => teacher.name === "李品轩").image, "apps/parent-report/assets/teachers/李老师.png");
  assert.equal(report.teachers.find((teacher) => teacher.name === "高老师").image, "");
  assert.ok(report.teachers.find((teacher) => teacher.name === "应雁心").background.length > 0);
  assert.equal(report.moreTeachers.some((teacher) => teacher.name === "Lisa老师"), true);
  assert.equal(report.moreTeachers.some((teacher) => teacher.name === "应老师"), false);
  assert.equal(report.moreTeachers.find((teacher) => teacher.name === "Lisa老师").monthlyTotalDuration, 3.5);
  assert.ok(report.moreTeachers.find((teacher) => teacher.name === "Lisa老师").background.length > 0);
  assert.equal(report.moreTeachers.every((teacher) => "monthlyScore" in teacher), true);
});
