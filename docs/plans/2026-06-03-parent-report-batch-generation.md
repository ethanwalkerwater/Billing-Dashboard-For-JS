# Parent Report Batch Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an automated batch flow that reads complete student billing CSV files, joins them to `data/raw/schedule.csv`, and generates one parent-facing HTML tuition detail report per student-month using the approved visual template.

**Architecture:** Add a small parent-report pipeline under `apps/parent-report`: one data module parses grouped billing CSV rows and raw schedule rows, one renderer emits the approved `模板.html`-style document, and one CLI scans `data/完整课时费/*.csv` and writes generated HTML files. Keep teacher cards sourced from `apps/parent-report/assets/teacher/老师卡片.txt` via existing `apps/parent-report/data/teachers.json`, preserving both "授课老师" and "更多老师" sections.

**Tech Stack:** Node.js ES modules, existing `@jingshi/billing-core` CSV/date/number helpers, existing `apps/parent-report/src/render-faculty.mjs`, Node built-in test runner, no Playwright for this flow.

## Context And Constraints

- Approved visual reference: `outputs/parent_reports/模板.html`.
- Billing summary input directory: `data/完整课时费/`.
- Raw course detail input: `data/raw/schedule.csv`.
- Teacher card source: `apps/parent-report/assets/teacher/老师卡片.txt`.
- Generated teacher JSON: `apps/parent-report/data/teachers.json`.
- Default output directory: `outputs/parent_reports/generated/`.
- Do not overwrite `outputs/parent_reports/模板.html`.
- Do not add Playwright validation. The user will visually inspect pages manually.
- Preserve "更多老师"; page length is allowed to grow.
- If a current-month teacher is missing from `teachers.json`, keep that teacher visible in billing rows and schedule, but omit the teacher card.

## Naming And Data Rules

- Clean student display name with:

```js
export function cleanStudentName(value) {
  return cleanText(value)
    .replace(/-\d{4}$/u, "")
    .replace(/-$/u, "")
    .trim();
}
```

- File name format:

```js
`${safeFileName(cleanStudentName(studentName))}-${month}.html`
```

- `safeFileName` should remove path separators and filesystem-hostile punctuation:

```js
export function safeFileName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "未命名学生";
}
```

- `原始行` contains one or more whitespace-separated row numbers. Parse with:

```js
export function parseRawRows(value) {
  return cleanText(value).split(/\s+/).map((part) => Number(part)).filter(Number.isFinite);
}
```

## Task 1: Add Complete Billing CSV Parsing Tests

**Files:**
- Create: `apps/parent-report/tests/student-billing-batch-data.test.mjs`
- Create: `apps/parent-report/src/student-billing-batch-data.mjs`

**Step 1: Write the failing tests**

Create `apps/parent-report/tests/student-billing-batch-data.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanStudentName,
  parseRawRows,
  safeFileName,
  parseCompleteBillingCsv,
} from "../src/student-billing-batch-data.mjs";

test("cleanStudentName removes trailing ids and dangling dashes", () => {
  assert.equal(cleanStudentName("Daniel 周恩东-3735"), "Daniel 周恩东");
  assert.equal(cleanStudentName("Mobby-3140"), "Mobby");
  assert.equal(cleanStudentName("Archer-"), "Archer");
  assert.equal(cleanStudentName("沈佑一"), "沈佑一");
});

test("safeFileName strips path-hostile characters", () => {
  assert.equal(safeFileName("Daniel/周恩东:2026"), "Daniel周恩东2026");
  assert.equal(safeFileName("  Ivy   Wang  "), "Ivy Wang");
});

test("parseRawRows reads whitespace-separated raw row numbers", () => {
  assert.deepEqual(parseRawRows("6031 6032 6444"), [6031, 6032, 6444]);
  assert.deepEqual(parseRawRows(""), []);
});

test("parseCompleteBillingCsv parses grouped billing rows", () => {
  const csv = `学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
