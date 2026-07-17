import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildParentReportData } from "../src/parent-report-data.mjs";
import { renderCodexParentReportHtml } from "../src/generate-codex-parent-report.mjs";

const privateFixture = "data/raw/schedule.csv";
const hasPrivateFixture = fs.existsSync(privateFixture);
const csv = hasPrivateFixture ? fs.readFileSync(privateFixture, "utf8") : "";
const privateTest = hasPrivateFixture ? test : test.skip;

privateTest("renderCodexParentReportHtml produces a mobile-first parent report", () => {
  const report = buildParentReportData(csv, {
    student: "Ivy-2488",
    month: "2026-03",
  });

  const html = renderCodexParentReportHtml(report);

  assert.match(html, /class="mobile-shell"/);
  assert.match(html, /width: min\(440px, 100%\)/);
  assert.match(html, /class="summary-strip"/);
  assert.match(html, /class="lesson-group"/);
  assert.match(html, /class="teacher-stream"/);
  assert.match(html, /class="closing-phrase">教育是一场长期主义的同行/);
  assert.match(html, /class="cover-student-name">Ivy<\/h1>/);
  assert.match(html, /class="timeline-list"/);
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);

  assert.doesNotMatch(html, /<table>|<thead>|<tbody>/);
  assert.doesNotMatch(html, /class="calendar"/);
  assert.doesNotMatch(html, /class="faculty-grid"|class="calendar-wrap"|class="legend"/);
});
