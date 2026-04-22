import assert from "node:assert/strict";
import fs from "node:fs";
import { buildReportFromCsv } from "../assets/report-core.js";

const requiredFiles = [
  "index.html",
  "assets/app.js",
  "assets/report-core.js",
  "assets/styles.css",
  "vercel.json",
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(file), `${file} is missing`);
}

const html = fs.readFileSync("index.html", "utf8");
assert.match(html, /assets\/app\.js/, "index.html must load app.js");
assert.match(html, /csvInput/, "index.html must include the CSV upload input");

const sample = [
  "学生,老师,课程类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型",
  "学生A-101,张老师,Alevel数学,2026/03/01 10:00,2026/03/01 12:00,1000,2,2000,,1v1",
  "学生A-101,张老师,Alevel数学,2026/03/02 10:00,2026/03/02 12:00,1000,2,1400,0h-70%,1v1",
].join("\n");
const report = buildReportFromCsv(sample, "sample.csv");
assert.equal(report.views.student["2026-03"]["学生A-101"].totals.amount, 3400);
assert.equal(report.views.student["2026-03"]["学生A-101"].totals.cancelledAmount, 1400);

console.log("static app verification ok");