"Daniel 周恩东-3735",2026-03,李品轩,Alevel物理,1v1,正常上课,2,0,"1,000",100,,2000,2000,"2 3"
"Archer-",2026-03,高老师,IG物理,1v1,正常上课,1,0,800,100,,800,800,"4"`;

  const rows = parseCompleteBillingCsv(csv, "fixture.csv");

  assert.equal(rows.length, 2);
  assert.equal(rows[0].studentName, "Daniel 周恩东-3735");
  assert.equal(rows[0].displayStudentName, "Daniel 周恩东");
  assert.equal(rows[0].month, "2026-03");
  assert.equal(rows[0].unitPrice, 1000);
  assert.equal(rows[0].grossAmount, 2000);
  assert.equal(rows[0].payableAmount, 2000);
  assert.deepEqual(rows[0].rawRows, [2, 3]);
  assert.equal(rows[1].displayStudentName, "Archer");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-batch-data.test.mjs
```

Expected: FAIL because `apps/parent-report/src/student-billing-batch-data.mjs` does not exist or exports are missing.

**Step 3: Implement the parsing module**

Create `apps/parent-report/src/student-billing-batch-data.mjs`:

```js
import { cleanText, parseCsv, parseNumber } from "@jingshi/billing-core";

export function cleanStudentName(value) {
  return cleanText(value)
    .replace(/-\d{4}$/u, "")
    .replace(/-$/u, "")
    .trim();
}

export function safeFileName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "未命名学生";
}

export function parseRawRows(value) {
  return cleanText(value)
    .split(/\s+/)
    .map((part) => Number(part))
    .filter(Number.isFinite);
}

export function parseCompleteBillingCsv(csvText, sourceName = "") {
  return parseCsv(csvText).map((row, index) => {
    const studentName = cleanText(row["学生名"]);
    const month = cleanText(row["月份"]);
    const unitPrice = parseNumber(row["课程单价（¥）"]);
    const grossAmount = parseNumber(row["总金额（¥）"]);
    const payableAmount = parseNumber(row["实际金额（¥）"]);

    return {
      sourceName,
      sourceRow: index + 2,
      studentName,
      displayStudentName: cleanStudentName(studentName),
      month,
      teacher: cleanText(row["老师"]),
      courseType: cleanText(row["课程类型"]),
      teachingType: cleanText(row["授课类型"]),
      status: cleanText(row["取消/上课状态"]) || "正常上课",
      duration: parseNumber(row["总时长（h）"]) ?? 0,
      cancelledDuration: parseNumber(row["取消时长（h）"]) ?? 0,
      unitPrice,
      discountRate: parseNumber(row["折扣（%）"]),
      discountReason: cleanText(row["折扣原因"]),
      grossAmount: grossAmount ?? 0,
      payableAmount: payableAmount ?? 0,
      rawRows: parseRawRows(row["原始行"]),
    };
  });
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-batch-data.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
rtk git add apps/parent-report/src/student-billing-batch-data.mjs apps/parent-report/tests/student-billing-batch-data.test.mjs
rtk git commit -m "feat(parent-report): parse complete billing csv"
```

## Task 2: Build Raw Schedule Row Lookup And Student-Month Model

**Files:**
- Modify: `apps/parent-report/src/student-billing-batch-data.mjs`
- Modify: `apps/parent-report/tests/student-billing-batch-data.test.mjs`

**Step 1: Write the failing tests**

Append tests:

