import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { buildParentReportData } from "../src/parent-report-data.mjs";
import { renderParentReportHtml } from "../src/generate-parent-report.mjs";

const privateFixture = "data/local/shared/schedule.csv";
const hasPrivateFixture = process.env.RUN_LEGACY_PARENT_FIXTURE_TESTS === "1"
  && fs.existsSync(privateFixture);
const csv = hasPrivateFixture ? fs.readFileSync(privateFixture, "utf8") : "";
const privateTest = hasPrivateFixture ? test : test.skip;

privateTest("renderParentReportHtml produces the mobile-portrait single-column layout", () => {
  const report = buildParentReportData(csv, {
    student: "Ivy-2488",
    month: "2026-03",
  });

  const html = renderParentReportHtml(report);

  // Cover identity
  assert.match(html, /<h1 class="cover-student-name">Ivy<\/h1>/);
  assert.doesNotMatch(html, /Ivy-2488/);
  assert.match(html, /<div class="cover-report-title">课时费明细<\/div>/);
  assert.match(html, /class="cover-brandline"/);
  assert.match(html, /class="cover-ref-divider"/);
  assert.match(html, /Tuition Detail/);
  assert.match(html, /March 2026/);
  assert.match(html, /¥37,160/);

  // Mobile-portrait container — 390px wide, paper background
  assert.match(html, /<main class="document">/);
  assert.match(html, /\.document\s*\{[\s\S]*?width:\s*390px;/);
  assert.match(html, /body\s*\{[\s\S]*?background:\s*var\(--paper\);/);

  // Pages stack as cards (with shadow/border), but flow continuously into one PDF page
  assert.match(html, /<section class="page cover">/);
  assert.match(html, /<section class="page closing">/);
  assert.match(html, /<section class="page">/);

  // Course cards (no table)
  assert.match(html, /<div class="course-list">/);
  assert.match(html, /<article class="course-card/);
  assert.match(html, /<article class="course-card leave/);
  assert.match(html, /class="course-name">/);
  assert.match(html, /class="course-meta">/);
  assert.match(html, /class="course-payable">/);
  assert.match(html, /class="course-waived">/);
  assert.match(html, /请假扣费 70%/);
  assert.doesNotMatch(html, /<table>|<thead>|<tbody>/);

  // Schedule list (no calendar grid, no day-num, no muted)
  assert.match(html, /class="schedule-list"/);
  assert.match(html, /class="schedule-day/);
  assert.match(html, /class="schedule-day-header"/);
  assert.match(html, /class="lesson-pill/);
  assert.match(html, /class="lesson-pill leave"/);
  assert.match(html, /class="lesson-time"/);
  assert.match(html, /class="lesson-info"/);
  assert.match(html, /请假 · 临时取消/);
  assert.doesNotMatch(html, /class="calendar-wrap"|class="calendar"|class="day-num"|class="day-lessons"/);

  // Brand & data tokens
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /--indigo/);
  assert.match(html, /-webkit-font-smoothing: antialiased/);

  // Faculty list (single column with round 52px avatar)
  assert.match(html, /class="faculty-list"/);
  assert.match(html, /class="faculty-card"/);
  assert.match(html, /<div class="faculty-photo">/);
  assert.match(html, /class="faculty-body"/);
  assert.match(html, /\.faculty-photo \{[\s\S]*?width:\s*52px;/);
  assert.match(html, /授课老师/);
  assert.match(html, /更多老师/);
  assert.match(html, /当月总授课|授课/);
  assert.match(html, /419\.5h/);
  assert.match(html, /课程特点：/);
  assert.match(html, /class="faculty-metric-label">授课<\/span>/);
  assert.match(html, /class="faculty-metric-label">课次<\/span>/);
  assert.match(html, /class="faculty-metric-value">331h<\/strong>/);
  assert.match(html, /-webkit-line-clamp: 2;/);
  assert.match(html, /<h3>应雁心<\/h3>/);
  assert.match(html, /<h3>李品轩<\/h3>/);
  assert.match(html, /<h3>包天翊<\/h3>/);
  assert.match(html, /<h3>张文豪<\/h3>/);
  assert.match(html, /<h3>Valentina Lin<\/h3>/);
  assert.match(html, /<h3>罗健文<\/h3>/);
  assert.doesNotMatch(html, /<h3>Lisa老师<\/h3>|<h3>傅老师<\/h3>|<h3>包老师<\/h3>|<h3>张老师<\/h3>|<h3>林老师<\/h3>|<h3>罗建文<\/h3>|<h3>高老师<\/h3>/);
  // No 3-col grid, no portrait-crop frame
  assert.doesNotMatch(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(html, /class="portrait-crop|class="faculty-grid|class="faculty-panel|class="background-list/);

  // Closing block — note new class names: closing-thanks, closing-footer-left/right
  assert.match(html, /class="closing-brandline"/);
  assert.match(html, /<h2>感谢信任<\/h2>/);
  assert.match(html, /class="closing-thanks">THANK YOU/);
  assert.match(html, /教育是一场长期主义的同行/);
  assert.match(html, /class="closing-footer-right">¥37,160/);
  assert.doesNotMatch(html, /class="envelope-card"|愿每一次扎实的积累，都成为 Ivy 走向更高目标的底气。/);
  assert.doesNotMatch(html, /Academic Excellence Record|cover-crest|cover-seal|Prepared for|Private Academic Service/);

  // Portraits still cropped to 512x420
  const portraitPath = "outputs/parent_reports/teacher_info/李品轩-portrait.png";
  assert.equal(fs.existsSync(portraitPath), true);
  const metadata = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", portraitPath], { encoding: "utf8" });
  assert.match(metadata, /pixelWidth: 512/);
  assert.match(metadata, /pixelHeight: 420/);
});
