import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReportFromCsv } from "@jingshi/billing-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const f = (rel) => path.resolve(APP_ROOT, rel);

const requiredFiles = [
  "web/index.html",
  "web/assets/app.js",
  "web/assets/report-core.js",
  "web/assets/styles.css",
  "vercel.json",
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(f(file)), `${file} is missing`);
}

const html = fs.readFileSync(f("web/index.html"), "utf8");
assert.match(html, /assets\/app\.js/, "index.html must load app.js");
assert.match(html, /csvInput/, "index.html must include the CSV upload input");
assert.match(html, /id="monthSearch"/, "month selector must support search input");
assert.match(html, /id="entitySearch"/, "entity selector must support search input");
assert.match(html, /data-filter-list="months"/, "month selector must render a multi-select list");
assert.match(html, /data-filter-list="entities"/, "entity selector must render a multi-select list");
assert.match(html, /class="filter-grid"/, "filter controls must use an aligned grid");
assert.match(html, /class="workspace-layout"/, "report page must use a sidebar/content workspace layout");
assert.match(html, /class="sidebar-panel"/, "filters must live in a sidebar panel");
assert.match(html, /class="content-panel"/, "report output must live in a content panel");
assert.match(html, /id="monthChips"/, "selected months must be visible as removable chips");
assert.match(html, /id="entityChips"/, "selected entities must be visible as removable chips");
assert.match(html, /id="sidebarToggle"/, "sidebar must have a collapse toggle");
assert.match(html, /class="sidebar-body"/, "collapsible sidebar content must be grouped");
assert.match(html, /class="content-actionbar"/, "main report must have an action bar");

const app = fs.readFileSync(f("web/assets/app.js"), "utf8");
assert.match(app, /总时长（h）/, "summary table must put hour units in headers");
assert.match(app, /课程单价（¥）/, "summary table must put currency units in headers");
assert.match(app, /折扣（%）/, "summary table must include discount percent column");
assert.match(app, /折扣原因/, "summary table must include discount reason column");
assert.match(app, /总金额（¥）/, "summary table must put amount units in headers");
assert.match(app, /实际金额（¥）/, "summary table must include actual amount column");
assert.match(app, /type="number"/, "discount percent must be a number input");
assert.match(app, /data-discount-input/, "discount percent input must be editable in summary rows");
assert.match(app, /data-discount-reason/, "discount reason input must be editable in summary rows");
assert.match(app, /selectedMonths/, "app state must support selecting multiple months");
assert.match(app, /selectedEntities/, "app state must support selecting multiple entities");
assert.match(app, /result-section/, "summary table must separate combined results above each table");
assert.doesNotMatch(app, /data-section-row/, "section labels must not be mixed into table body rows");
assert.match(app, /subjectLabel.*名/, "CSV first column must be named by the current view subject");
assert.match(app, /renderSelectionChips/, "selected filters must render as chips");
assert.match(app, /data-chip-type/, "selected chips must be removable");
assert.match(app, /sidebarCollapsed/, "app state must track collapsed sidebar state");
assert.match(app, /sidebar-collapsed/, "app must toggle a collapsed sidebar class");

const css = fs.readFileSync(f("web/assets/styles.css"), "utf8");
assert.match(css, /\.filter-grid/, "filter controls must have grid layout styles");
assert.match(css, /\.workspace-layout/, "workspace layout must be styled");
assert.match(css, /\.sidebar-panel/, "sidebar panel must be styled");
assert.match(css, /\.content-panel/, "content panel must be styled");
assert.match(css, /\.selection-chip/, "selected filter chips must be styled");
assert.match(css, /\.workspace-layout\.sidebar-collapsed/, "collapsed sidebar layout must be styled");
assert.match(css, /\.reason-input[^{]*{[^}]*max-width:\s*120px/s, "discount reason input must stay compact");
assert.match(css, /\.result-section table[^{]*{[^}]*min-width:\s*1120px/s, "summary table must use a tighter minimum width");
assert.match(css, /\.picker-options[^{]*{[^}]*height:/s, "picker option lists must have a fixed height");
assert.match(css, /\.picker-options[^{]*{[^}]*overflow-y: auto/s, "picker option lists must scroll internally");

const sample = [
  "学生,老师,课程类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型",
  "学生A-101,张老师,Alevel数学,2026/03/01 10:00,2026/03/01 12:00,1000,2,2000,,1v1",
  "学生A-101,张老师,Alevel数学,2026/03/02 10:00,2026/03/02 12:00,1000,2,1400,0h-70%,1v1",
].join("\n");
const report = buildReportFromCsv(sample, "sample.csv");
assert.equal(report.views.student["2026-03"]["学生A-101"].totals.amount, 3400);
assert.equal(report.views.student["2026-03"]["学生A-101"].totals.cancelledAmount, 1400);

console.log("static app verification ok");
