export const CANCELLATION_RATES = {
  "0h-70%": 0.7,
  "2h-50%": 0.5,
  "6h-30%": 0.3,
};

export const NORMAL_STATUS = "正常上课";

const MISSING_TEACHER = "未填写老师";
const MISSING_STUDENT = "未填写学生";
const MISSING_COURSE = "未填写课程类型";
const MISSING_TEACHING_TYPE = "未填写授课类型";

export const ISSUE_LABELS = {
  missing_student: "缺少学生",
  missing_teacher: "缺少老师",
  missing_course_type: "缺少课程类型",
  missing_teaching_type: "缺少授课类型",
  missing_start_time: "缺少上课时间",
  invalid_start_time: "上课时间无法解析",
  missing_unit_price: "缺少课程单价",
  missing_duration: "缺少课程时长",
  missing_amount: "缺少课程总价格",
  unknown_cancellation: "未知取消标记",
  amount_mismatch: "金额与规则不一致",
  not_reportable: "未进入计费汇总",
};

export function cleanText(value) {
  if (value == null) return "";
  return String(value).replace(/\r/g, " ").replace(/\n/g, " ").trim();
}

export function parseCancellationRate(label) {
  return CANCELLATION_RATES[cleanText(label)] ?? null;
}

export function parseNumber(value) {
  const text = cleanText(value).replace(/,/g, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function parseDateTime(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null;
  }
  return date;
}

export function splitStudents(studentText) {
  return cleanText(studentText)
    .split(/[,，、]/)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function roundNumber(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function sum(values) {
  return roundNumber(values.reduce((total, value) => total + Number(value || 0), 0)) || 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  if (!date) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTime(date) {
  if (!date) return "";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function monthKey(date) {
  if (!date) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function weekday(date) {
  if (!date) return "";
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

function priceLabel(prices) {
  const unique = [...new Set(prices.filter((price) => price != null).map((price) => roundNumber(price)))].sort((a, b) => a - b);
  if (!unique.length) return "缺失";
  return unique.map((price) => `¥${price.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`).join(" / ");
}

function addIssue(issues, code, rawRow, message) {
  issues.push({ code, label: ISSUE_LABELS[code], message, rawRow });
}

export function normalizeRow(row, rawRowNumber) {
  const courseType = cleanText(row["课程类型"]);
  const teacher = cleanText(row["老师"]);
  const student = cleanText(row["学生"]);
  const teachingType = cleanText(row["授课类型"]);
  const cancellation = cleanText(row["临时取消"]);
  const startDate = parseDateTime(row["上课时间"]);
  const endDate = parseDateTime(row["下课时间"]);
  const unitPrice = parseNumber(row["课程单价"]);
  const duration = parseNumber(row["课程时长"]);
  const sourceAmount = parseNumber(row["课程总价格"]);
  const cancellationRate = parseCancellationRate(cancellation);
  const isCancelled = Boolean(cancellation);
  const issues = [];

  let expectedAmount = null;
  if (unitPrice != null && duration != null && (!isCancelled || cancellationRate != null)) {
    expectedAmount = unitPrice * duration * (isCancelled ? cancellationRate : 1);
  }

  const amount = sourceAmount ?? expectedAmount ?? 0;
  const amountDiff = sourceAmount != null && expectedAmount != null ? sourceAmount - expectedAmount : null;

  if (!student) addIssue(issues, "missing_student", rawRowNumber, "学生为空，无法准确进入学生收费视图。");
  if (!teacher) addIssue(issues, "missing_teacher", rawRowNumber, "老师为空，老师收入视图无法归属。");
  if (!courseType) addIssue(issues, "missing_course_type", rawRowNumber, "课程类型为空，汇总会归入未填写课程类型。");
  if (!teachingType) addIssue(issues, "missing_teaching_type", rawRowNumber, "授课类型为空，汇总会归入未填写授课类型。");
  if (!cleanText(row["上课时间"])) {
    addIssue(issues, "missing_start_time", rawRowNumber, "上课时间为空，无法按月份筛选。");
  } else if (!startDate) {
    addIssue(issues, "invalid_start_time", rawRowNumber, `上课时间无法解析：${cleanText(row["上课时间"])}`);
  }
  if (unitPrice == null && (sourceAmount || 0) !== 0) addIssue(issues, "missing_unit_price", rawRowNumber, "存在收费金额但课程单价为空。");
  if (duration == null) addIssue(issues, "missing_duration", rawRowNumber, "课程时长为空或无法解析。");
  if (sourceAmount == null) addIssue(issues, "missing_amount", rawRowNumber, "课程总价格为空或无法解析。");
  if (isCancelled && cancellationRate == null) addIssue(issues, "unknown_cancellation", rawRowNumber, `临时取消标记未配置收费比例：${cancellation}`);
  if (amountDiff != null && Math.abs(amountDiff) > 0.01) {
    addIssue(issues, "amount_mismatch", rawRowNumber, `原表金额 ${sourceAmount} 与规则计算 ${roundNumber(expectedAmount)} 相差 ${roundNumber(amountDiff)}。`);
  }

  const reportable = Boolean(startDate) && (Boolean(teacher) || unitPrice != null || Math.abs(sourceAmount || 0) > 0.000001 || Boolean(cancellation));
  if (!reportable) addIssue(issues, "not_reportable", rawRowNumber, "没有老师、单价、收费金额或取消标记，已排除在计费汇总之外。");

  return {
    rawRow: rawRowNumber,
    courseId: cleanText(row["学员课程ID"]),
    teacherCourseId: cleanText(row["老师课程ID"]),
    scheduleId: cleanText(row["日程 ID"]),
    month: monthKey(startDate),
    date: formatDate(startDate),
    weekday: weekday(startDate),
    startTime: formatTime(startDate),
    endTime: formatTime(endDate),
    student,
    studentList: splitStudents(student),
    teacher,
    courseType,
    teachingType,
    location: cleanText(row["上课地点"]),
    unitPrice: roundNumber(unitPrice),
    duration: roundNumber(duration),
    sourceAmount: roundNumber(sourceAmount),
    expectedAmount: roundNumber(expectedAmount),
    amount: roundNumber(amount) || 0,
    amountDiff: roundNumber(amountDiff),
    cancellationRaw: cancellation,
    cancellationStatus: isCancelled ? cancellation : NORMAL_STATUS,
    cancellationRate,
    isCancelled,
    reportable,
    issues,
  };
}

export function aggregateRecords(records, view, month, entity) {
  const isStudentView = view === "student";
  const matched = records.filter((record) => {
    if (!record.reportable || record.month !== month) return false;
    return isStudentView ? record.studentList.includes(entity) : record.teacher === entity;
  });
  const grouped = new Map();

  for (const record of matched) {
    const counterparty = isStudentView ? record.teacher || MISSING_TEACHER : record.student || MISSING_STUDENT;
    const courseType = record.courseType || MISSING_COURSE;
    const teachingType = record.teachingType || MISSING_TEACHING_TYPE;
    const key = JSON.stringify([counterparty, courseType, teachingType, record.cancellationStatus]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }

  const groups = [...grouped.entries()].map(([key, rows]) => {
    const [counterparty, courseType, teachingType, cancellationStatus] = JSON.parse(key);
    const cancelledRows = rows.filter((row) => row.isCancelled);
    const unitPrices = [...new Set(rows.map((row) => row.unitPrice).filter((price) => price != null))].sort((a, b) => a - b);
    return {
      counterparty,
      courseType,
      teachingType,
      cancellationStatus,
      lessons: rows.length,
      duration: sum(rows.map((row) => row.duration)),
      cancelledDuration: sum(cancelledRows.map((row) => row.duration)),
      amount: sum(rows.map((row) => row.amount)),
      cancelledAmount: sum(cancelledRows.map((row) => row.amount)),
      unitPrices,
      unitPriceLabel: priceLabel(unitPrices),
      rawRows: rows.map((row) => row.rawRow).sort((a, b) => a - b),
      issueCount: rows.reduce((total, row) => total + row.issues.length, 0),
    };
  });

  groups.sort((a, b) => (
    a.counterparty.localeCompare(b.counterparty, "zh-CN") ||
    a.courseType.localeCompare(b.courseType, "zh-CN") ||
    a.teachingType.localeCompare(b.teachingType, "zh-CN") ||
    a.cancellationStatus.localeCompare(b.cancellationStatus, "zh-CN")
  ));

  const qualityIssues = matched.flatMap((record) => record.issues);

  return {
    view,
    month,
    entity,
    subjectLabel: isStudentView ? "学生" : "老师",
    counterpartyLabel: isStudentView ? "老师" : "学生",
    groups,
    totals: {
      lessons: matched.length,
      duration: sum(matched.map((record) => record.duration)),
      amount: sum(matched.map((record) => record.amount)),
      cancelledLessons: matched.filter((record) => record.isCancelled).length,
      cancelledDuration: sum(matched.filter((record) => record.isCancelled).map((record) => record.duration)),
      cancelledAmount: sum(matched.filter((record) => record.isCancelled).map((record) => record.amount)),
      issueCount: qualityIssues.length,
    },
    qualityIssues,
  };
}

export function buildReportData(records, sourceName = "") {
  const months = [...new Set(records.map((record) => record.month).filter(Boolean))].sort();
  const currentMonth = new Date();
  const currentMonthKey = monthKey(currentMonth);
  const defaultMonth = months.includes(currentMonthKey) ? currentMonthKey : months.at(-1) || "";
  const students = [...new Set(records.flatMap((record) => record.studentList))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const teachers = [...new Set(records.map((record) => record.teacher).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const views = { student: {}, teacher: {} };
  const entityOptions = { student: {}, teacher: {} };

  for (const [view, entities] of [["student", students], ["teacher", teachers]]) {
    for (const month of months) {
      views[view][month] = {};
      const options = [];
      for (const entity of entities) {
        const result = aggregateRecords(records, view, month, entity);
        if (result.totals.lessons === 0) continue;
        views[view][month][entity] = result;
        options.push({
          name: entity,
          amount: result.totals.amount,
          duration: result.totals.duration,
          lessons: result.totals.lessons,
          cancelledLessons: result.totals.cancelledLessons,
        });
      }
      options.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));
      entityOptions[view][month] = options;
    }
  }

  const recordsByRow = Object.fromEntries(records.map((record) => [String(record.rawRow), record]));
  const qualityIssues = records.flatMap((record) => record.issues.map((issue) => ({
    ...issue,
    month: record.month,
    student: record.student,
    teacher: record.teacher,
    courseType: record.courseType,
    date: record.date,
    amount: record.amount,
  })));
  const issueCounts = {};
  for (const issue of qualityIssues) issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;

  return {
    metadata: {
      sourcePath: sourceName,
      generatedAt: new Date().toISOString(),
      totalRows: records.length,
      reportableRows: records.filter((record) => record.reportable).length,
      excludedRows: records.filter((record) => !record.reportable).length,
      knownCancellationRates: CANCELLATION_RATES,
      defaultMonth,
    },
    months,
    defaultView: "student",
    views,
    entityOptions,
    recordsByRow,
    qualityIssues,
    issueCounts,
    issueLabels: ISSUE_LABELS,
  };
}

export function parseCsv(csvText) {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map((header) => cleanText(header));
  return rows.slice(1).map((values) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = values[index] ?? "";
    });
    return object;
  });
}

export function buildReportFromCsv(csvText, sourceName = "") {
  const rows = parseCsv(csvText);
  const records = rows.map((row, index) => normalizeRow(row, index + 2));
  return buildReportData(records, sourceName);
}
