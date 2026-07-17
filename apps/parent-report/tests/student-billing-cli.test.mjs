import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateStudentBillingReports } from "../src/generate-student-billing-reports.mjs";

test("generateStudentBillingReports writes one html per student-month", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jingshi-parent-report-"));
  const completeDir = path.join(tmp, "完整课时费");
  const outputDir = path.join(tmp, "out");
  fs.mkdirSync(completeDir, { recursive: true });

  const completePath = path.join(completeDir, "student-2026-03.csv");
  fs.writeFileSync(completePath, `学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
Ivy-2488,2026-03,李品轩,Alevel物理,1v1,正常上课,2,0,1000,100,,2000,2000,"2"`, "utf8");

  const schedulePath = path.join(tmp, "schedule.csv");
  fs.writeFileSync(schedulePath, `学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,上课地点,学员课程ID,老师课程ID,日程 ID
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/07 15:15,2026/03/07 17:15,1000,2,2000,,校区,S1,T1,D1`, "utf8");

  const teachersPath = path.join(tmp, "teachers.json");
  fs.writeFileSync(teachersPath, JSON.stringify({
    teachers: [
      { name: "李品轩", subject: "物理", photo: null, tag: "物理", desc: "简介", scores: {} },
      { name: "应雁心", subject: "数学", photo: null, tag: "数学", desc: "简介", scores: {} },
    ],
  }), "utf8");

  const result = generateStudentBillingReports({
    completeBillingDir: completeDir,
    schedulePath,
    teachersPath,
    outputDir,
    embedTeacherPhotos: false,
  });

  assert.equal(result.written.length, 1);
  assert.equal(path.basename(result.written[0]), "Ivy-2026-03.html");
  const html = fs.readFileSync(result.written[0], "utf8");
  assert.match(html, /Ivy/);
  assert.match(html, /¥2,000/);
  assert.match(html, /更多老师/);
});

test("default fixture directory can generate current sample reports", (t) => {
  if (!fs.existsSync("data/local/parent-report/complete-billing") || !fs.existsSync("data/local/shared/schedule.csv")) {
    t.skip("local student billing fixtures are not committed");
    return;
  }

  const result = generateStudentBillingReports({
    completeBillingDir: "data/local/parent-report/complete-billing",
    schedulePath: "data/local/shared/schedule.csv",
    teachersPath: "apps/parent-report/data/teachers.json",
    outputDir: path.join(os.tmpdir(), `jingshi-parent-report-real-${Date.now()}`),
    embedTeacherPhotos: false,
  });

  assert.ok(result.written.length >= 1);
  assert.ok(result.written.every((file) => fs.existsSync(file)));
});
