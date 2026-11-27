import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DEPARTED_TEACHER, buildReportFromCsv, isDepartedTeacher, normalizeRow, teacherNameHash } from "../src/report-core.js";
import { buildPayrollReport } from "../src/payroll-core.js";

// 仓库公开，测试里也不写原名
const departed = Buffer.from("5byg5paH6LGq", "base64").toString();

test("已离职老师在账单里显示成「已离职老师」，金额不变", () => {
  const row = normalizeRow({ 老师: `${departed}老师`, 学生: "学生A", 上课时间: "2026/08/01 10:00", 课程单价: "800", 课程时长: "2", 课程总价格: "1600" }, 2);
  assert.equal(row.teacher, DEPARTED_TEACHER);
  assert.equal(row.amount, 1600);
  assert.equal(isDepartedTeacher(" 张劭景 "), false);
  assert.equal(teacherNameHash("测试"), "f78149cf");
});

test("老师收入不出已离职老师的工资行，其他老师照常", () => {
  const csv = [
    "老师,学生,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,课程类型,授课类型",
    `${departed},学生A,2026/08/01 10:00,2026/08/01 12:00,800,2,1600,,数学,1v1`,
    "张劭景,学生B,2026/08/02 10:00,2026/08/02 12:00,800,1,800,,数学,1v1",
  ].join("\n");
  const payroll = buildPayrollReport(buildReportFromCsv(csv, "t.csv"), {
    baseSalaries: [{ teacher: departed, baseSalary: 20000, employmentType: "全职" }],
  });
  assert.deepEqual(Object.keys(payroll.byMonth["2026-08"]), ["张劭景"]);
});

test("在职老师没有撞上离职名单", () => {
  const teachers = JSON.parse(fs.readFileSync(new URL("../../../apps/parent-report/data/teachers.json", import.meta.url), "utf8"));
  const names = (teachers.teachers || teachers).map((entry) => entry.name);
  assert.ok(names.length > 10);
  assert.deepEqual(names.filter(isDepartedTeacher), []);
});
