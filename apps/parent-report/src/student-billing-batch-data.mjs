import { NORMAL_STATUS, cleanText, normalizeRow, parseCancellationRate, parseCsv, parseDiscountRate, parseNumber } from "@jingshi/billing-core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function cleanStudentName(value) {
  return cleanText(value)
    .replace(/-\d{4}$/u, "")
    .replace(/-$/u, "")
    .trim();
}

function studentMatchKey(value) {
  return cleanStudentName(value).replace(/\s+/g, " ").toLowerCase();
}

export function safeFileName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "未命名学生";
}

export function parseRawRows(value) {
  const text = cleanText(value);
  if (!text) return [];
  return text
    .split(/\s+/)
    .map((part) => Number(part))
    .filter(Number.isFinite);
}

export function parseCompleteBillingCsv(csvText, sourceName = "") {
  return parseCsv(csvText).map((row, index) => {
    const studentName = cleanText(row["学生名"]);
    const unitPrice = parseNumber(row["课程单价（¥）"]);
    const grossAmount = parseNumber(row["总金额（¥）"]);
    const payableAmount = parseNumber(row["实际金额（¥）"]);
    // 导出 CSV 的「价格优惠」只在生效（11-01 起）时有值；旧 CSV 没有这一列
    const promoLabel = cleanText(row["价格优惠"]);
    const promoRate = promoLabel ? parseDiscountRate(promoLabel) : 1;

    return {
      sourceName,
      sourceRow: index + 2,
      studentName,
      displayStudentName: cleanStudentName(studentName),
      month: cleanText(row["月份"]),
      teacher: cleanText(row["老师"]),
      courseType: cleanText(row["课程类型"]),
      // 课时账单导出用「未填写授课类型」占位，家长报告里按空值显示
      teachingType: cleanText(row["授课类型"]).replace(/^未填写授课类型$/u, ""),
      status: cleanText(row["取消/上课状态"]) || "正常上课",
      promoLabel,
      promoRate,
      promoUnknown: promoRate == null,
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

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

// 家长明细金额四舍五入到元；先按分取整去掉浮点误差（279.5 → 280）
export function roundYuan(value) {
  return Math.round(roundMoney(value));
}

// 家长能看到的单价、金额标签都走这里：四舍五入到元
export function formatIntegerAmount(value) {
  return roundYuan(value).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function monthLabel(month) {
  const [year, value] = String(month).split("-");
  return `${year}年${Number(value)}月`;
}

function billingPeriodLabel(months) {
  const ranges = [];
  for (const month of months) {
    const [year, value] = month.split("-").map(Number);
    const ordinal = year * 12 + value;
    const previous = ranges.at(-1);
    if (previous && ordinal === previous.ordinal + 1) {
      previous.end = month;
      previous.ordinal = ordinal;
    } else {
      ranges.push({ start: month, end: month, ordinal });
    }
  }
  return ranges.map(({ start, end }) => {
    if (start === end) return monthLabel(start);
    const [startYear, startMonth] = start.split("-");
    const [endYear, endMonth] = end.split("-");
    return startYear === endYear
      ? `${startYear}年${Number(startMonth)}-${Number(endMonth)}月`
      : `${monthLabel(start)}-${monthLabel(end)}`;
  }).join("、");
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
  const lookup = new Map(rows.map((row, index) => {
    const rawRow = index + 2;
    return [rawRow, normalizeRow(row, rawRow)];
  }));
  const byStudentMonth = new Map();

  for (const record of lookup.values()) {
    if (!record.month || !record.reportable) continue;
    for (const student of record.studentList || []) {
      const studentKey = studentMatchKey(student);
      if (!studentKey) continue;
      const key = JSON.stringify([studentKey, record.month]);
      if (!byStudentMonth.has(key)) byStudentMonth.set(key, []);
      byStudentMonth.get(key).push(record);
    }
  }

  lookup.byStudentMonth = byStudentMonth;
  return lookup;
}

// 折扣列统一「类型 + 收多少」，组合用「 · 」连接，如「请假 收 70% · 试听 收 80%」
function chargeText(percent) {
  const value = Math.round(Number(percent) * 10) / 10;
  return value === 0 ? "免费" : `收 ${value}%`;
}

export function leaveNote(status, percent) {
  return `${String(status || "").includes("病假") ? "病假" : "请假"} ${chargeText(percent)}`;
}

// 未知优惠不会进家长 PDF（validateReport 报错、渲染时拦截），这里只留原文兜底
function promoNote(label, rate) {
  if (!label) return "";
  if (rate == null) return label;
  return `${label.split("-")[0]} ${chargeText(rate * 100)}`;
}

export function composeBillingNote(leave, promoLabel, promoRate) {
  return [leave, promoNote(promoLabel, promoRate)].filter(Boolean).join(" · ") || "—";
}

function billingNote(row) {
  let leave = "";
  if (row.status !== "正常上课") {
    const match = row.status.match(/(\d+)%/);
    leave = match ? leaveNote(row.status, match[1]) : row.status;
  }
  return composeBillingNote(leave, row.promoLabel, row.promoRate);
}

function formatMoneyText(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

// 优惠行的总金额要和「单价 × 时长 × 取消比例 × 优惠比例」对得上；飞书公式没改时导出的是全价，说明和金额会矛盾
function promoAmountMismatch(row) {
  if (!row.promoLabel || row.promoRate == null || row.unitPrice == null) return null;
  const isLeave = row.status !== NORMAL_STATUS;
  const cancelRate = isLeave ? parseCancellationRate(row.status) : 1;
  if (cancelRate == null) return null;
  const ruleAmount = roundMoney(row.unitPrice * row.duration * cancelRate * row.promoRate);
  const sourceAmount = roundMoney(row.grossAmount);
  if (Math.abs(ruleAmount - sourceAmount) <= 0.01) return null;
  return { label: [isLeave ? row.status : "", row.promoLabel].filter(Boolean).join(" · "), ruleAmount, sourceAmount };
}

function buildCourseLine(row) {
  // 优惠课导出的总金额已是优惠后金额，原价按单价 × 时长算，和网页编辑后一致
  const grossAmount = row.promoLabel && row.unitPrice != null
    ? row.unitPrice * row.duration
    : row.grossAmount;
  return {
    month: row.month,
    teacher: row.teacher,
    courseType: row.courseType,
    teachingType: row.teachingType,
    status: row.status,
    isLeave: row.status !== "正常上课",
    promoLabel: row.promoLabel,
    promoRate: row.promoRate,
    promoUnknown: row.promoUnknown,
    amountMismatch: promoAmountMismatch(row),
    duration: row.duration,
    cancelledDuration: row.cancelledDuration,
    unitPrice: row.unitPrice,
    unitPriceLabel: row.unitPrice == null
      ? "缺失"
      : formatIntegerAmount(row.unitPrice),
    discountRate: row.discountRate,
    discountReason: row.discountReason,
    grossAmount: roundMoney(grossAmount),
    payableAmount: roundMoney(row.payableAmount),
    discountAmount: roundMoney(grossAmount - row.payableAmount),
    billingNote: billingNote(row),
    rawRows: row.rawRows,
  };
}

function lessonFromRecord(record) {
  const cancelLabel = record.isCancelled ? record.cancellationRaw : "";
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
    // 日历标签和折扣列同一套说法；原文留在 cancelLabel / promoLabel 给 reportBlockers 校验
    cancelLabel,
    leaveLabel: cancelLabel && (record.cancellationRate == null ? cancelLabel : leaveNote(cancelLabel, record.cancellationRate * 100)),
    isPromo: Boolean(record.isDiscounted),
    promoLabel: record.discountStatus || "",
    promoText: promoNote(record.discountStatus, record.discountRate),
    grossAmount: roundMoney(grossAmount),
    payableAmount: roundMoney(payableAmount),
    location: record.location,
  };
}

const unconfigured = (kind, label) => `${kind}「${label}」还没配置收费比例，请先联系开发`;

// 家长 PDF 的唯一闸门：网页校验（单个、预览、批量）和渲染函数（API、命令行）都调这里。
// 比例从原文重新查，不信任传进来的标记字段；row 是校对表的行号，课表里的课对到同老师同课程的那一行
export function reportBlockers(report) {
  const lines = report.courseLines || [];
  const blockers = [];
  const add = (row, message) => {
    if (!blockers.some((item) => item.row === row && item.message === message)) blockers.push({ row, message });
  };
  lines.forEach((line, index) => {
    const row = index + 1;
    if (line.status && line.status !== NORMAL_STATUS && parseCancellationRate(line.status) == null) add(row, unconfigured("取消标记", line.status));
    if (line.promoLabel && parseDiscountRate(line.promoLabel) == null) add(row, unconfigured("价格优惠", line.promoLabel));
    const mismatch = line.amountMismatch;
    if (mismatch) add(row, `「${mismatch.label}」这节按规则应收 ${formatMoneyText(mismatch.ruleAmount)}，课程表里填的是 ${formatMoneyText(mismatch.sourceAmount)}，请先核对课程表`);
  });
  for (const lesson of report.lessons || []) {
    const sameCourse = lines.filter((line) => {
      const source = line._baseline || line;
      return source.teacher === lesson.teacher
        && source.courseType === lesson.courseType
        && source.teachingType === lesson.teachingType
        && (!source.month || String(lesson.date || "").startsWith(`${source.month}-`));
    });
    const sameStatus = sameCourse.filter((line) => line.status === (lesson.cancelLabel || NORMAL_STATUS));
    const line = sameStatus.find((item) => (item.promoLabel || "") === (lesson.promoLabel || "")) || sameStatus[0] || sameCourse[0];
    const row = line ? lines.indexOf(line) + 1 : null;
    if (lesson.isLeave && lesson.cancelLabel && parseCancellationRate(lesson.cancelLabel) == null) add(row, unconfigured("取消标记", lesson.cancelLabel));
    if (lesson.isPromo && parseDiscountRate(lesson.promoLabel) == null) add(row, unconfigured("价格优惠", lesson.promoLabel));
  }
  return blockers;
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
  return { month, monthLabel: monthLabel(month), weekdays: WEEKDAYS, cells };
}

function scheduleRecordsForStudentMonth(scheduleLookup, studentId, month, billingRows) {
  const studentKey = studentMatchKey(studentId);
  const byStudentMonth = scheduleLookup?.byStudentMonth;
  if (byStudentMonth) {
    return [...(byStudentMonth.get(JSON.stringify([studentKey, month])) || [])]
      .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  }

  return [...new Set(billingRows.flatMap((row) => row.rawRows))]
    .map((rawRow) => scheduleLookup.get(rawRow))
    .filter(Boolean)
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
}

export function buildStudentReports(billingRows, scheduleLookup) {
  const byStudent = new Map();
  for (const row of billingRows) {
    if (!byStudent.has(row.studentName)) byStudent.set(row.studentName, []);
    byStudent.get(row.studentName).push(row);
  }

  return [...byStudent.entries()].map(([studentId, rows]) => {
    rows = [...rows].sort((a, b) => a.month.localeCompare(b.month));
    const months = [...new Set(rows.map((row) => row.month))];
    const month = months.length === 1 ? months[0] : `${months[0]}_${months.at(-1)}`;
    const courseLines = rows.map(buildCourseLine);
    const lessons = months.flatMap((value) => (
      scheduleRecordsForStudentMonth(scheduleLookup, studentId, value, rows.filter((row) => row.month === value))
        .map(lessonFromRecord)
    ));
    const activeTeacherNames = [...new Set(lessons.map((lesson) => lesson.teacher).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    return {
      brandName: "菁仕",
      brandEnglish: "King's Academy",
      studentId,
      studentName: cleanStudentName(studentId),
      month,
      months,
      monthLabel: billingPeriodLabel(months),
      monthEnglish: months.map(formatMonthEnglish).join(" / "),
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
      calendars: months.map((value) => buildCalendar(value, lessons)),
      activeTeacherNames,
    };
  });
}
