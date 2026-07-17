import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildParentReportData } from "./parent-report-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const INPUT = process.env.JINGSHI_SCHEDULE_PATH || "data/local/shared/schedule.csv";
const OUTPUT = "outputs/parent_reports/codex-ivy-2488-2026-03.html";
const PORTRAIT_RENDER_DIR = path.resolve(PROJECT_ROOT, "outputs/parent_reports/teacher_info");
const PORTRAIT_SOURCE_DIR = path.resolve(PROJECT_ROOT, "apps/parent-report/assets/teachers");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatMoney(value) {
  const integerValue = Math.floor(Number(value || 0));
  return `¥${integerValue.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMonthEnglish(monthValue) {
  const match = String(monthValue || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(monthValue || "");
  const [, year, month] = match;
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${monthNames[Number(month) - 1]} ${year}`;
}

function dateLabel(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  return `${month}月${day}日`;
}

function portraitDataUri(teacher) {
  const name = teacher.actualName || teacher.name;
  if (!name) return "";

  const rendered = path.join(PORTRAIT_RENDER_DIR, `${name}-portrait.png`);
  if (fs.existsSync(rendered)) {
    return `data:image/png;base64,${fs.readFileSync(rendered).toString("base64")}`;
  }

  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    const source = path.join(PORTRAIT_SOURCE_DIR, `${name}${ext}`);
    if (fs.existsSync(source)) {
      return `data:image/${ext.slice(1) === "jpg" ? "jpeg" : ext.slice(1)};base64,${fs.readFileSync(source).toString("base64")}`;
    }
  }

  return "";
}

function teacherSummary(teacher) {
  const items = teacher.background || [];
  if (items.length >= 2) {
    const education = items[0].replace(/[。；\s]+$/g, "").trim();
    const feature = items[1]
      .replace(/^本月负责/, "")
      .replace(/^本月参与/, "")
      .replace(/[。；\s]+$/g, "")
      .trim();
    return `${education}，课程特点：${feature}`;
  }

  return (items[0] || "菁仕授课团队成员，课程特点：注重节奏稳定与长期积累。")
    .replace(/[。；\s]+$/g, "")
    .trim();
}

function renderCourseCards(report) {
  return report.courseLines.map((line) => `
    <article class="bill-card ${line.isLeave ? "is-leave" : ""}">
      <div class="bill-card-head">
        <div>
          <h3>${escapeHtml(line.courseType)}</h3>
          <p>${escapeHtml(line.teacher)} · ${escapeHtml(line.teachingType)}</p>
        </div>
        <strong>${formatMoney(line.payableAmount)}</strong>
      </div>
      <div class="bill-meta">
        <div><span>课时</span><strong>${formatNumber(line.duration)}h</strong></div>
        <div><span>节数</span><strong>${formatNumber(line.lessonCount)}</strong></div>
        <div><span>单价</span><strong>${escapeHtml(line.unitPriceLabel)}</strong></div>
      </div>
      <div class="bill-note">
        <span>计费说明</span>
        <p>${escapeHtml(line.billingNote)}${line.isLeave ? `，取消课程费 ${formatMoney(line.cancellationChargeAmount)}，未收 ${formatMoney(line.waivedAmount)}` : "，按实际完成课时计费。"}</p>
      </div>
    </article>
  `).join("");
}

function groupLessonsByDate(lessons) {
  const groups = new Map();
  for (const lesson of lessons) {
    if (!groups.has(lesson.date)) groups.set(lesson.date, []);
    groups.get(lesson.date).push(lesson);
  }
  return [...groups.entries()];
}

