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
assert.match(app, /data-entity-select-all/, "student selector must provide a select-all control");
assert.match(app, /visibleOptions\.every/, "select-all state must follow the current filtered results");
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
assert.match(css, /\.picker-select-all/, "student select-all control must be styled");
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

const discountSample = [
  "学生,老师,课程类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型,价格优惠",
  "演示甲-901,张老师,Alevel数学,2026/11/03 10:00,2026/11/03 12:00,800,2,1600,,1v1,",
  "演示甲-901,张老师,Alevel数学,2026/11/05 10:00,2026/11/05 12:00,800,2,0,,1v1,赠课-免费",
  "演示甲-901,张老师,Alevel数学,2026/11/06 10:00,2026/11/06 12:00,520,1,416,,1v1,试听-80%",
].join("\n");
const discountReport = buildReportFromCsv(discountSample, "discount.csv");
const discountResult = discountReport.views.student["2026-11"]["演示甲-901"];
assert.ok(discountResult, "T-A01: 演示甲-901 2026-11 必须有计费结果");
assert.equal(discountResult.groups.length, 3, "T-A01/T-A02/T-A05: 正常课、赠课、试听课必须各成一组");
const normalGroup = discountResult.groups.find((group) => group.statusLabel === "正常上课");
const giftGroup = discountResult.groups.find((group) => group.statusLabel === "赠课-免费");
const trialGroup = discountResult.groups.find((group) => group.statusLabel === "试听-80%");
assert.ok(normalGroup, "T-A01: 2026/11/03 正常 800×2 必须单独成组");
assert.equal(normalGroup.lessons, 1, "T-A01: 正常课组只含 1 节课");
assert.equal(normalGroup.amount, 1600, "T-A01: 正常课 800×2 总价应为 1600");
assert.ok(giftGroup, "T-A02: 2026/11/05 价格优惠=赠课-免费 必须单独成组");
assert.equal(giftGroup.statusLabel, "赠课-免费", "T-A02: 赠课组状态标签应为赠课-免费");
assert.equal(giftGroup.lessons, 1, "T-A02: 赠课组只含 1 节课");
assert.equal(giftGroup.amount, 0, "T-A02: 赠课总价应为 0");
assert.equal(giftGroup.issueCount, 0, "T-A02: 赠课不应产生数据提醒");
assert.ok(trialGroup, "T-A05: 2026/11/06 试听-80% 必须单独成组");
assert.equal(trialGroup.statusLabel, "试听-80%", "T-A05: 试听组状态标签应为试听-80%");
assert.equal(trialGroup.lessons, 1, "T-A05: 试听组只含 1 节课");
assert.equal(trialGroup.amount, 416, "T-A05: 试听 520×1×80% 总价应为 416");
assert.equal(discountReport.qualityIssues.length, 0, "T-A02/T-A05: 赠课与试听不应产生数据提醒");
assert.match(app, /"取消\/上课状态", "价格优惠"/, "T-A02: 导出 CSV 表头必须有相邻的取消/上课状态与价格优惠列");
assert.match(app, /badge promo/, "T-A02: 状态徽标必须支持 badge promo 优惠样式");
assert.match(css, /\.badge\.promo/, "T-A02: 优惠徽标必须使用 .badge.promo 蓝色样式");
assert.match(app, /未知\$\{unknown\}/, "第 1 轮可考虑 1: 组合行里有未知取消或未知优惠时徽标要写「未知」");

console.log("static app verification ok");
