import { DISCOUNT_EFFECTIVE_DATE, ISSUE_LABELS, NORMAL_STATUS, cleanText, normalizeRow, parseCancellationRate, parseCsv, parseDiscountRate, parseNumber } from "@jingshi/billing-core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function cleanStudentName(value) {
  return cleanText(value)
    .replace(/-\d{4}$/u, "")
    .replace(/-$/u, "")
    .trim();
}

// 按带编号的完整标识匹配课表：去掉编号后同名的两个学生（演示同-9901 / 9902）不能混课
function studentMatchKey(value) {
  return cleanText(value).replace(/-$/u, "").trim().replace(/\s+/g, " ").toLowerCase();
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

// 手填「折扣（%）」：90 → 「9 折」
export function discountText(percent) {
  return `${Number(percent) / 10} 折`;
}

// 优惠课带手填折扣时说明里也写出来（「试听 收 80% · 9 折」），不然说明和金额对不上；请假行不乘手填折扣
export function composeBillingNote(leave, promoLabel, promoRate, manualPercent = null) {
  const manual = !leave && promoLabel && manualPercent != null && Number.isFinite(Number(manualPercent)) && Number(manualPercent) !== 100
    ? discountText(manualPercent)
    : "";
  return [leave, promoNote(promoLabel, promoRate), manual].filter(Boolean).join(" · ") || "—";
}

function billingNote(row) {
  let leave = "";
  if (row.status !== "正常上课") {
    const match = row.status.match(/(\d+)%/);
    leave = match ? leaveNote(row.status, match[1]) : row.status;
  }
  return composeBillingNote(leave, row.promoLabel, row.promoRate, row.discountRate);
}

function formatMoneyText(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// 金额核对不自己算：直接用 billing-core 逐节判出的「金额与规则不一致」（和课时收费同一口径）。
// 只拦生效日（11-01）起的课，旧月份照常出；取消 / 优惠课单价或时长读不出时也拦（没法核对，说明会和金额矛盾）
function amountIssueOf(record) {
  if (!record.date || record.date < DISCOUNT_EFFECTIVE_DATE) return null;
  const codes = record.issues.map((issue) => issue.code);
  if (codes.includes("amount_mismatch")) {
    return { code: "amount_mismatch", ruleAmount: record.expectedAmount, sourceAmount: record.sourceAmount };
  }
  // 免费课（比例 0）不需要单价、时长：应付是 0 就放行，不是 0 按「应收 ¥0」拦（容差 1 分，同 billing-core）
  if (record.chargeRate === 0) {
    const sourceAmount = Number(record.sourceAmount || 0);
    return Math.abs(Math.round(sourceAmount * 100)) > 1 ? { code: "amount_mismatch", ruleAmount: 0, sourceAmount } : null;
  }
  // 收部分费用（试听 80%、请假 70% 等）缺单价或时长：没法核对
  const missing = ["missing_unit_price", "missing_duration"].find((code) => codes.includes(code));
  if (missing && record.chargeRate != null && record.chargeRate !== 1) return { code: missing };
  return null;
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
    // 收费 CSV 导出时的原值，校对页改不动：reportBlockers 拿它和课表核对
    exportedAmount: roundMoney(row.grossAmount),
    exportedDuration: row.duration,
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
    amountIssue: amountIssueOf(record),
    location: record.location,
  };
}

const unconfigured = (kind, label) => `${kind}「${label}」还没配置收费比例，请先联系开发`;

function lessonWhen(lesson) {
  const [, month, day] = String(lesson.date || "").split("-").map(Number);
  return month ? `${month}月${day}日 ${lesson.startTime || ""}`.trim() : "";
}

function lessonText(lesson) {
  return [lesson.leaveLabel, lesson.promoText].filter(Boolean).join(" · ") || "正常课程";
}

// 家长 PDF 的唯一闸门：网页校验（单个、预览、批量）和渲染函数（API、命令行）都调这里。
// 未知比例从原文重新查，不信任传进来的标记字段；提示写上课日期和时间，同一问题的几节合成一条
export function reportBlockers(report) {
  const lessons = report.lessons || [];
  const groups = new Map();
  const add = (key, whens, build, amounts = {}) => {
    if (!groups.has(key)) groups.set(key, { whens: [], ruleAmount: 0, sourceAmount: 0, build });
    const group = groups.get(key);
    for (const when of whens) if (when && !group.whens.includes(when)) group.whens.push(when);
    group.ruleAmount += Number(amounts.ruleAmount || 0);
    group.sourceAmount += Number(amounts.sourceAmount || 0);
  };
  const checkLabels = (status, promoLabel, whens) => {
    if (status && status !== NORMAL_STATUS && parseCancellationRate(status) == null) {
      const message = unconfigured("取消标记", status);
      add(message, whens, () => message);
    }
    if (promoLabel && parseDiscountRate(promoLabel) == null) {
      const message = unconfigured("价格优惠", promoLabel);
      add(message, whens, () => message);
    }
  };
  for (const lesson of lessons) {
    const whens = [lessonWhen(lesson)];
    checkLabels(lesson.isLeave ? lesson.cancelLabel : "", lesson.isPromo ? lesson.promoLabel : "", whens);
    const issue = lesson.amountIssue;
    if (!issue) continue;
    const label = lessonText(lesson);
    if (issue.code === "amount_mismatch") {
      add(JSON.stringify([issue.code, lesson.teacher, lesson.courseType, label]), whens, (group) => (
        `「${label}」${group.whens.length > 1 ? "这几节" : "这节"}按规则应收 ${formatMoneyText(group.ruleAmount)}，课程表里填的是 ${formatMoneyText(group.sourceAmount)}，请先核对课程表`
      ), issue);
    } else {
      add(JSON.stringify([issue.code, lesson.teacher, lesson.courseType, label]), whens, (group) => (
        `「${label}」${group.whens.length > 1 ? "这几节" : "这节"}${ISSUE_LABELS[issue.code]}，没法核对金额，请先核对课程表`
      ));
    }
  }
  // 收费 CSV 里的标签也查一遍（课表里没有这几节时也拦）；日期取这一行「原始行」对应的课
  const effectiveMonth = DISCOUNT_EFFECTIVE_DATE.slice(0, 7);
  for (const line of report.courseLines || []) {
    const rawRows = new Set(line.rawRows || []);
    const matched = lessons.filter((lesson) => rawRows.has(lesson.rawRow));
    const whens = matched.map(lessonWhen);
    checkLabels(line.status, line.promoLabel, whens);
    // 11-01 起收费 CSV 每行的金额要和它原始行那几节课表金额合计对上（按分比，容差 1 分）：
    // 课表改了、收费 CSV 没重新导出时，应付还是旧金额。课表里一节都找不到的行照旧不核对（只有课时不一致警告）
    if (!matched.length || line.exportedAmount == null || !(line.month >= effectiveMonth)) continue;
    const label = [line.courseType, line.billingNote !== "—" && line.billingNote].filter(Boolean).join(" · ");
    const scheduleAmount = matched.reduce((sum, lesson) => sum + Number(lesson.payableAmount || 0), 0);
    if (Math.abs(Math.round(line.exportedAmount * 100) - Math.round(scheduleAmount * 100)) > 1) {
      const message = `「${label}」收费明细里是 ${formatMoneyText(line.exportedAmount)}，课程表里是 ${formatMoneyText(scheduleAmount)}，两份文件对不上，请先用这份课程表重新导出课时收费`;
      add(message, whens, () => message);
    }
  }
  // 学生没编号（名字不以「-数字」结尾）、课表里同名的对应多个老师或课程、课表时长多于收费汇总：多半混进了另一个同名学生的课
  const studentId = cleanText(report.studentId || report.studentName);
  if (studentId && !/-\d+$/u.test(studentId)) {
    const distinct = (key) => new Set(lessons.map((lesson) => lesson[key])).size;
    const scheduleDuration = lessons.reduce((sum, lesson) => sum + Number(lesson.duration || 0), 0);
    const exportedDuration = (report.courseLines || []).reduce((sum, line) => sum + Number(line.exportedDuration || 0), 0);
    if ((distinct("teacher") > 1 || distinct("courseType") > 1) && roundMoney(scheduleDuration) > roundMoney(exportedDuration)) {
      const message = `课程表里有多个同名学生「${studentId}」，请在课程表的学生名后加编号再导出`;
      add(message, [], () => message);
    }
  }
  return [...groups.values()].map((group) => {
    const message = group.build(group);
    return { message: group.whens.length ? `${group.whens.join("、")}：${message}` : message };
  });
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

// 文件名用带编号的完整标识：同名学生（去掉编号后同名）的 ZIP 条目不互相覆盖
export function reportFileName(report, extension = "pdf") {
  return `${safeFileName(report.studentId || report.studentName)}-${report.month}.${extension}`;
}