```js
import {
  buildRawScheduleLookup,
  buildStudentMonthReports,
} from "../src/student-billing-batch-data.mjs";

test("buildRawScheduleLookup normalizes raw schedule rows by CSV line number", () => {
  const scheduleCsv = `学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,上课地点,学员课程ID,老师课程ID,日程 ID
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/07 15:15,2026/03/07 17:15,1000,2,2000,,校区,S1,T1,D1
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/22 10:00,2026/03/22 12:00,650,2,910,0h-70%,校区,S2,T2,D2`;

  const lookup = buildRawScheduleLookup(scheduleCsv);

  assert.equal(lookup.get(2).courseType, "Alevel物理");
  assert.equal(lookup.get(2).date, "2026-03-07");
  assert.equal(lookup.get(3).isCancelled, true);
  assert.equal(lookup.get(3).cancellationStatus, "0h-70%");
});

test("buildStudentMonthReports joins grouped billing rows to raw schedule details", () => {
  const billingRows = parseCompleteBillingCsv(`学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行
Ivy-2488,2026-03,李品轩,Alevel物理,1v1,正常上课,2,0,1000,100,,2000,2000,"2"
Ivy-2488,2026-03,李品轩,Alevel物理,1v1,0h-70%,2,2,650,70,临时请假,1300,910,"3"`);
  const scheduleLookup = buildRawScheduleLookup(`学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,上课地点,学员课程ID,老师课程ID,日程 ID
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/07 15:15,2026/03/07 17:15,1000,2,2000,,校区,S1,T1,D1
Ivy-2488,李品轩,Alevel物理,1v1,2026/03/22 10:00,2026/03/22 12:00,650,2,910,0h-70%,校区,S2,T2,D2`);

  const reports = buildStudentMonthReports(billingRows, scheduleLookup);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].studentName, "Ivy");
  assert.equal(reports[0].studentId, "Ivy-2488");
  assert.equal(reports[0].month, "2026-03");
  assert.equal(reports[0].totals.grossAmount, 3300);
  assert.equal(reports[0].totals.payableAmount, 2910);
  assert.equal(reports[0].courseLines.length, 2);
  assert.equal(reports[0].lessons.length, 2);
  assert.equal(reports[0].lessons[1].isLeave, true);
  assert.deepEqual(reports[0].activeTeacherNames, ["李品轩"]);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-batch-data.test.mjs
```

Expected: FAIL because lookup/model functions are not exported.

**Step 3: Implement lookup and report model**

Add to `student-billing-batch-data.mjs`:

```js
import { normalizeRow } from "@jingshi/billing-core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function monthLabel(month) {
  const [year, value] = String(month).split("-");
  return `${year}年${Number(value)}月`;
}

function formatMonthEnglish(monthValue) {
  const match = String(monthValue || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(monthValue || "");
  const [, year, month] = match;
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${monthNames[Number(month) - 1] || month} ${year}`;
}

export function buildRawScheduleLookup(scheduleCsvText) {
  const rows = parseCsv(scheduleCsvText);
  return new Map(rows.map((row, index) => {
    const rawRow = index + 2;
    return [rawRow, normalizeRow(row, rawRow)];
  }));
}

function billingNote(row) {
  if (row.status === "正常上课") return "—";
  const match = row.status.match(/(\d+)%/);
  return match ? `请假 ${match[1]}%` : row.status;
}

function buildCourseLine(row) {
  return {
    teacher: row.teacher,
    courseType: row.courseType,
    teachingType: row.teachingType,
    status: row.status,
    isLeave: row.status !== "正常上课",
    duration: row.duration,
    cancelledDuration: row.cancelledDuration,
    unitPrice: row.unitPrice,
    unitPriceLabel: row.unitPrice == null ? "缺失" : row.unitPrice.toLocaleString("zh-CN", { maximumFractionDigits: 2 }),
    discountRate: row.discountRate,
    discountReason: row.discountReason,
    grossAmount: roundMoney(row.grossAmount),
    payableAmount: roundMoney(row.payableAmount),
    discountAmount: roundMoney(row.grossAmount - row.payableAmount),
    billingNote: billingNote(row),
    rawRows: row.rawRows,
  };
}

