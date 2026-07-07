import test from "node:test";
import assert from "node:assert/strict";

import { buildReportFromCsv } from "../src/report-core.js";
import {
  buildPayrollReport,
  parseBaseSalaryCsv,
  parseReimbursementsCsv,
  parseStudentOwnershipCsv,
  parseTaxSocialCsv,
  parseTeacherScoresCsv,
} from "../src/payroll-core.js";

const scheduleCsv = [
  "学生,老师,课程类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型",
  "学生A-101,张老师,Alevel数学,2026/05/01 10:00,2026/05/01 12:00,1000,2,2000,,1v1",
  "学生B-102,李老师,Alevel物理,2026/05/02 10:00,2026/05/02 12:00,1000,3,3000,,1v1",
  "学生C-103,王老师,Alevel英语,2026/05/03 10:00,2026/05/03 12:00,1000,4,4000,,1v1",
].join("\n");

test("parses payroll support tables", () => {
  const base = parseBaseSalaryCsv([
    "老师名,雇佣属性,基础薪水",
    "张老师,全职,1000",
  ].join("\n"));
  const ownership = parseStudentOwnershipCsv([
    "学生姓名,归属老师(20%),服务老师(7%)",
    "学生A,张老师,张老师",
  ].join("\n"));
  const taxSocial = parseTaxSocialCsv([
    "姓名,个税,个人五险,公司五险",
    "张老师,100,300,200",
  ].join("\n"));
  const scores = parseTeacherScoresCsv([
    "老师,学习提升效果,责任心与服务态度,个人魅力",
    "张老师,5,5,5",
  ].join("\n"));

  assert.deepEqual(base[0].teacher, "张老师");
  assert.equal(base[0].baseSalary, 1000);
  assert.equal(ownership[0].ownerTeacher, "张老师");
  assert.equal(taxSocial[0].personalSocialInsurance, 300);
  assert.equal(taxSocial[0].companySocialInsurance, 200);
  assert.equal(scores[0].metrics.learning, 5);
});

test("parses reimbursement export with non-standard header rows", () => {
  const csv = [
    ",,2026年,,,",
    ",老师,5月报销,课时,,",
    ",张老师,\"1,234\",,,",
    ",4月总报销,\"50,994\",,,",
  ].join("\n");

  const reimbursements = parseReimbursementsCsv(csv);

  assert.equal(reimbursements.length, 1);
  assert.equal(reimbursements[0].teacher, "张老师");
  assert.equal(reimbursements[0].reimbursement, 1234);
});

test("parses reimbursement detail rows and sums duplicate teachers", () => {
  const csv = [
    "老师名字,报销类型,报销日期,报销明细,报销截图,报销金额",
    "黄钢,报销,2026/07/06,BOSS直聘app招聘充值费用,IMG_9710.png,3062",
    "徐翰超,垫付,2026/07/06,这是我的手发发,Screenshot.jpg,4000",
    "徐翰超,垫付,2026/07/06,测试,Screenshot.jpg,10000",
  ].join("\n");

  const reimbursements = parseReimbursementsCsv(csv);

  assert.equal(reimbursements.length, 2);
  assert.equal(reimbursements.find((row) => row.teacher === "黄钢").reimbursement, 3062);
  assert.equal(reimbursements.find((row) => row.teacher === "徐翰超").reimbursement, 14000);
});

