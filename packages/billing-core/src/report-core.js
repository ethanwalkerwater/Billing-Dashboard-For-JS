export const CANCELLATION_RATES = {
  "0h-70%": 0.7,
  "2h-50%": 0.5,
  "6h-30%": 0.3,
  // 学生提前 6 小时以上自助取消：保留课表记录但不收费，也不进入问题检查
  "提前取消-0%": 0,
  "学生病假-0%": 0,
};

// 「价格优惠」选项原文 → 收费比例；只对上课时间（北京时间文本）>= 生效日的课计入。须与飞书「课程总价格」公式一致。
export const DISCOUNT_RATES = {
  "赠课-免费": 0,
  "试听-80%": 0.8,
  "模拟考试-0%": 0,
};

export const DISCOUNT_EFFECTIVE_DATE = "2026-11-01";

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
  unknown_discount: "未知优惠标记",
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

export function parseDiscountRate(label) {
  const key = cleanText(label);
  return Object.hasOwn(DISCOUNT_RATES, key) ? DISCOUNT_RATES[key] : null;
}

export function parseNumber(value) {
  const text = cleanText(value).replace(/,/g, "");
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function matchDateTime(value) {
  return cleanText(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
}

// 只用 CSV 原文的年月日拼 YYYY-MM-DD，不经过 Date，结果与本机时区无关
function dayKey(value) {
  const match = matchDateTime(value);
  return match ? `${match[1]}-${pad2(match[2])}-${pad2(match[3])}` : "";
}

export function parseDateTime(value) {
  const match = matchDateTime(value);
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

function toCents(value) {
  return Math.round(roundNumber(value * 100));
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
  return unique.map((price) => price.toLocaleString("zh-CN", { maximumFractionDigits: 2 })).join(" / ");
}

function cancellationOrder(status) {
  return status === NORMAL_STATUS ? 0 : 1;
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
  const discountRaw = cleanText(row["价格优惠"]);
  const discountApplies = Boolean(discountRaw) && Boolean(startDate) && dayKey(row["上课时间"]) >= DISCOUNT_EFFECTIVE_DATE;
  const discountStatus = discountApplies ? discountRaw : "";
  const discountRate = discountApplies ? parseDiscountRate(discountRaw) : null;
  const isDiscounted = Boolean(discountStatus);
  const cancelFactor = isCancelled ? cancellationRate : 1;
  const discountFactor = isDiscounted ? discountRate : 1;
  // 任一比例未知时整体为 null，不能让 null 参与乘法（JS 里 x * null = 0）
  const chargeRate = cancelFactor == null || discountFactor == null ? null : cancelFactor * discountFactor;
  const statusLabel = [isCancelled ? cancellation : "", discountStatus].filter(Boolean).join(" · ") || NORMAL_STATUS;
  const issues = [];

  let expectedAmount = null;
  if (unitPrice != null && duration != null && chargeRate != null) {
    expectedAmount = unitPrice * duration * chargeRate;
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
  if (isDiscounted && discountRate == null) addIssue(issues, "unknown_discount", rawRowNumber, `价格优惠标记未配置收费比例：${discountRaw}`);
  // 逐节按整数分比，容差 1 分；直接比浮点差会让「正好差 1 分」拦不拦随机（80.01 拦、8.01 不拦）
  if (amountDiff != null && Math.abs(toCents(sourceAmount) - toCents(expectedAmount)) > 1) {
    addIssue(issues, "amount_mismatch", rawRowNumber, `原表金额 ${sourceAmount} 与规则计算 ${roundNumber(expectedAmount)} 相差 ${roundNumber(amountDiff)}。`);
  }

  const reportable = Boolean(startDate) && (Boolean(teacher) || unitPrice != null || Math.abs(sourceAmount || 0) > 0.000001 || Boolean(cancellation) || Boolean(discountStatus));
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
    discountRaw,
    discountApplies,
    discountStatus,
    discountRate,
    isDiscounted,
    chargeRate: roundNumber(chargeRate),
    statusLabel,
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
    const key = JSON.stringify([counterparty, courseType, teachingType, record.statusLabel]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }

  const groups = [...grouped.entries()].map(([key, rows]) => {
    const [counterparty, courseType, teachingType, statusLabel] = JSON.parse(key);
    const cancelledRows = rows.filter((row) => row.isCancelled);
    const unitPrices = [...new Set(rows.map((row) => row.unitPrice).filter((price) => price != null))].sort((a, b) => a - b);
    return {
      counterparty,
      courseType,
      teachingType,
      statusLabel,
      cancellationStatus: rows[0].cancellationStatus,
      discountStatus: rows[0].discountStatus,
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
    cancellationOrder(a.statusLabel) - cancellationOrder(b.statusLabel) ||
    a.counterparty.localeCompare(b.counterparty, "zh-CN") ||
    a.courseType.localeCompare(b.courseType, "zh-CN") ||
    a.teachingType.localeCompare(b.teachingType, "zh-CN") ||
    a.statusLabel.localeCompare(b.statusLabel, "zh-CN")
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
      knownDiscountRates: DISCOUNT_RATES,
      discountEffectiveDate: DISCOUNT_EFFECTIVE_DATE,
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
