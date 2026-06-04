import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildParentReportData } from "./parent-report-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const INPUT = "data/raw/schedule.csv";
const OUTPUT = "outputs/parent_reports/ivy-2488-2026-03.html";
const PORTRAIT_SOURCE_DIR = "apps/parent-report/assets/teacher";
const PORTRAIT_RENDER_DIR = "outputs/parent_reports/teacher_info";
const RENDERER_MTIME = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;

function formatMoney(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMonthEnglish(monthValue) {
  const match = String(monthValue || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return String(monthValue || "");
  const [, year, month] = match;
  const monthIndex = Number(month) - 1;
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${monthNames[monthIndex] || month} ${year}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function portraitOutputPathFor(portraitName) {
  return path.resolve(PROJECT_ROOT, PORTRAIT_RENDER_DIR, `${portraitName}-portrait.png`);
}

function portraitSourcePathFor(teacher) {
  const portraitName = teacher.actualName || teacher.name;
  if (!portraitName) return "";
  const directory = path.resolve(PROJECT_ROOT, PORTRAIT_SOURCE_DIR);
  for (const extension of [".png", ".jpg", ".jpeg", ".webp"]) {
    const candidate = path.join(directory, `${portraitName}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const photo = fs.readdirSync(directory)
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .find((file) => path.basename(file, path.extname(file)).endsWith(`-${portraitName}`));
  if (photo) return path.join(directory, photo);
  return "";
}

function ensureTeacherPortrait(teacher) {
  const absolutePath = portraitSourcePathFor(teacher);
  if (!absolutePath) return "";
  const portraitName = teacher.actualName || teacher.name;
  const outputPath = portraitOutputPathFor(portraitName);
  const inputMtime = fs.statSync(absolutePath).mtimeMs;
  const outputMtime = fs.existsSync(outputPath) ? fs.statSync(outputPath).mtimeMs : 0;
  if (outputMtime >= Math.max(inputMtime, RENDERER_MTIME)) return outputPath;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = spawnSync("magick", [
    absolutePath,
    "-auto-orient",
    "-resize", "512x420^",
    "-gravity", "North",
    "-extent", "512x420",
    outputPath,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to extract teacher portrait from ${absolutePath}: ${result.stderr || result.stdout}`);
  }
  return outputPath;
}

function portraitDataUri(teacher) {
  const portraitPath = ensureTeacherPortrait(teacher);
  if (!portraitPath) return "";
  return `data:image/png;base64,${fs.readFileSync(portraitPath).toString("base64")}`;
}

function teacherNote(teacher) {
  return teacher.background?.join(" ") || "菁仕授课团队成员。";
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

  const summary = (items[0] || teacherNote(teacher)).replace(/[。；\s]+$/g, "").trim();
  if (summary.includes("，")) {
    const [education, ...rest] = summary.split("，");
    return `${education.trim()}，课程特点：${rest.join("，").trim()}`;
  }

  return `${summary}，课程特点：因材施教，注重学习动力与自学能力培养`;
}

function subjectTag(course) {
  if (course.includes("物理")) return "Physics";
  if (course.includes("数学") || course.includes("高数")) return "Mathematics";
  return "Academic";
}

function renderCourseCards(report) {
  return report.courseLines.map((line) => `
    <article class="course-card ${line.status === "正常上课" ? "" : "leave"}">
      <div class="course-header">
        <div>
          <strong class="course-name">${escapeHtml(line.courseType)}</strong>
          <div class="course-meta">${escapeHtml(line.teacher)} · ${escapeHtml(line.teachingType)}${line.status === "正常上课" ? "" : ` · ${escapeHtml(line.status)}`}</div>
        </div>
      </div>
      <div class="course-body">
        <div class="course-col">
          <span class="course-label">课时</span>
          <strong class="course-val">${formatNumber(line.duration)}h</strong>
        </div>
        <div class="course-col">
          <span class="course-label">单价</span>
          <strong class="course-val">${escapeHtml(line.unitPriceLabel)}</strong>
        </div>
        <div class="course-col">
          <span class="course-label">课时费</span>
          <strong class="course-val">${formatMoney(line.grossAmount)}</strong>
        </div>
      </div>
      <div class="course-footer">
        <span class="course-status">${escapeHtml(line.billingNote)}</span>
        <strong class="course-payable">${formatMoney(line.payableAmount)}</strong>
      </div>
      ${line.isLeave ? `<div class="course-waived">取消课程费 ${formatMoney(line.cancellationChargeAmount)} / 未收 ${formatMoney(line.waivedAmount)}</div>` : ""}
    </article>
  `).join("");
}

function renderScheduleList(report) {
  const days = report.calendar.weeks.flat().filter((c) => c.inMonth && c.lessons.length > 0);
  if (days.length === 0) return '<p class="empty">本月暂无课程安排</p>';
  return `
    <div class="schedule-list">
      ${days.map((cell) => `
        <div class="schedule-day ${cell.lessons.some((l) => l.isLeave) ? "has-leave" : ""}">
          <div class="schedule-day-header">${cell.day}日 · ${cell.lessons[0]?.weekday || ""}</div>
          <div class="schedule-day-body">
            ${cell.lessons.map((lesson) => `
              <div class="lesson-pill ${lesson.isLeave ? "leave" : ""}">
                <div class="lesson-time">${escapeHtml(lesson.startTime)}–${escapeHtml(lesson.endTime)}</div>
                <div class="lesson-info">
                  <b>${escapeHtml(lesson.courseType.replace("Alevel", "AL"))}</b>
                  <span>${escapeHtml(lesson.teacher)} · ${formatNumber(lesson.duration)}h</span>
                </div>
                ${lesson.isLeave ? `<mark>${escapeHtml(lesson.leaveLabel)}</mark>` : ""}
              </div>
            `).join("")}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderFacultyList(teachers, startIndex = 0) {
  const teachersWithPortrait = teachers
    .map((teacher) => ({ teacher, image: portraitDataUri(teacher) }))
    .filter((entry) => entry.image);

  return teachersWithPortrait.map(({ teacher, image }, index) => {
    const displayName = teacher.actualName || teacher.name;
    return `
      <article class="faculty-card">
        <div class="faculty-photo">
          <img src="${image}" alt="${escapeHtml(displayName)}" />
        </div>
        <div class="faculty-body">
          <h3>${escapeHtml(displayName)}</h3>
          <p>${escapeHtml(teacherSummary(teacher))}</p>
          <div class="faculty-metrics">
            <div class="faculty-metric">
              <span class="faculty-metric-label">授课</span>
              <strong class="faculty-metric-value">${formatNumber(teacher.monthlyTotalDuration)}h</strong>
            </div>
            <div class="faculty-metric">
              <span class="faculty-metric-label">课次</span>
              <strong class="faculty-metric-value">${formatNumber(teacher.monthlyTotalLessons)}</strong>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

export function renderParentReportHtml(report) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.studentName)} ${escapeHtml(report.monthLabel)}课时费明细</title>
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
    .document {
      width: 390px;
      margin: 0 auto;
      background: var(--paper);
    }
    .page {
      position: relative;
      padding: 36px 20px;
      background: var(--ivory);
      overflow: hidden;
      border-bottom: 1px solid var(--hairline);
      box-shadow: 0 2px 12px rgba(20,24,33,.06);
    }
    .page::before {
      content: "";
      position: absolute;
      inset: 10px;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      pointer-events: none;
    }
    .page > * { position: relative; z-index: 1; }

    /* Cover */
    .cover { display: flex; flex-direction: column; justify-content: space-between; min-height: 680px; }
    .cover-brandline { display: flex; align-items: baseline; gap: 8px; margin-bottom: 24px; }
    .cover-brandline .brand-mark { font-family: "Songti SC", "STSong", serif; font-size: 22px; font-weight: 600; }
    .cover-brandline .brand-en { font-size: 10px; letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }
    .cover-main { text-align: center; margin-top: auto; margin-bottom: auto; padding: 40px 0; }
    .cover-student-name { font-family: "Songti SC", "STSong", serif; font-size: 52px; font-weight: 500; line-height: 1.05; margin: 0 0 20px; }
    .cover-ref-divider { width: 40px; height: 1px; background: var(--ink); margin: 0 auto 20px; opacity: .6; }
    .cover-report-title { font-size: 22px; font-weight: 300; letter-spacing: .04em; margin-bottom: 4px; }
    .cover-month-block { margin-top: 32px; }
    .cover-month-block strong { display: block; font-family: "Songti SC", "STSong", serif; font-size: 20px; font-weight: 500; }
    .cover-month-block span { display: block; margin-top: 6px; color: var(--muted); font-size: 14px; }
    .cover-footer { margin-top: auto; padding-top: 20px; border-top: 1px solid rgba(20,24,33,.25); display: flex; justify-content: space-between; align-items: flex-end; }
    .cover-footer-meta { font-size: 10px; color: var(--muted); letter-spacing: .16em; text-transform: uppercase; line-height: 1.8; }
    .cover-footer-date { font-size: 10px; color: var(--muted); letter-spacing: .12em; margin-top: 4px; }
    .cover-footer-amount { font-size: 28px; font-weight: 500; letter-spacing: 0; }

    /* Page head */
    .page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
    .kicker { color: var(--champagne); font-size: 10px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h2 { margin: 4px 0 0; font-family: "Songti SC", "STSong", serif; font-size: 26px; line-height: 1.2; font-weight: 600; }
    .page-num { color: var(--indigo); font-size: 11px; letter-spacing: .12em; }

    /* Stats */
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 20px 0; }
    .stat { border: 1px solid var(--hairline); border-radius: var(--radius); padding: 14px 12px; background: var(--platinum); }
    .stat span { display: block; font-size: 10px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; }
    .stat strong { display: block; margin-top: 6px; font-size: 20px; font-weight: 650; }

    /* Course cards */
    .course-list { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
    .course-card { border: 1px solid var(--hairline); border-radius: var(--radius); padding: 16px; background: white; }
    .course-card.leave { background: var(--champagne-soft); border-left: 3px solid var(--leave); }
    .course-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .course-name { font-size: 16px; font-weight: 700; line-height: 1.3; }
    .course-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .course-body { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--hairline); }
    .course-col { text-align: center; }
    .course-label { display: block; font-size: 10px; color: var(--muted); margin-bottom: 2px; }
    .course-val { font-size: 14px; font-weight: 600; }
    .course-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--hairline); }
    .course-status { font-size: 13px; }
    .course-payable { font-size: 20px; font-weight: 600; }
    .course-waived { margin-top: 8px; font-size: 11px; color: var(--leave); }

    /* Total row */
    .total-row { margin-top: 20px; padding-top: 16px; border-top: 2px solid var(--ink); }
    .total-row p { margin: 0 0 12px; color: var(--muted); font-size: 11px; line-height: 1.7; }
    .total-row strong { font-size: 28px; font-weight: 600; }
    .section-label { display: block; font-size: 10px; color: var(--muted); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }

    /* Schedule list */
    .schedule-list { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
    .schedule-day { border: 1px solid var(--hairline); border-radius: var(--radius); overflow: hidden; }
    .schedule-day-header { padding: 10px 14px; background: var(--platinum); font-size: 13px; font-weight: 600; color: var(--indigo-deep); }
    .schedule-day-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .lesson-pill { border-left: 3px solid var(--indigo); padding: 8px 10px; background: var(--indigo-soft); border-radius: 0 6px 6px 0; font-size: 12px; }
    .lesson-pill.leave { border-left-color: var(--leave); background: var(--champagne-soft); }
    .lesson-time { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
    .lesson-info { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .lesson-info b { font-size: 13px; font-weight: 650; }
    .lesson-info span { font-size: 11px; color: var(--muted); }
    mark { display: inline-block; margin-top: 4px; border-radius: 999px; padding: 2px 8px; background: rgba(164,82,63,.12); color: var(--leave); font-size: 10px; font-weight: 700; }
    .empty { color: var(--muted); font-size: 13px; text-align: center; padding: 20px 0; }

    /* Faculty */
    .faculty-section { margin-top: 20px; }
    .faculty-section:first-of-type { margin-top: 0; }
    .faculty-section h3 { margin: 0 0 12px; font-family: "Songti SC", "STSong", serif; font-size: 18px; font-weight: 600; }
    .faculty-list { display: flex; flex-direction: column; gap: 10px; }
    .faculty-card { display: flex; gap: 12px; padding: 12px; border: 1px solid var(--hairline); border-radius: var(--radius); background: white; }
    .faculty-photo { width: 52px; height: 52px; border-radius: 50%; overflow: hidden; flex-shrink: 0; background: #edf0f5; }
    .faculty-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .faculty-body { flex: 1; min-width: 0; }
    .faculty-body h3 { margin: 0 0 2px; font-family: "Songti SC", "STSong", serif; font-size: 15px; font-weight: 600; }
    .faculty-body p { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
    .faculty-metrics { display: flex; gap: 16px; margin-top: 8px; }
    .faculty-metric-label { display: block; font-size: 9px; color: var(--muted); }
    .faculty-metric-value { display: block; font-size: 13px; font-weight: 600; margin-top: 2px; }

    /* Closing */
    .closing { display: flex; flex-direction: column; justify-content: space-between; min-height: 680px; }
    .closing-brandline { display: flex; align-items: baseline; gap: 8px; }
    .closing-brandline .brand-mark { font-family: "Songti SC", "STSong", serif; font-size: 22px; font-weight: 600; }
    .closing-brandline .brand-en { font-size: 10px; letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }
    .closing-main { text-align: center; margin-top: auto; margin-bottom: auto; padding: 40px 0; }
    .closing-main h2 { font-family: "Songti SC", "STSong", serif; font-size: 44px; font-weight: 500; margin: 0 0 24px; letter-spacing: .06em; }
    .closing-divider { width: 40px; height: 1px; background: var(--champagne); margin: 0 auto 20px; }
    .closing-thanks { font-size: 12px; letter-spacing: .22em; color: var(--ink); margin-bottom: 12px; text-transform: uppercase; }
    .closing-note { font-size: 14px; color: var(--muted); margin: 0; line-height: 1.6; }
    .closing-footer { margin-top: auto; padding-top: 20px; border-top: 1px solid var(--hairline); display: flex; justify-content: space-between; align-items: flex-end; }
    .closing-footer-left { font-size: 12px; color: var(--muted); line-height: 1.6; }
    .closing-footer-right { font-size: 24px; font-weight: 500; }
  </style>
</head>
<body>
  <main class="document">

    <section class="page cover">
      <div class="cover-brandline">
        <div class="brand-mark">${escapeHtml(report.brandName)}</div>
        <div class="brand-en">${escapeHtml(report.brandEnglish)}</div>
      </div>
      <div class="cover-main">
        <h1 class="cover-student-name">${escapeHtml(report.studentName)}</h1>
        <div class="cover-ref-divider"></div>
        <div class="cover-report-title">课时费明细</div>
        <div class="cover-month-block">
          <strong>${escapeHtml(report.monthLabel)}</strong>
          <span>${formatNumber(report.totals.lessonCount)}节课 / ${formatNumber(report.totals.duration)}小时</span>
        </div>
      </div>
      <div class="cover-footer">
        <div>
          <div class="cover-footer-meta">Tuition Detail</div>
          <div class="cover-footer-date">${escapeHtml(formatMonthEnglish(report.month))}</div>
        </div>
        <div class="cover-footer-amount">${formatMoney(report.totals.payableAmount)}</div>
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
      <div class="stats">
        <div class="stat"><span>课时总额</span><strong>${formatMoney(report.totals.grossAmount)}</strong></div>
        <div class="stat"><span>请假未收</span><strong>${formatMoney(report.totals.discountAmount)}</strong></div>
        <div class="stat"><span>应付课时费</span><strong>${formatMoney(report.totals.payableAmount)}</strong></div>
        <div class="stat"><span>请假课程</span><strong>${formatNumber(report.totals.cancelledLessons)} 节</strong></div>
      </div>
      <div class="course-list">${renderCourseCards(report)}</div>
      <div class="total-row">
        <p>临时取消课程按原始课程表中的取消规则计入应付金额；例如 0h-70% 表示该请假课程收取 70% 课时费作为取消课程费，其余部分不计入应付。</p>
        <div>
          <span class="section-label">Total Payable</span>
          <strong>${formatMoney(report.totals.payableAmount)}</strong>
        </div>
      </div>
    </section>

    <section class="page">
      <header class="page-head">
        <div>
          <div class="kicker">Schedule</div>
          <h2>${escapeHtml(report.monthLabel)}课表</h2>
        </div>
        <div class="page-num">02 / 04</div>
      </header>
      ${renderScheduleList(report)}
    </section>

    <section class="page">
      <header class="page-head">
        <div>
          <div class="kicker">Faculty</div>
          <h2>师资团队</h2>
        </div>
        <div class="page-num">03 / 04</div>
      </header>
      <section class="faculty-section">
        <h3>授课老师</h3>
        <div class="faculty-list">${renderFacultyList(report.teachers)}</div>
      </section>
      <section class="faculty-section">
        <h3>更多老师</h3>
        <div class="faculty-list">${renderFacultyList(report.moreTeachers, report.teachers.length)}</div>
      </section>
    </section>

    <section class="page closing">
      <div class="closing-brandline">
        <div class="brand-mark">${escapeHtml(report.brandName)}</div>
        <div class="brand-en">${escapeHtml(report.brandEnglish)}</div>
      </div>
      <div class="closing-main">
        <h2>感谢信任</h2>
        <div class="closing-divider"></div>
        <div class="closing-thanks">THANK YOU</div>
        <p class="closing-note">教育是一场长期主义的同行</p>
      </div>
      <div class="closing-footer">
        <div class="closing-footer-left">
          <div>${escapeHtml(report.monthLabel)}</div>
          <div>课时费明细</div>
        </div>
        <div class="closing-footer-right">${formatMoney(report.totals.payableAmount)}</div>
      </div>
    </section>

  </main>
</body>
</html>`;
}

export function writeParentReport({
  input = INPUT,
  output = OUTPUT,
  student = "Ivy-2488",
  month = "2026-03",
} = {}) {
  const inputPath = path.resolve(PROJECT_ROOT, input);
  const outputPath = path.resolve(PROJECT_ROOT, output);
  const csv = fs.readFileSync(inputPath, "utf8");
  const report = buildParentReportData(csv, { student, month });
  const html = renderParentReportHtml(report);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
  return outputPath;
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputPath = writeParentReport();
  console.log(`Parent report written to ${outputPath}`);
}
