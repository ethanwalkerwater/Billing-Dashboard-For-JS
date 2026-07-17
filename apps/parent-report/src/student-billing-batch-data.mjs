import { cleanText, normalizeRow, parseCsv, parseNumber } from "@jingshi/billing-core";

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

    return {
      sourceName,
      sourceRow: index + 2,
      studentName,
      displayStudentName: cleanStudentName(studentName),
      month: cleanText(row["月份"]),
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

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function formatIntegerAmount(value) {
  return Math.floor(Number(value || 0)).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
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
  const lookup = new Map(rows.map((row, index) => {
    const rawRow = index + 2;
    return [rawRow, normalizeRow(row, rawRow)];
  }));
  const byStudentMonth = new Map();

  for (const record of lookup.values()) {
    if (!record.month) continue;
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
    unitPriceLabel: row.unitPrice == null
      ? "缺失"
      : formatIntegerAmount(row.unitPrice),
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
    const lessons = scheduleRecordsForStudentMonth(scheduleLookup, studentId, month, rows).map(lessonFromRecord);
    const activeTeacherNames = [...new Set(lessons.map((lesson) => lesson.teacher).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    return {
      brandName: "菁仕",
      brandEnglish: "King's Academy",
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
