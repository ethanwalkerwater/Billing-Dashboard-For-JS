import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderFacultyByRole } from "./render-faculty.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_PHOTO_DIR = path.resolve(PROJECT_ROOT, "apps/parent-report/assets/teacher");

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

function facultyOptions(options) {
  if (options.embedTeacherPhotos === false) {
    return { photoBase: options.photoBase || "../../apps/parent-report/assets/teacher/" };
  }
  return {
    embed: true,
    photoDir: options.photoDir || DEFAULT_PHOTO_DIR,
    optimizeEmbeddedPhotos: options.optimizeEmbeddedPhotos ?? true,
  };
}

export function renderStudentBillingReportHtml(report, teachers, options = {}) {
  const facultySections = renderFacultyByRole(
    teachers,
    report.activeTeacherNames,
    facultyOptions(options),
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(report.studentName)} ${esc(report.monthLabel)}课时费明细</title>
  <style>
    :root {
      --paper: #eef1f6;
      --ivory: #fffdf8;
      --ink: #141821;
      --muted: #6f7684;
      --hairline: #d9dde7;
      --indigo: #24149a;
      --indigo-deep: #100b4f;
      --indigo-soft: #efedff;
      --champagne: #b9905e;
      --champagne-soft: #f7efe4;
      --platinum: #f5f6f8;
      --leave: #a4523f;
      --radius: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif;
      font-size: 14px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .document { width: min(1120px, 100%); margin: 0 auto; padding: 0 18px 40px; background: var(--paper); }
    .page {
      position: relative;
      min-height: 760px;
      padding: 54px 44px;
      margin: 0 auto 20px;
      background: var(--ivory);
      overflow: hidden;
      border-bottom: 1px solid var(--hairline);
      box-shadow: 0 2px 12px rgba(20,24,33,.06);
    }
    .page::before {
      content: "";
      position: absolute;
      inset: 16px;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      pointer-events: none;
    }
    .page > * { position: relative; z-index: 1; }
    .cover { display: flex; flex-direction: column; justify-content: space-between; min-height: 760px; }
    .cover-lines {
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(120deg, rgba(20,24,33,.02) 0 2px, transparent 2px 30px);
      z-index: 0;
    }
    .cover-brandline, .closing-brandline { display: flex; align-items: baseline; gap: 10px; }
    .brand-mark { font-family: "Songti SC", "STSong", serif; font-size: 30px; font-weight: 600; }
    .brand-en { font-size: 11px; letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }
    .cover-main { text-align: center; margin: auto 0; padding: 42px 0; }
    .cover-student-name {
      margin: 0 0 28px;
      font-family: "Songti SC", "STSong", serif;
      font-size: 86px;
      line-height: 1.05;
      font-weight: 500;
    }
    .cover-ref-divider { width: 48px; height: 1px; margin: 0 auto 24px; background: var(--ink); opacity: .55; }
    .cover-report-title { font-size: 36px; font-weight: 300; letter-spacing: .04em; }
    .cover-month-block { margin-top: 72px; }
    .cover-month-block strong { display: block; font-family: "Songti SC", "STSong", serif; font-size: 28px; font-weight: 500; }
    .cover-footer, .closing-footer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 24px;
      align-items: end;
      padding-top: 28px;
      border-top: 1px solid rgba(20,24,33,.25);
    }
    .cover-footer-meta { color: var(--muted); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
    .cover-footer-date { margin-top: 5px; color: var(--muted); font-size: 12px; letter-spacing: .12em; }
    .cover-footer-amount strong, .closing-footer-amount { font-size: 42px; font-weight: 500; letter-spacing: 0; }
    .page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 24px; }
    .kicker { color: var(--champagne); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h2 { margin: 6px 0 0; font-family: "Songti SC", "STSong", serif; font-size: 36px; line-height: 1.2; font-weight: 600; }
    .page-num { color: var(--indigo); font-size: 12px; letter-spacing: .12em; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; background: white; border: 1px solid var(--hairline); }
    th, td { padding: 14px 12px; border-bottom: 1px solid var(--hairline); text-align: left; vertical-align: top; }
    th { background: var(--platinum); color: var(--muted); font-size: 12px; font-weight: 700; }
    td strong { display: block; font-size: 15px; }
    td span { display: block; color: var(--muted); font-size: 12px; }
    tr.is-leave { background: var(--champagne-soft); }
    .bill-note { margin-top: 5px; color: var(--leave); }
    .total-row { margin-top: 24px; padding-top: 18px; border-top: 2px solid var(--ink); }
    .total-row p { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
    .section-label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .total-row strong { font-size: 36px; font-weight: 600; }
    .calendar-wrap { overflow-x: auto; }
    .calendar { display: grid; grid-template-columns: repeat(7, minmax(126px, 1fr)); gap: 8px; min-width: 900px; }
    .weekday { padding: 8px 10px; color: var(--muted); font-size: 12px; font-weight: 700; text-align: center; }
    .day { min-height: 132px; padding: 8px; border: 1px solid var(--hairline); border-radius: 8px; background: white; }
    .day.muted { background: var(--platinum); opacity: .5; }
    .day.has-leave { border-color: rgba(164,82,63,.4); }
    .day-num { color: var(--indigo-deep); font-weight: 700; }
    .day-lessons { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .lesson-pill { padding: 6px 7px; border-left: 3px solid var(--indigo); border-radius: 0 6px 6px 0; background: var(--indigo-soft); font-size: 11px; }
    .lesson-pill.leave { border-left-color: var(--leave); background: var(--champagne-soft); }
    .lesson-pill span, .lesson-pill b, .lesson-pill em { display: block; }
    .lesson-pill span { color: var(--muted); }
    .lesson-pill b { line-height: 1.35; }
    .lesson-pill em { color: var(--muted); font-style: normal; }
    mark { display: inline-block; margin-top: 4px; border-radius: 999px; padding: 2px 7px; background: rgba(164,82,63,.12); color: var(--leave); font-size: 10px; font-weight: 700; }
    .legend { display: flex; gap: 18px; margin-top: 16px; color: var(--muted); font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 10px; height: 10px; border-radius: 50%; background: var(--indigo); }
    .legend .leave i { background: var(--leave); }
    .faculty-section { margin-top: 22px; }
    .faculty-section:first-of-type { margin-top: 0; }
    .faculty-section h3 { margin: 0 0 14px; font-family: "Songti SC", "STSong", serif; font-size: 22px; font-weight: 600; }
    .faculty-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .faculty-card { display: flex; gap: 14px; min-height: 156px; border: 1px solid var(--hairline); border-radius: var(--radius); background: white; overflow: hidden; }
    .faculty-photo { flex: 0 0 152px; background: #edf0f5; }
    .faculty-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .faculty-panel { display: flex; flex: 1; min-width: 0; flex-direction: column; padding: 16px 18px 14px; }
    .faculty-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
    .faculty-head h3 { margin: 0; font-size: 21px; line-height: 1.1; }
    .faculty-tag { color: var(--champagne); font-size: 12px; font-weight: 600; }
    .faculty-desc { margin: 0; color: var(--ink); opacity: .82; font-size: 13px; line-height: 1.72; }
    .faculty-metrics { display: flex; gap: 24px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--hairline); }
    .faculty-metric-label { display: block; color: var(--muted); font-size: 11px; }
    .faculty-metric-value { display: block; margin-top: 2px; color: var(--indigo); font-size: 18px; white-space: nowrap; }
    .closing { display: flex; flex-direction: column; justify-content: space-between; min-height: 680px; }
    .closing-main { text-align: center; margin: auto 0; padding: 40px 0; }
    .closing-main h2 { margin: 0 0 24px; font-family: "Songti SC", "STSong", serif; font-size: 48px; font-weight: 500; letter-spacing: .06em; }
    .closing-divider { width: 40px; height: 1px; background: var(--champagne); margin: 0 auto 20px; }
    .closing-thanks { margin-bottom: 12px; font-size: 12px; letter-spacing: .22em; text-transform: uppercase; }
    .closing-note { margin: 0; color: var(--muted); font-size: 14px; }
    .closing-footer-left { color: var(--muted); font-size: 13px; line-height: 1.7; }
    @media (max-width: 780px) {
      .document { padding: 0; }
      .page { min-height: auto; padding: 38px 24px; margin-bottom: 0; }
      .page::before { inset: 14px; }
      .cover-student-name { font-size: 64px; }
      .cover-footer, .closing-footer { grid-template-columns: 1fr; }
      .faculty-grid { grid-template-columns: 1fr; }
      .faculty-card { flex-direction: row; }
    }
  </style>
</head>
<body>
  <main class="document">
    <section class="page cover">
      <div class="cover-lines"></div>
      <div class="brand">
        <div class="cover-brandline">
          <div class="brand-mark">${esc(report.brandName)}</div>
          <div class="brand-en">${esc(report.brandEnglish)}</div>
        </div>
      </div>
      <div class="cover-main">
        <h1 class="cover-student-name">${esc(report.studentName)}</h1>
        <div class="cover-ref-divider"></div>
        <div class="cover-report-title">课时费明细</div>
        <div class="cover-month-block">
          <strong>${esc(report.monthLabel)}</strong>
        </div>
      </div>
      <div class="cover-footer">
        <div>
          <div class="cover-footer-meta">Tuition Detail</div>
          <div class="cover-footer-date">${esc(report.monthEnglish)}</div>
        </div>
        <div class="cover-footer-amount">
          <strong>${formatMoney(report.totals.payableAmount)}</strong>
        </div>
      </div>
    </section>

    <section class="page">
      <header class="page-head">
        <div>
          <div class="kicker">Billing Detail</div>
          <h2>课程明细</h2>
        </div>
        <div class="page-num">01 / 04</div>
      </header>
      <table>
        <thead>
          <tr>
            <th>课程</th>
            <th>课时</th>
            <th>课时单价</th>
            <th>课时费</th>
            <th>折扣</th>
            <th>应付课时费</th>
          </tr>
        </thead>
        <tbody>${renderCourseRows(report)}</tbody>
      </table>
      <div class="total-row">
        <p>折扣与临时请假已按规则计入应付课时费。</p>
        <div>
          <span class="section-label">Total Payable</span>
          <strong>${formatMoney(report.totals.payableAmount)}</strong>
        </div>
      </div>
    </section>

    <section class="page">
      <header class="page-head">
        <div>
          <div class="kicker">${esc(report.monthEnglish.split(" ")[0] || "Schedule")} Schedule</div>
          <h2>${esc(report.monthLabel)}课表</h2>
        </div>
        <div class="page-num">02 / 04</div>
      </header>
      ${renderCalendar(report)}
      <div class="legend">
        <span><i></i>正常课程</span>
        <span class="leave"><i></i>请假 / 临时取消课程</span>
      </div>
    </section>

    <section class="page">
      <header class="page-head">
        <div>
          <div class="kicker">Faculty Team</div>
          <h2>师资团队</h2>
        </div>
        <div class="page-num">03 / 04</div>
      </header>
${facultySections}
    </section>

    <section class="page closing">
      <div class="closing-brandline">
        <div class="brand-mark">${esc(report.brandName)}</div>
        <div class="brand-en">${esc(report.brandEnglish)}</div>
      </div>
      <div class="closing-main">
        <h2>感谢信任</h2>
        <div class="closing-divider"></div>
        <div class="closing-thanks">THANK YOU</div>
        <p class="closing-note">教育是一场长期主义的同行</p>
      </div>
      <div class="closing-footer">
        <div class="closing-footer-left">
          <div>${esc(report.monthLabel)}</div>
          <div>课时费明细</div>
        </div>
        <div class="closing-footer-amount">${formatMoney(report.totals.payableAmount)}</div>
      </div>
    </section>
  </main>
</body>
</html>`;
}