function renderTimeline(report) {
  return groupLessonsByDate(report.lessons).map(([date, lessons]) => `
    <section class="lesson-group">
      <div class="lesson-group-date">
        <strong>${escapeHtml(dateLabel(date))}</strong>
        <span>${escapeHtml(lessons[0].weekday)}</span>
      </div>
      <div class="timeline-list">
        ${lessons.map((lesson) => `
          <article class="timeline-item ${lesson.isLeave ? "is-leave" : ""}">
            <div class="timeline-time">${escapeHtml(lesson.startTime)} - ${escapeHtml(lesson.endTime)}</div>
            <div class="timeline-body">
              <h3>${escapeHtml(lesson.courseType)}</h3>
              <p>${escapeHtml(lesson.teacher)} · ${escapeHtml(lesson.teachingType)} · ${formatNumber(lesson.duration)}h</p>
              ${lesson.isLeave ? `<em>${escapeHtml(lesson.leaveLabel)} · ${escapeHtml(lesson.billingNote)}</em>` : ""}
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function renderTeacherStream(teachers) {
  return teachers
    .map((teacher) => ({ teacher, portrait: portraitDataUri(teacher) }))
    .filter((entry) => entry.portrait)
    .map(({ teacher, portrait }) => `
      <article class="teacher-card">
        <div class="teacher-photo"><img src="${portrait}" alt="${escapeHtml(teacher.actualName || teacher.name)}" /></div>
        <div class="teacher-copy">
          <h3>${escapeHtml(teacher.actualName || teacher.name)}</h3>
          <p>${escapeHtml(teacherSummary(teacher))}</p>
          <div class="teacher-metrics">
            <div><span>当月总授课</span><strong>${formatNumber(teacher.monthlyTotalDuration)}h</strong></div>
            <div><span>课次数</span><strong>${formatNumber(teacher.monthlyTotalLessons)}</strong></div>
            <div><span>月度评分</span><strong>${teacher.monthlyScore ?? "待更新"}</strong></div>
          </div>
        </div>
      </article>
    `).join("");
}

export function renderCodexParentReportHtml(report) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.studentName)} ${escapeHtml(report.monthLabel)}课时费明细</title>
  <style>
    :root {
      --paper: #f3f5fa;
      --surface: #ffffff;
      --ivory: #fffdf8;
      --ink: #181c25;
      --muted: #687181;
      --line: #dde3ee;
      --indigo: #24149a;
      --indigo-soft: #f2f0ff;
      --champagne: #b9905e;
      --champagne-soft: #fbf4ea;
      --leave: #a4523f;
      --radius: 18px;
      --shadow: 0 12px 32px rgba(20,24,33,.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
      letter-spacing: 0;
    }
    .mobile-shell {
      width: min(440px, 100%);
      margin: 0 auto;
      padding: 18px 14px 28px;
    }
    .page {
      margin-bottom: 16px;
      padding: 22px 18px;
      border-radius: 26px;
      background: var(--surface);
      box-shadow: var(--shadow);
      overflow: hidden;
      position: relative;
      page-break-after: always;
    }
    .page:last-child { margin-bottom: 0; }
    .cover {
      padding: 24px 20px 22px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.98), rgba(255,253,248,.96)),
        var(--ivory);
    }
    .cover::before,
    .closing::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        repeating-linear-gradient(120deg, rgba(20,24,33,.018) 0 2px, transparent 2px 28px);
      pointer-events: none;
    }
    .cover > *,
    .closing > * { position: relative; z-index: 1; }
    .brandline {
      display: inline-flex;
      align-items: center;
      gap: 14px;
      color: var(--ink);
      font-size: 12px;
      letter-spacing: .28em;
      text-transform: uppercase;
    }
    .brandline .mark {
      font-family: "Songti SC", "STSong", serif;
      font-size: 28px;
      letter-spacing: 0;
      text-transform: none;
      font-weight: 600;
    }
    .cover-kicker,
    .section-kicker {
      margin-top: 22px;
      color: var(--champagne);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    .cover-student-name {
      margin: 54px 0 10px;
      font-family: "Iowan Old Style", "Baskerville", "Times New Roman", serif;
      font-size: 64px;
      line-height: .94;
      font-weight: 500;
    }
    .cover-title {
      margin: 0;
      font-size: 30px;
      line-height: 1.18;
      font-weight: 300;
    }
    .cover-meta {
      margin-top: 20px;
      display: grid;
      gap: 10px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
    }
    .cover-total {
      margin-top: 26px;
      padding-top: 18px;
      border-top: 1px solid rgba(24,28,37,.12);
      display: grid;
      gap: 8px;
    }
    .cover-total span {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .2em;
      text-transform: uppercase;
    }
    .cover-total strong {
      font-size: 40px;
      line-height: 1;
      font-weight: 500;
    }
    .section-head {
      display: grid;
      gap: 6px;
      margin-bottom: 18px;
    }
    h1, h2, h3, p { margin: 0; }
    h2 {
      font-family: "Songti SC", "STSong", serif;
      font-size: 28px;
      line-height: 1.16;
      font-weight: 600;
    }
    .section-note {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.65;
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .summary-card {
      padding: 14px 14px 13px;
      border-radius: 16px;
      background: var(--ivory);
      border: 1px solid var(--line);
    }
    .summary-card span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .summary-card strong {
      display: block;
      margin-top: 8px;
      font-size: 24px;
      line-height: 1.05;
      font-weight: 650;
    }
    .bill-stack,
    .teacher-stream {
      display: grid;
      gap: 12px;
    }
    .bill-card,
    .teacher-card,
    .timeline-item {
      border-radius: 18px;
      border: 1px solid var(--line);
      background: var(--surface);
    }
    .bill-card {
      padding: 16px;
      background: linear-gradient(180deg, #fff, #fcfcff);
    }
    .bill-card.is-leave { background: linear-gradient(180deg, #fffaf6, #fff); }
    .bill-card-head {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: start;
    }
    .bill-card-head h3,
    .timeline-body h3,
    .teacher-copy h3 {
      font-family: "Songti SC", "STSong", serif;
      font-size: 23px;
      line-height: 1.16;
      font-weight: 600;
    }
    .bill-card-head p,
    .timeline-body p,
    .teacher-copy p {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.72;
    }
    .bill-card-head strong {
      font-size: 26px;
      line-height: 1;
      font-weight: 650;
      color: var(--indigo);
    }
    .bill-meta,
    .teacher-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 14px;
    }
    .bill-meta div,
    .teacher-metrics div {
      padding-top: 10px;
      border-top: 1px solid rgba(24,28,37,.08);
    }
    .bill-meta span,
    .teacher-metrics span,
    .bill-note span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
    }
    .bill-meta strong,
    .teacher-metrics strong {
      display: block;
      margin-top: 6px;
      font-size: 18px;
      line-height: 1.1;
      font-weight: 600;
    }
    .bill-note {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px dashed rgba(24,28,37,.12);
    }
    .bill-note p {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.68;
    }
    .lesson-group {
      display: grid;
      gap: 10px;
      margin-bottom: 16px;
    }
    .lesson-group:last-child { margin-bottom: 0; }
    .lesson-group-date strong {
      display: block;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 650;
    }
    .lesson-group-date span {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .timeline-list {
      display: grid;
      gap: 10px;
    }
    .timeline-item {
      display: grid;
      grid-template-columns: 86px 1fr;
      gap: 12px;
      padding: 14px;
    }
    .timeline-item.is-leave { background: var(--champagne-soft); }
    .timeline-time {
      font-size: 13px;
      line-height: 1.4;
      font-weight: 650;
      color: var(--indigo);
    }
    .timeline-body em {
      display: inline-block;
      margin-top: 8px;
      color: var(--leave);
      font-size: 12px;
      line-height: 1.5;
      font-style: normal;
    }
    .teacher-card {
      overflow: hidden;
      background: linear-gradient(180deg, #fff, #fcfcff);
    }
    .teacher-photo {
      height: 220px;
      background: #edf0f5;
      overflow: hidden;
    }
    .teacher-photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center 18%;
      display: block;
    }
    .teacher-copy {
      padding: 16px;
    }
    .teacher-copy p {
      margin-top: 10px;
    }
    .closing {
      text-align: center;
      padding: 24px 18px 22px;
      background: linear-gradient(180deg, rgba(255,255,255,.98), rgba(255,253,248,.96));
    }
    .closing-main {
      padding: 88px 0 96px;
      display: grid;
      gap: 16px;
      justify-items: center;
    }
    .closing h2 {
      font-size: 50px;
    }
    .closing-divider {
      width: 44px;
      height: 2px;
      background: var(--champagne);
    }
    .closing-english {
      font-size: 16px;
      letter-spacing: .34em;
      text-transform: uppercase;
    }
    .closing-phrase {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.7;
    }
    .closing-footer {
      padding-top: 18px;
      border-top: 1px solid rgba(24,28,37,.14);
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 16px;
      text-align: left;
    }
    .closing-footer-meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.8;
    }
    .closing-footer strong {
      font-size: 36px;
      line-height: 1;
      font-weight: 500;
    }
    @media print {
      body { background: white; }
      .mobile-shell {
        width: 100%;
        padding: 0;
      }
      .page {
        margin: 0;
        border-radius: 0;
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <main class="mobile-shell">
    <section class="page cover">
      <div class="brandline"><span class="mark">${escapeHtml(report.brandName)}</span><span>${escapeHtml(report.brandEnglish)}</span></div>
      <div class="cover-kicker">Monthly Tuition Statement</div>
      <h1 class="cover-student-name">${escapeHtml(report.studentName)}</h1>
      <p class="cover-title">课时费明细</p>
      <div class="cover-meta">
        <div>${escapeHtml(report.monthLabel)} · ${formatNumber(report.totals.lessonCount)}节课 / ${formatNumber(report.totals.duration)}小时</div>
        <div>面向家庭的月度课程费用记录与学习服务摘要。</div>
      </div>
      <div class="cover-total">
        <span>Tuition Detail · ${escapeHtml(formatMonthEnglish(report.month))}</span>
        <strong>${formatMoney(report.totals.payableAmount)}</strong>
      </div>
    </section>

    <section class="page">
      <div class="section-head">
        <div class="section-kicker">Billing Overview</div>
        <h2>费用概览</h2>
        <p class="section-note">先看本月总额，再往下查看每个课程组的计费说明。</p>
      </div>
      <div class="summary-strip">
        <div class="summary-card"><span>课时总额</span><strong>${formatMoney(report.totals.grossAmount)}</strong></div>
        <div class="summary-card"><span>应付课时费</span><strong>${formatMoney(report.totals.payableAmount)}</strong></div>
        <div class="summary-card"><span>请假未收</span><strong>${formatMoney(report.totals.discountAmount)}</strong></div>
        <div class="summary-card"><span>请假课程</span><strong>${formatNumber(report.totals.cancelledLessons)} 节</strong></div>
      </div>
      <div class="bill-stack">${renderCourseCards(report)}</div>
    </section>

    <section class="page">
      <div class="section-head">
        <div class="section-kicker">Learning Timeline</div>
        <h2>${escapeHtml(report.monthLabel)}学习安排</h2>
        <p class="section-note">按日期纵向阅读，比月历更适合在手机上快速定位课程与请假信息。</p>
      </div>
      ${renderTimeline(report)}
    </section>

    <section class="page">
      <div class="section-head">
        <div class="section-kicker">Faculty Team</div>
        <h2>授课与支持团队</h2>
        <p class="section-note">保留老师头像、课程特点与当月服务数据，方便家长在手机端逐张阅读。</p>
      </div>
      <div class="teacher-stream">${renderTeacherStream([...report.teachers, ...report.moreTeachers])}</div>
    </section>

    <section class="page closing">
      <div class="brandline"><span class="mark">${escapeHtml(report.brandName)}</span><span>${escapeHtml(report.brandEnglish)}</span></div>
      <div class="closing-main">
        <h2>感谢信任</h2>
        <div class="closing-divider"></div>
        <div class="closing-english">THANK YOU</div>
        <p class="closing-phrase">教育是一场长期主义的同行</p>
      </div>
      <div class="closing-footer">
        <div class="closing-footer-meta">
          <div>${escapeHtml(report.monthLabel)}</div>
          <div>课时费明细</div>
        </div>
        <strong>${formatMoney(report.totals.payableAmount)}</strong>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export function writeCodexParentReport({
  input = INPUT,
  output = OUTPUT,
  student = "Ivy-2488",
  month = "2026-03",
} = {}) {
  const csv = fs.readFileSync(path.resolve(PROJECT_ROOT, input), "utf8");
  const report = buildParentReportData(csv, { student, month });
  const html = renderCodexParentReportHtml(report);
  const outputPath = path.resolve(PROJECT_ROOT, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  return outputPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputPath = writeCodexParentReport();
  console.log(`Codex parent report written to ${outputPath}`);
}