function lessonFromRecord(record) {
  const grossAmount = Number(record.unitPrice || 0) * Number(record.duration || 0);
  const payableAmount = Number(record.amount || 0);
  return {
    rawRow: record.rawRow,
    date: record.date,
    weekday: record.weekday,
    startTime: record.startTime,
    endTime: record.endTime,
    teacher: record.teacher,
    courseType: record.courseType,
    teachingType: record.teachingType,
    duration: record.duration,
    isLeave: record.isCancelled,
    leaveLabel: record.isCancelled ? "请假 · 临时取消" : "",
    grossAmount: roundMoney(grossAmount),
    payableAmount: roundMoney(payableAmount),
    location: record.location,
  };
}

function buildCalendar(month, lessons) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const cells = [];

  for (let i = 0; i < first.getDay(); i += 1) {
    cells.push({ inMonth: false, day: "", date: "", lessons: [] });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push({
      inMonth: true,
      day,
      date,
      lessons: lessons.filter((lesson) => lesson.date === date),
    });
  }

  while (cells.length % 7 !== 0) cells.push({ inMonth: false, day: "", date: "", lessons: [] });
  return { weekdays: WEEKDAYS, cells };
}

export function buildStudentMonthReports(billingRows, scheduleLookup) {
  const byStudentMonth = new Map();
  for (const row of billingRows) {
    const key = JSON.stringify([row.studentName, row.month]);
    if (!byStudentMonth.has(key)) byStudentMonth.set(key, []);
    byStudentMonth.get(key).push(row);
  }

  return [...byStudentMonth.entries()].map(([key, rows]) => {
    const [studentId, month] = JSON.parse(key);
    const courseLines = rows.map(buildCourseLine);
    const lessons = [...new Set(rows.flatMap((row) => row.rawRows))]
      .map((rawRow) => scheduleLookup.get(rawRow))
      .filter(Boolean)
      .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
      .map(lessonFromRecord);
    const activeTeacherNames = [...new Set(lessons.map((lesson) => lesson.teacher).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    return {
      brandName: "菁仕",
      brandEnglish: "JINGSHI EDUCATION",
      studentId,
      studentName: cleanStudentName(studentId),
      month,
      monthLabel: monthLabel(month),
      monthEnglish: formatMonthEnglish(month),
      generatedDate: new Date().toISOString().slice(0, 10),
      totals: {
        duration: roundMoney(rows.reduce((sum, row) => sum + row.duration, 0)),
        grossAmount: roundMoney(courseLines.reduce((sum, line) => sum + line.grossAmount, 0)),
        discountAmount: roundMoney(courseLines.reduce((sum, line) => sum + line.discountAmount, 0)),
        payableAmount: roundMoney(courseLines.reduce((sum, line) => sum + line.payableAmount, 0)),
        cancelledDuration: roundMoney(rows.reduce((sum, row) => sum + row.cancelledDuration, 0)),
      },
      courseLines,
      lessons,
      calendar: buildCalendar(month, lessons),
      activeTeacherNames,
    };
  });
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-batch-data.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
rtk git add apps/parent-report/src/student-billing-batch-data.mjs apps/parent-report/tests/student-billing-batch-data.test.mjs
rtk git commit -m "feat(parent-report): join billing rows to schedule details"
```

## Task 3: Render Approved Template-Style HTML

**Files:**
- Create: `apps/parent-report/src/render-student-billing-report.mjs`
- Create: `apps/parent-report/tests/student-billing-render.test.mjs`

**Step 1: Write the failing render test**

Create `apps/parent-report/tests/student-billing-render.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { renderStudentBillingReportHtml } from "../src/render-student-billing-report.mjs";

const report = {
  brandName: "菁仕",
  brandEnglish: "JINGSHI EDUCATION",
  studentName: "Ivy",
  month: "2026-03",
  monthLabel: "2026年3月",
  monthEnglish: "March 2026",
  totals: {
    grossAmount: 3300,
    discountAmount: 390,
    payableAmount: 2910,
    duration: 4,
    cancelledDuration: 2,
  },
  courseLines: [
    {
      teacher: "李品轩",
      courseType: "Alevel物理",
      teachingType: "1v1",
      isLeave: false,
      duration: 2,
      unitPriceLabel: "1,000",
      grossAmount: 2000,
      payableAmount: 2000,
      discountAmount: 0,
      discountRate: 100,
      discountReason: "",
      billingNote: "—",
    },
    {
      teacher: "李品轩",
      courseType: "Alevel物理",
      teachingType: "1v1",
      isLeave: true,
      duration: 2,
      unitPriceLabel: "650",
      grossAmount: 1300,
      payableAmount: 910,
      discountAmount: 390,
      discountRate: 70,
      discountReason: "临时请假",
      billingNote: "请假 70%",
    },
  ],
  calendar: {
    weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    cells: [
      { inMonth: true, day: 1, lessons: [] },
      { inMonth: true, day: 2, lessons: [] },
      { inMonth: true, day: 3, lessons: [{
        startTime: "15:15",
        endTime: "17:15",
        courseType: "Alevel物理",
        teacher: "李品轩",
        duration: 2,
        isLeave: false,
      }] },
      { inMonth: true, day: 4, lessons: [{
        startTime: "10:00",
        endTime: "12:00",
        courseType: "Alevel物理",
        teacher: "李品轩",
        duration: 2,
        isLeave: true,
        leaveLabel: "请假 · 临时取消",
      }] },
    ],
  },
  activeTeacherNames: ["李品轩"],
};

const teachers = [
  {
    name: "李品轩",
    subject: "物理",
    photo: null,
    tag: "IGCSE / A-Level 物理",
    desc: "物理老师简介",
    scores: { 学习提升: null, 责任心: null, 个人魅力: null },
  },
  {
    name: "应雁心",
    subject: "数学",
    photo: null,
    tag: "A-Level 数学",
    desc: "数学老师简介",
    scores: { 学习提升: null, 责任心: null, 个人魅力: null },
  },
];

test("renderStudentBillingReportHtml renders approved sections", () => {
  const html = renderStudentBillingReportHtml(report, teachers, { embedTeacherPhotos: false });

  assert.match(html, /<title>Ivy 2026年3月课时费明细<\/title>/);
  assert.match(html, /<h1 class="cover-student-name">Ivy<\/h1>/);
  assert.match(html, /<strong>2026年3月<\/strong>/);
  assert.match(html, /March 2026/);
  assert.match(html, /¥2,910/);
  assert.match(html, /<table>/);
  assert.match(html, /Alevel物理/);
  assert.match(html, /请假 70%/);
  assert.match(html, /class="calendar-wrap"/);
  assert.match(html, /class="lesson-pill leave"/);
  assert.match(html, /授课老师/);
  assert.match(html, /更多老师/);
  assert.match(html, /<h3>李品轩<\/h3>/);
  assert.match(html, /<h3>应雁心<\/h3>/);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-render.test.mjs
```

Expected: FAIL because renderer does not exist.

**Step 3: Implement renderer**

Create `apps/parent-report/src/render-student-billing-report.mjs`.

Implementation requirements:

- Copy the CSS and document structure from `outputs/parent_reports/模板.html`.
- Keep classes already used by the template: `.document`, `.page`, `.cover`, `.cover-student-name`, `table`, `.calendar-wrap`, `.calendar`, `.day`, `.lesson-pill`, `.faculty-section`, `.faculty-grid`, `.faculty-card`, `.closing`.
- Replace hard-coded dynamic regions with render functions:
  - cover student name
  - month label
  - English month
  - payable amount
  - course table body
  - total payable
  - schedule calendar
  - faculty sections
- Import and reuse:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFacultyByRole } from "./render-faculty.mjs";
```

- Use the existing `renderFacultyByRole(teachers, report.activeTeacherNames, opts)` so "授课老师" and "更多老师" are both preserved.
- Use `embed: true` and `photoDir` by default for generated reports so the output HTML is self-contained.

Required helper functions:

```js
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function formatMoney(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function discountLabel(line) {
  if (line.isLeave && line.billingNote && line.billingNote !== "—") return line.billingNote;
  if (line.discountReason) return line.discountReason;
  if (line.discountRate && line.discountRate !== 100) return `${line.discountRate / 10} 折`;
  return "—";
}
```

Course row rendering:

```js
function renderCourseRows(report) {
  return report.courseLines.map((line) => `
    <tr${line.isLeave ? ` class="is-leave"` : ""}>
      <td>
        <strong>${esc(line.courseType)}</strong>
        <span>${esc(line.teacher)} / ${esc(line.teachingType)}</span>
        ${line.discountReason ? `<span class="bill-note">${esc(line.discountReason)}</span>` : ""}
      </td>
      <td>${formatNumber(line.duration)}h</td>
      <td>${line.unitPriceLabel === "缺失" ? "缺失" : `¥${esc(line.unitPriceLabel)}`}</td>
      <td>${formatMoney(line.grossAmount)}</td>
      <td>${esc(discountLabel(line))}</td>
      <td>${formatMoney(line.payableAmount)}</td>
    </tr>
  `).join("");
}
```

Calendar rendering:

```js
function renderCalendar(report) {
  return `
    <div class="calendar-wrap">
      <div class="calendar">
        ${report.calendar.weekdays.map((day) => `<div class="weekday">${esc(day)}</div>`).join("")}
        ${report.calendar.cells.map((cell) => `
          <div class="day ${cell.inMonth ? "" : "muted"} ${cell.lessons?.some((lesson) => lesson.isLeave) ? "has-leave" : ""}">
            <div class="day-num">${esc(cell.day)}</div>
            <div class="day-lessons">
              ${(cell.lessons || []).map((lesson) => `
                <div class="lesson-pill ${lesson.isLeave ? "leave" : ""}">
                  <span>${esc(lesson.startTime)}-${esc(lesson.endTime)}</span>
                  <b>${esc(lesson.courseType)}</b>
                  <em>${esc(lesson.teacher)} · ${formatNumber(lesson.duration)}h</em>
                  ${lesson.isLeave ? `<mark>${esc(lesson.leaveLabel)}</mark>` : ""}
                </div>
              `).join("")}
            </div>
          </div>
        `).join("")}
      </div>
    </div>`;
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-render.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
rtk git add apps/parent-report/src/render-student-billing-report.mjs apps/parent-report/tests/student-billing-render.test.mjs
rtk git commit -m "feat(parent-report): render student billing html"
```

## Task 4: Add Batch Generation CLI

**Files:**
- Create: `apps/parent-report/src/generate-student-billing-reports.mjs`
- Modify: `apps/parent-report/package.json`
- Create: `apps/parent-report/tests/student-billing-cli.test.mjs`

**Step 1: Write the failing CLI test**

Create `apps/parent-report/tests/student-billing-cli.test.mjs`:

```js
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
```

**Step 2: Run test to verify it fails**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-cli.test.mjs
```

Expected: FAIL because CLI module does not exist.

**Step 3: Implement CLI module**

Create `apps/parent-report/src/generate-student-billing-reports.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRawScheduleLookup,
  buildStudentMonthReports,
  parseCompleteBillingCsv,
  safeFileName,
} from "./student-billing-batch-data.mjs";
import { renderStudentBillingReportHtml } from "./render-student-billing-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

const DEFAULT_COMPLETE_DIR = path.resolve(PROJECT_ROOT, "data/完整课时费");
const DEFAULT_SCHEDULE = path.resolve(PROJECT_ROOT, "data/raw/schedule.csv");
const DEFAULT_TEACHERS = path.resolve(PROJECT_ROOT, "apps/parent-report/data/teachers.json");
const DEFAULT_OUTPUT = path.resolve(PROJECT_ROOT, "outputs/parent_reports/generated");

function listCsvFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((file) => file.toLowerCase().endsWith(".csv"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((file) => path.join(directory, file));
}

export function generateStudentBillingReports({
  completeBillingDir = DEFAULT_COMPLETE_DIR,
  schedulePath = DEFAULT_SCHEDULE,
  teachersPath = DEFAULT_TEACHERS,
  outputDir = DEFAULT_OUTPUT,
  embedTeacherPhotos = true,
} = {}) {
  const billingRows = listCsvFiles(completeBillingDir).flatMap((file) => (
    parseCompleteBillingCsv(fs.readFileSync(file, "utf8"), file)
  ));
  const scheduleLookup = buildRawScheduleLookup(fs.readFileSync(schedulePath, "utf8"));
  const { teachers } = JSON.parse(fs.readFileSync(teachersPath, "utf8"));
  const reports = buildStudentMonthReports(billingRows, scheduleLookup);

  fs.mkdirSync(outputDir, { recursive: true });
  const written = reports.map((report) => {
    const fileName = `${safeFileName(report.studentName)}-${report.month}.html`;
    const outputPath = path.join(outputDir, fileName);
    const html = renderStudentBillingReportHtml(report, teachers, { embedTeacherPhotos });
    fs.writeFileSync(outputPath, html, "utf8");
    return outputPath;
  });

  return {
    inputFiles: listCsvFiles(completeBillingDir),
    reports,
    written,
    outputDir,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = generateStudentBillingReports();
  console.log(`Generated ${result.written.length} parent billing reports`);
  for (const file of result.written) console.log(file);
}
```

**Step 4: Add package script**

Modify `apps/parent-report/package.json` scripts:

```json
"generate:student-billing": "npm run build:teachers && cd ../.. && node apps/parent-report/src/generate-student-billing-reports.mjs"
```

Do not remove existing scripts.

**Step 5: Run test to verify it passes**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-cli.test.mjs
```

Expected: PASS.

**Step 6: Commit**

```bash
rtk git add apps/parent-report/src/generate-student-billing-reports.mjs apps/parent-report/package.json apps/parent-report/tests/student-billing-cli.test.mjs
rtk git commit -m "feat(parent-report): add batch student billing generator"
```

## Task 5: Add Real Fixture Smoke Test

**Files:**
- Modify: `apps/parent-report/tests/student-billing-cli.test.mjs`

**Step 1: Write the failing smoke test**

Append:

```js
test("default fixture directory can generate current sample reports", () => {
  const result = generateStudentBillingReports({
    completeBillingDir: "data/完整课时费",
    schedulePath: "data/raw/schedule.csv",
    teachersPath: "apps/parent-report/data/teachers.json",
    outputDir: path.join(os.tmpdir(), `jingshi-parent-report-real-${Date.now()}`),
    embedTeacherPhotos: false,
  });

  assert.ok(result.written.length >= 1);
  assert.ok(result.written.some((file) => path.basename(file).includes("Daniel 周恩东-2026-03")));
});
```

**Step 2: Run test to verify it passes or exposes real-data issues**

Run:

```bash
rtk node --test apps/parent-report/tests/student-billing-cli.test.mjs
```

Expected: PASS if fixture data and `data/raw/schedule.csv` are present.

If it fails because an `原始行` is missing in `data/raw/schedule.csv`, improve the model to keep the report and expose a warning list:

```js
missingRawRows: rows.flatMap((row) => row.rawRows).filter((rawRow) => !scheduleLookup.has(rawRow))
```

Then assert that generation still writes HTML.

**Step 3: Commit**

```bash
rtk git add apps/parent-report/tests/student-billing-cli.test.mjs apps/parent-report/src/student-billing-batch-data.mjs
rtk git commit -m "test(parent-report): cover real batch generation fixture"
```

## Task 6: Run Full Relevant Verification

**Files:**
- No source edits expected.

**Step 1: Run parent-report tests**

Run:

```bash
rtk npm run test:parent-report
```

Expected: PASS.

**Step 2: Run root JS tests**

Run:

```bash
rtk npm test
```

Expected: PASS.

**Step 3: Generate reports with real data**

Run:

```bash
rtk npm run generate:student-billing -w @jingshi/parent-report
```

Expected:

- `apps/parent-report/scripts/build-teachers.mjs` refreshes `apps/parent-report/data/teachers.json`.
- HTML files are written under `outputs/parent_reports/generated/`.
- Console prints the generated file paths.

**Step 4: Inspect generated files structurally**

Run:

```bash
rtk find outputs/parent_reports/generated -maxdepth 1 -name '*.html' -print | sort
```

Expected: one HTML file per student-month group.

Run:

```bash
rtk rg -n "课时费明细|授课老师|更多老师|Total Payable" outputs/parent_reports/generated
```

Expected: every generated HTML contains the main required sections.

**Step 5: Commit verification-safe changes**

Only if all tests pass:

```bash
rtk git status --short
```

Review changed files. Do not stage unrelated existing user changes.

## Task 7: Document Operator Workflow

**Files:**
- Modify: `apps/parent-report/README.md`
- Optional Modify: `docs/操作步骤.md`

**Step 1: Add workflow docs**

Append to `apps/parent-report/README.md`:

```md
## 批量生成学生课时费明细 HTML

1. 把完整课时费 CSV 放到仓库根目录的 `data/完整课时费/`。
2. 确认原始课表位于 `data/raw/schedule.csv`。
3. 如需更新师资卡，编辑 `apps/parent-report/assets/teacher/老师卡片.txt` 和同目录头像。
4. 运行：

   ```bash
   npm run generate:student-billing -w @jingshi/parent-report
   ```

5. 生成结果位于：

   ```text
   outputs/parent_reports/generated/
   ```

命名规则为 `学生姓名-月份.html`，例如 `Daniel 周恩东-2026-03.html`。学生姓名会自动去掉末尾编号，例如 `Daniel 周恩东-3735` 会显示为 `Daniel 周恩东`。

老师卡片规则：当月授课老师如果存在于 `老师卡片.txt`，会进入「授课老师」；未收录老师仍显示在课程明细和课表里，但不显示卡片；其余已收录老师显示在「更多老师」。
```

**Step 2: Run docs-adjacent smoke command**

Run:

```bash
rtk npm run generate:student-billing -w @jingshi/parent-report
```

Expected: generator still works after docs update.

**Step 3: Commit**

```bash
rtk git add apps/parent-report/README.md docs/操作步骤.md
rtk git commit -m "docs(parent-report): document batch student billing workflow"
```

## Final Acceptance Criteria

- Running `npm run generate:student-billing -w @jingshi/parent-report` creates multiple HTML files under `outputs/parent_reports/generated/`.
- Each file represents exactly one cleaned student name plus one month.
- The cover, course detail, schedule calendar, faculty team, and closing sections follow the approved `模板.html` visual structure.
- Course amounts come from the complete billing CSV.
- Schedule details come from `data/raw/schedule.csv` via `原始行`.
- "授课老师" includes only active teachers that exist in `teachers.json`.
- "更多老师" remains present and includes the rest of the teacher-card roster.
- Missing teacher cards do not block report generation.
- No Playwright verification is added.
- Node tests pass.

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-03-parent-report-batch-generation.md`.

Two execution options:

1. **Subagent-Driven (this session)** - dispatch a fresh subagent per task and review between tasks.
2. **Parallel Session (separate)** - open a new session with `superpowers:executing-plans` and execute the plan with checkpoints.

