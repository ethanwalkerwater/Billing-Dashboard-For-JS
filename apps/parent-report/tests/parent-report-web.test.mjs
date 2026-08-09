import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  buildConfirmedReport,
  buildRequiredSelectChoices,
  collectInvalidReports,
  prepareReportForEditing,
  updateCourseLine,
  validateReport,
} from "../web/src/report-model.js";
import {
  buildRawScheduleLookup,
  buildStudentMonthReports,
  parseCompleteBillingCsv,
} from "../src/student-billing-batch-data.mjs";
import {
  assertPdfHasTextResources,
  cleanupStalePdfSessions,
  createPdfTemporarySession,
  ensureServerlessFontconfig,
  runPdfSession,
  serverlessChromiumArgs,
} from "../api/generate-student-billing-pdf.mjs";
import { renderStudentBillingReportHtml } from "../src/render-student-billing-report.mjs";

const scheduleCsv = `学生,课程类型,老师,上课时间,下课时间,课程单价,授课类型,课程时长,课程总价格,临时取消
Ivy-2488,Alevel数学,应雁心,2026/06/03 10:00,2026/06/03 12:00,1000,1v1,2,2000,
Ivy-2488,,,2026/06/17 00:00,2026/06/18 00:00,,,24,0,`;

const billingCsv = `学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
Ivy-2488,2026-06,应雁心,Alevel数学,1v1,正常上课,2,0,1000,100,,2000,2000,2`;

const cancelledBillingCsv = `学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
Ivy-2488,2026-06,应雁心,Alevel数学,1v1,0h-70%,2,2,1000,70,,2000,1400,2`;

function fixtureReport() {
  const rows = parseCompleteBillingCsv(billingCsv);
  const lookup = buildRawScheduleLookup(scheduleCsv);
  return prepareReportForEditing(buildStudentMonthReports(rows, lookup)[0]);
}

test("browser report model recalculates payable amount from edited summary values", () => {
  let report = fixtureReport();
  report = updateCourseLine(report, 0, "duration", "3");
  assert.equal(report.courseLines[0].grossAmount, 3000);
  assert.equal(report.courseLines[0].payableAmount, 3000);
  assert.equal(report.totals.duration, 3);
  assert.equal(report.totals.payableAmount, 3000);
  assert.deepEqual(report.courseLines[0]._changedFields, ["duration", "payableAmount"]);
});

test("manual payable override requires a reason before confirmation", () => {
  let report = fixtureReport();
  report = updateCourseLine(report, 0, "payableAmount", "1800");
  assert.match(validateReport(report)[0].message, /修改原因/);
  report = updateCourseLine(report, 0, "adjustmentReason", "家长确认优惠");
  assert.equal(validateReport(report).some((issue) => issue.level === "error"), false);

  const confirmed = buildConfirmedReport(report);
  assert.equal(confirmed.courseLines[0].payableAmount, 1800);
  assert.equal(confirmed.courseLines[0].discountReason, "家长确认优惠");
  assert.equal("_baseline" in confirmed.courseLines[0], false);
});

test("cancellation percentage follows billing-core cancellation semantics", () => {
  const rows = parseCompleteBillingCsv(cancelledBillingCsv);
  const lookup = buildRawScheduleLookup(scheduleCsv);
  let report = prepareReportForEditing(buildStudentMonthReports(rows, lookup)[0]);

  assert.equal(report.courseLines[0].cancellationPercent, 70);
  report = updateCourseLine(report, 0, "cancellationPercent", "50");
  assert.equal(report.courseLines[0].payableAmount, 1000);
  assert.equal(report.courseLines[0].billingNote, "请假 50%");
});

test("student-month schedule lookup excludes non-reportable blank placeholders", () => {
  const report = fixtureReport();
  assert.equal(report.lessons.length, 1);
  assert.equal(report.lessons[0].courseType, "Alevel数学");
  assert.equal(report.lessons.reduce((sum, lesson) => sum + lesson.duration, 0), 2);
});

test("batch validation identifies each invalid student, month, row, and reason", () => {
  const valid = fixtureReport();
  const missingTeacher = structuredClone(valid);
  missingTeacher.studentName = "李雨桐";
  missingTeacher.monthLabel = "2026年6月";
  missingTeacher.courseLines[0].teacher = "";

  let missingReason = structuredClone(valid);
  missingReason.studentName = "王小明";
  missingReason.monthLabel = "2026年7月";
  missingReason = updateCourseLine(missingReason, 0, "payableAmount", "1800");

  const invalid = collectInvalidReports([valid, missingTeacher, missingReason]);

  assert.deepEqual(
    invalid.map(({ index, studentName, monthLabel }) => ({ index, studentName, monthLabel })),
    [
      { index: 1, studentName: "李雨桐", monthLabel: "2026年6月" },
      { index: 2, studentName: "王小明", monthLabel: "2026年7月" },
    ],
  );
  assert.deepEqual(invalid[0].errors, [
    { level: "error", row: 1, message: "授课老师不能为空" },
  ]);
  assert.match(invalid[1].errors[0].message, /修改原因/);
});