test("buildPayrollReport calculates full-time feedback rate and stacked commissions", () => {
  const report = buildReportFromCsv(scheduleCsv, "schedule.csv");
  const payroll = buildPayrollReport(report, {
    baseSalaries: parseBaseSalaryCsv([
      "老师名,雇佣属性,基础薪水",
      "张老师,全职,1000",
      "李老师,全职,1000",
      "王老师,全职,1000",
    ].join("\n")),
    studentOwnership: parseStudentOwnershipCsv([
      "学生姓名,归属老师(20%),服务老师(7%)",
      "学生A,张老师,张老师",
    ].join("\n")),
    reimbursements: parseReimbursementsCsv([
      "老师,报销",
      "张老师,100",
    ].join("\n")),
    taxSocial: parseTaxSocialCsv([
      "姓名,个税,公司总支出,个人支出",
      "张老师,100,300,200",
    ].join("\n")),
    teacherScores: parseTeacherScoresCsv([
      "老师,学习提升效果,责任心与服务态度,个人魅力",
      "张老师,5,5,5",
      "李老师,4,4,4",
      "王老师,3,3,3",
    ].join("\n")),
  });

  const row = payroll.byMonth["2026-05"]["张老师"];

  assert.equal(row.lessonFee, 2000);
  assert.equal(row.feedbackRate, 0.62);
  assert.equal(row.lessonBonus, 1240);
  assert.equal(row.ownerCommission, 400);
  assert.equal(row.serviceCommission, 140);
  assert.equal(row.bonusSalary, 580);
  assert.equal(row.personalTotalIncome, 1380);
  assert.equal(row.companyTotalCost, 1980);
});

test("missing feedback score is treated as part-time with configurable rate", () => {
  const report = buildReportFromCsv(scheduleCsv, "schedule.csv");
  const payroll = buildPayrollReport(report, {
    parameters: { partTimeLessonRate: 0.5 },
    baseSalaries: parseBaseSalaryCsv([
      "老师名,雇佣属性,基础薪水",
      "张老师,全职,1000",
    ].join("\n")),
    teacherScores: [],
  });

  const row = payroll.byMonth["2026-05"]["张老师"];

  assert.equal(row.feedbackType, "part_time");
  assert.equal(row.feedbackRate, 0.5);
  assert.equal(row.lessonBonus, 1000);
  assert.equal(row.issues.some((issue) => issue.code === "missing_feedback_score"), true);
});

test("commissions never become negative when student monthly fee is negative", () => {
  const report = buildReportFromCsv([
    "学生,老师,课程类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型",
    "退款学生,任课老师,课程,2026/05/01 10:00,2026/05/01 11:00,1000,1,-5000,,1v1",
  ].join("\n"));
  const payroll = buildPayrollReport(report, {
    baseSalaries: parseBaseSalaryCsv([
      "老师名,雇佣属性,基础薪水",
      "归属老师,全职,0",
      "服务老师,全职,0",
    ].join("\n")),
    studentOwnership: parseStudentOwnershipCsv([
      "学生姓名,归属老师(20%),服务老师(7%)",
      "退款学生,归属老师,服务老师",
    ].join("\n")),
  });

  assert.equal(payroll.byMonth["2026-05"]["归属老师"].ownerCommission, 0);
  assert.equal(payroll.byMonth["2026-05"]["服务老师"].serviceCommission, 0);
  assert.equal(payroll.byMonth["2026-05"]["归属老师"].commissionRows[0].studentFee, -5000);
  assert.equal(payroll.byMonth["2026-05"]["归属老师"].commissionRows[0].commissionBase, 0);
});

test("feedback ranking includes top half boundary and same-score ties", () => {
  const schedule = [
    "学生,老师,课程类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型",
    ...Array.from({ length: 10 }, (_, index) => `学生${index + 1},老师${index + 1},课程,2026/05/01 10:00,2026/05/01 11:00,1000,1,1000,,1v1`),
  ].join("\n");
  const baseRows = [
    "老师名,雇佣属性,基础薪水",
    ...Array.from({ length: 10 }, (_, index) => `老师${index + 1},全职,0`),
  ].join("\n");
  const scoreRows = [
    "老师,学习提升效果,责任心与服务态度,个人魅力",
    ...Array.from({ length: 10 }, (_, index) => {
      const score = index < 6 ? 5 : 4;
      return `老师${index + 1},${score},${score},${score}`;
    }),
  ].join("\n");
  const payroll = buildPayrollReport(buildReportFromCsv(schedule), {
    baseSalaries: parseBaseSalaryCsv(baseRows),
    teacherScores: parseTeacherScoresCsv(scoreRows),
  });

  assert.equal(payroll.byMonth["2026-05"]["老师1"].feedbackRate, 0.62);
  assert.equal(payroll.byMonth["2026-05"]["老师6"].feedbackRate, 0.62);
  assert.equal(payroll.byMonth["2026-05"]["老师7"].feedbackRate, 0.47);
});