test("blank required selects keep an explicit placeholder instead of displaying the first option", () => {
  assert.deepEqual(
    buildRequiredSelectChoices("", ["包天翊", "黄钢"], "请选择授课老师"),
    [
      { value: "", label: "请选择授课老师", selected: true, placeholder: true },
      { value: "包天翊", label: "包天翊", selected: false, placeholder: false },
      { value: "黄钢", label: "黄钢", selected: false, placeholder: false },
    ],
  );
});

test("a zero-priced complimentary lesson is valid", () => {
  let report = fixtureReport();
  report = updateCourseLine(report, 0, "unitPrice", "0");

  assert.equal(report.courseLines[0].unitPrice, 0);
  assert.equal(report.courseLines[0].payableAmount, 0);
  assert.equal(validateReport(report).some((issue) => issue.level === "error"), false);
});

test("PDF template prioritizes the bundled CJK font over platform-only fonts", () => {
  const html = renderStudentBillingReportHtml(fixtureReport(), []);
  assert.match(
    html,
    /--report-serif: "Noto Serif SC", "Noto Serif CJK SC", "Songti SC"/,
  );
  assert.match(html, /body\s*\{[\s\S]*?font-family: var\(--report-serif\)/);
});

test("PDF validation rejects pages without font resources", async () => {
  const valid = await PDFDocument.create();
  const validPage = valid.addPage();
  const font = await valid.embedFont(StandardFonts.Helvetica);
  validPage.drawText("Sample", { font });
  await assert.doesNotReject(assertPdfHasTextResources(await valid.save()));

  const blank = await PDFDocument.create();
  blank.addPage();
  await assert.rejects(
    assertPdfHasTextResources(await blank.save()),
    /PDF 字体加载失败/,
  );
});

test("serverless fontconfig is initialized even when the font directory already exists", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "parent-report-fontconfig-"));
  const previousPath = process.env.FONTCONFIG_PATH;
  const previousFile = process.env.FONTCONFIG_FILE;
  process.env.FONTCONFIG_PATH = directory;
  try {
    await ensureServerlessFontconfig();
    const configPath = path.join(directory, "fonts.conf");
    const config = await fs.readFile(configPath, "utf8");
    assert.equal(process.env.FONTCONFIG_FILE, configPath);
    assert.match(config, new RegExp(`<dir>${directory}</dir>`));
  } finally {
    if (previousPath === undefined) delete process.env.FONTCONFIG_PATH;
    else process.env.FONTCONFIG_PATH = previousPath;
    if (previousFile === undefined) delete process.env.FONTCONFIG_FILE;
    else process.env.FONTCONFIG_FILE = previousFile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("serverless Chromium cache is bounded inside the request-owned directory", () => {
  const args = serverlessChromiumArgs([
    "--no-sandbox",
    "--disk-cache-size=33554432",
    "--disk-cache-dir=/tmp/shared-cache",
  ], "/tmp/jingshi-parent-report/session-test/cache");

  assert.equal(args.includes("--disk-cache-size=33554432"), false);
  assert.equal(args.includes("--disk-cache-dir=/tmp/shared-cache"), false);
  assert.equal(args.includes("--disk-cache-size=1048576"), true);
  assert.equal(
    args.includes("--disk-cache-dir=/tmp/jingshi-parent-report/session-test/cache"),
    true,
  );
});

test("PDF session waits for rendering before closing browser resources", async () => {
  const events = [];
  const session = {
    async close() {
      events.push("close");
    },
  };

  const result = await runPdfSession(session, async () => {
    events.push("render-start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("render-finished");
    return "pdf";
  });

  assert.equal(result, "pdf");
  assert.deepEqual(events, ["render-start", "render-finished", "close"]);
});

test("temporary PDF cleanup removes only stale owned sessions", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "parent-report-session-root-"));
  const oldSession = path.join(root, "session-old");
  const activeSession = path.join(root, "session-active");
  const unrelated = path.join(root, "unrelated-data");
  await Promise.all([
    fs.mkdir(oldSession),
    fs.mkdir(activeSession),
    fs.mkdir(unrelated),
  ]);
  const now = Date.now();
  const oldDate = new Date(now - 20 * 60 * 1_000);
  await fs.utimes(oldSession, oldDate, oldDate);

  try {
    const removed = await cleanupStalePdfSessions({ root, now });
    assert.equal(removed, 1);
    await assert.rejects(fs.access(oldSession));
    await assert.doesNotReject(fs.access(activeSession));
    await assert.doesNotReject(fs.access(unrelated));

    const session = await createPdfTemporarySession({ root });
    assert.equal(session.directory.startsWith(`${root}/session-`), true);
    await assert.doesNotReject(fs.access(session.profileDirectory));
    await assert.doesNotReject(fs.access(session.artifactsDirectory));
    await assert.doesNotReject(fs.access(session.cacheDirectory));
    await session.cleanup();
    await assert.rejects(fs.access(session.directory));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
