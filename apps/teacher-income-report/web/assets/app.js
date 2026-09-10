import { buildReportFromCsv, cleanText, parseCsv, parseNumber } from "./report-core.js";
import {
  DEFAULT_PAYROLL_PARAMETERS,
  buildFeedbackRanking,
  buildPayrollReport,
  canonicalName,
  parseBaseSalaryCsv,
  parseReimbursementsCsv,
  parseStudentOwnershipCsv,
  parseTaxSocialCsv,
  parseTeacherScoresCsv,
} from "./payroll-core.js";
import {
  adjustedLessonAmounts,
  actualLessonAmount,
  discountedLessonAmount,
  effectiveLessonMultiplier,
} from "./income-calculations.js";
import { buildIncomeWorkbook } from "./income-workbook.js";

const MASTER_STORAGE_KEY = "jingshi.teacher-income.master.v1";

const state = {
  lessonReport: null,
  lessonRows: [],
  month: "",
  selectedTeacher: "",
  adjustments: {},
  master: {
    baseSalaries: [],
    studentOwnership: [],
    parameters: { ...DEFAULT_PAYROLL_PARAMETERS },
    nameAliases: {},
  },
  monthly: {
    taxSocial: [],
    reimbursements: [],
    teacherScoresByMonth: {},
    teacherScoreSourcesByMonth: {},
  },
  sources: {
    lessonFee: "未上传",
    taxSocial: "未上传",
    reimbursements: "未上传",
    baseSalaries: "项目默认",
    studentOwnership: "项目默认",
    parameters: "项目默认",
  },
  editingMaster: null,
};

const els = {
  statusBadge: document.getElementById("statusBadge"),
  lessonFeeInput: document.getElementById("lessonFeeInput"),
  taxSocialInput: document.getElementById("taxSocialInput"),
  reimbursementInput: document.getElementById("reimbursementInput"),
  teacherScoresInput: document.getElementById("teacherScoresInput"),
  lessonFeeStatus: document.getElementById("lessonFeeStatus"),
  taxSocialStatus: document.getElementById("taxSocialStatus"),
  reimbursementStatus: document.getElementById("reimbursementStatus"),
  teacherScoresStatus: document.getElementById("teacherScoresStatus"),
  monthSelect: document.getElementById("monthSelect"),
  teacherSelect: document.getElementById("teacherSelect"),
  masterCards: document.getElementById("masterCards"),
  totalIncome: document.getElementById("totalIncome"),
  totalCost: document.getElementById("totalCost"),
  teacherCount: document.getElementById("teacherCount"),
  issueCount: document.getElementById("issueCount"),
  ledgerPanel: document.getElementById("ledgerPanel"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  masterDrawer: document.getElementById("masterDrawer"),
  drawerTitle: document.getElementById("drawerTitle"),
  drawerSubtitle: document.getElementById("drawerSubtitle"),
  drawerBody: document.getElementById("drawerBody"),
  addMasterRowButton: document.getElementById("addMasterRowButton"),
  uploadMasterButton: document.getElementById("uploadMasterButton"),
  masterCsvInput: document.getElementById("masterCsvInput"),
  saveMasterButton: document.getElementById("saveMasterButton"),
  closeDrawerButton: document.getElementById("closeDrawerButton"),
  exportSelectedButton: document.getElementById("exportSelectedButton"),
  exportAllButton: document.getElementById("exportAllButton"),
};

const TEMPLATE_ROWS = {
  lessonFee: [
    ["学生", "老师", "课程类型", "上课时间", "下课时间", "课程单价", "课程时长", "课程总价格", "临时取消", "授课类型"],
    ["学生A-101", "黄钢", "英语刷题班", "2026/07/01 10:00", "2026/07/01 12:00", "280", "2", "560", "", "刷题班"],
  ],
  taxSocial: [
    ["姓名", "个税", "个人五险", "公司五险"],
    ["黄钢", "5563.80", "3717.60", "5913.60"],
  ],
  reimbursements: [
    ["老师名字", "报销类型", "报销日期", "报销明细", "报销截图", "报销金额"],
    ["黄钢", "报销", "2026/07/06", "BOSS直聘充值费用", "IMG_9710.png", "3062"],
  ],
  baseSalaries: [
    ["老师名", "雇佣属性", "基础薪水", "管理费", "市场推广", "教学顾问", "排课", "行政前台", "房租扣除"],
    ["黄钢", "全职", "30000", "10000", "", "", "", "", ""],
  ],
  studentOwnership: [
    ["学生姓名", "归属老师(20%)", "服务老师(7%)"],
    ["学生A", "黄钢", "黄钢"],
  ],
  teacherScores: [
    ["老师", "学习提升效果", "责任心与服务态度", "个人魅力"],
    ["黄钢", "5.0", "5.0", "5.0"],
  ],
  parameters: [
    ["参数", "值"],
    ["partTimeLessonRate", "0.6"],
    ["ownerCommissionRate", "0.2"],
    ["serviceCommissionRate", "0.07"],
    ["baseSalaryDeductionMultiplier", "1.2"],
    ["fullTimeFeedbackBaseRate", "0.47"],
    ["fullTimeFeedbackStepRate", "0.05"],
    ["fullTimeFeedbackMaxRate", "0.62"],
  ],
};

const MASTER_CONFIG = {
  baseSalaries: {
    title: "老师基础薪水表",
    subtitle: "基础薪水、雇佣属性和固定费用",
    fields: [
      ["teacher", "老师"],
      ["employmentType", "属性"],
      ["baseSalary", "基础薪水", "number"],
      ["managementFee", "管理费", "number"],
      ["marketingFee", "市场推广", "number"],
      ["advisorFee", "教学顾问", "number"],
      ["schedulingFee", "排课", "number"],
      ["adminFee", "行政前台", "number"],
      ["rentDeduction", "房租扣除", "number"],
    ],
  },
  studentOwnership: {
    title: "学生归属服务表",
    subtitle: "归属老师 20%，服务老师 7%",
    fields: [
      ["student", "学生"],
      ["ownerTeacher", "归属老师"],
      ["serviceTeacher", "服务老师"],
    ],
  },
  teacherScores: {
    title: "当月老师评分表",
    subtitle: "每个月独立上传；仅完整评分的全职老师参与当月前 50% 排名",
    fields: [
      ["teacher", "老师"],
      ["learning", "学习提升", "number"],
      ["responsibility", "责任心与服务态度", "number"],
      ["charisma", "个人魅力", "number"],
    ],
  },
  parameters: {
    title: "薪资参数",
    subtitle: "兼职、提成和底薪扣减参数",
    fields: [
      ["partTimeLessonRate", "兼职课时系数", "number"],
      ["ownerCommissionRate", "归属提成", "number"],
      ["serviceCommissionRate", "服务奖金", "number"],
      ["baseSalaryDeductionMultiplier", "底薪扣减倍数", "number"],
      ["fullTimeFeedbackBaseRate", "全职最低系数", "number"],
      ["fullTimeFeedbackStepRate", "前 50% 单项加成", "number"],
      ["fullTimeFeedbackMaxRate", "全职最高系数", "number"],
    ],
  },
};

const FEEDBACK_METRIC_LABELS = {
  learning: "学习提升",
  responsibility: "责任心",
  charisma: "个人魅力",
};

function money(value) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(value || 0);
}

function number(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value || 0);
}

function scoreNumber(value) {
  return value == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
}

function percent(value) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 0 }).format(value || 0);
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

function downloadCsv(rows, filename) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadTemplate(key) {
  const rows = TEMPLATE_ROWS[key];
  if (!rows) return;
  const labels = {
    lessonFee: "课时费",
    taxSocial: "五险个税",
    reimbursements: "补贴报销",
    baseSalaries: "老师基础薪水",
    studentOwnership: "学生归属服务",
    teacherScores: "当月老师评分",
    parameters: "薪资参数",
  };
  downloadCsv(rows, `${labels[key] || key}-模板.csv`);
}

function round(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function teacherKey(value) {
  return cleanText(canonicalName(value, state.master.nameAliases))
    .replace(/老师$/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function currentTeacherScores() {
  return state.month ? (state.monthly.teacherScoresByMonth[state.month] || []) : [];
}

function currentTeacherScoreSource() {
  if (!state.month) return "未选择工资月份";
  return state.monthly.teacherScoreSourcesByMonth[state.month] || "未上传";
}

function currentFeedbackRanking() {
  return buildFeedbackRanking(
    state.master.baseSalaries,
    currentTeacherScores(),
    state.master.nameAliases,
  );
}

function renderTeacherScoreStatus() {
  if (!state.month) {
    els.teacherScoresStatus.textContent = "请先上传课时费并选择工资月份";
    return;
  }
  const rows = currentTeacherScores();
  els.teacherScoresStatus.textContent = rows.length
    ? `${state.month} · ${number(rows.length)} 位 · ${currentTeacherScoreSource()}`
    : `${state.month} · 未上传，当月全职老师按最低系数计算`;
}

function hasCompleteTeacherScore(row) {
  return ["learning", "responsibility", "charisma"].every((metric) => {
    const value = row.metrics?.[metric];
    return value != null && Number.isFinite(value) && value >= 1 && value <= 5;
  });
}

function csvAmount(row) {
  return parseNumber(row["实际金额（¥）"])
    ?? parseNumber(row["实际金额"])
    ?? parseNumber(row["总金额（¥）"])
    ?? parseNumber(row["总金额"])
    ?? parseNumber(row["课程总价格"])
    ?? 0;
}

function buildDownstreamReport(csvText, sourceName) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { report: null, lessonRows: [] };

  if (Object.prototype.hasOwnProperty.call(rows[0], "上课时间") && Object.prototype.hasOwnProperty.call(rows[0], "课程总价格")) {
    return { report: buildReportFromCsv(csvText, sourceName), lessonRows: rows };
  }

  const months = new Set();
  const teacherMap = new Map();
  const studentMap = new Map();
  const lessonRows = [];

  const add = (map, month, name, amount, duration) => {
    if (!month || !name) return;
    const key = `${month}||${name}`;
    const current = map.get(key) || { month, name, amount: 0, duration: 0, lessons: 0 };
    current.amount = round(current.amount + amount);
    current.duration = round(current.duration + duration);
    current.lessons += 1;
    map.set(key, current);
  };

  for (const row of rows) {
    const month = cleanText(row["月份"]);
    const teacher = cleanText(row["老师名"] || row["老师"]);
    const student = cleanText(row["学生"] || row["学生名"]);
    const amount = csvAmount(row);
    const duration = parseNumber(row["总时长（h）"] || row["课程时长"] || row["时长"]) ?? 0;
    if (!month || !teacher) continue;
    months.add(month);
    add(teacherMap, month, teacher, amount, duration);
    if (student) add(studentMap, month, student, amount, duration);
    lessonRows.push({
      month,
      teacher,
      student,
      amount,
      duration,
      source: row,
      sourceIndex: lessonRows.length,
    });
  }

  const sortedMonths = [...months].sort();
  const views = { teacher: {}, student: {} };
  const entityOptions = { teacher: {}, student: {} };

  for (const month of sortedMonths) {
    views.teacher[month] = {};
    views.student[month] = {};
    entityOptions.teacher[month] = [...teacherMap.values()]
      .filter((entry) => entry.month === month)
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"))
      .map((entry) => {
        views.teacher[month][entry.name] = {
          view: "teacher",
          month,
          entity: entry.name,
          subjectLabel: "老师",
          counterpartyLabel: "学生",
          groups: [],
          totals: {
            lessons: entry.lessons,
            duration: entry.duration,
            amount: entry.amount,
            cancelledLessons: 0,
            cancelledDuration: 0,
            cancelledAmount: 0,
            issueCount: 0,
          },
          qualityIssues: [],
        };
        return { name: entry.name, amount: entry.amount, duration: entry.duration, lessons: entry.lessons, cancelledLessons: 0 };
      });
    entityOptions.student[month] = [...studentMap.values()]
      .filter((entry) => entry.month === month)
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"))
      .map((entry) => {
        views.student[month][entry.name] = {
          view: "student",
          month,
          entity: entry.name,
          subjectLabel: "学生",
          counterpartyLabel: "老师",
          groups: [],
          totals: {
            lessons: entry.lessons,
            duration: entry.duration,
            amount: entry.amount,
            cancelledLessons: 0,
            cancelledDuration: 0,
            cancelledAmount: 0,
            issueCount: 0,
          },
          qualityIssues: [],
        };
        return { name: entry.name, amount: entry.amount, duration: entry.duration, lessons: entry.lessons, cancelledLessons: 0 };
      });
  }

  return {
    report: {
      metadata: { sourcePath: sourceName, generatedAt: new Date().toISOString(), defaultMonth: sortedMonths.at(-1) || "" },
      months: sortedMonths,
      views,
      entityOptions,
      recordsByRow: {},
      qualityIssues: [],
      issueCounts: {},
      issueLabels: {},
    },
    lessonRows,
  };
}

function lessonAdjustmentKey(month, teacher, group) {
  return JSON.stringify([
    month,
    teacher,
    group.counterparty,
    group.courseType,
    group.teachingType,
    group.cancellationStatus,
  ]);
}

function adjustmentFor(month, teacher, group) {
  const key = lessonAdjustmentKey(month, teacher, group);
  if (!state.adjustments[key]) {
    state.adjustments[key] = {
      discountPercent: "100",
      reason: "",
      multiplier: "",
      multiplierReason: "",
    };
  }
  return state.adjustments[key];
}

function lessonRowAdjustmentKey(entry) {
  return JSON.stringify([
    "row",
    entry.month,
    entry.teacher,
    entry.student,
    entry.sourceIndex,
  ]);
}

function adjustmentForLessonRow(entry) {
  const key = lessonRowAdjustmentKey(entry);
  if (!state.adjustments[key]) {
    state.adjustments[key] = {
      discountPercent: "100",
      reason: "",
      multiplier: "",
      multiplierReason: "",
    };
  }
  return state.adjustments[key];
}

function adjustedLessonReport(feedbackRatesByMonth = {}) {
  if (!state.lessonReport) return null;
  const source = state.lessonReport;
  const views = { teacher: {}, student: {} };
  const entityOptions = { teacher: {}, student: {} };

  for (const month of source.months || []) {
    views.teacher[month] = {};
    views.student[month] = source.views?.student?.[month] || {};
    const studentAmounts = new Map();

    for (const [teacher, result] of Object.entries(source.views?.teacher?.[month] || {})) {
      const hasGroups = Boolean(result.groups?.length);
      const groups = (result.groups || []).map((group) => {
        const adjustment = adjustmentFor(month, teacher, group);
        const multiplier = effectiveLessonMultiplier(
          adjustment.multiplier,
          feedbackRatesByMonth?.[month]?.get(teacherKey(teacher)),
        );
        const amounts = adjustedLessonAmounts(
          group.amount,
          adjustment.discountPercent,
          multiplier,
        );
        const student = cleanText(group.counterparty);
        if (student) {
          const current = studentAmounts.get(student) || { amount: 0, duration: 0, lessons: 0 };
          current.amount = round(current.amount + amounts.commissionBaseAmount);
          current.duration = round(current.duration + (group.duration || 0));
          current.lessons += group.lessons || 0;
          studentAmounts.set(student, current);
        }
        return {
          ...group,
          amount: amounts.commissionBaseAmount,
          lessonBonus: amounts.teacherAmount,
          originalAmount: group.amount,
        };
      });
      const downstreamRows = hasGroups
        ? []
        : state.lessonRows.filter((entry) => entry.month === month && entry.teacher === teacher);
      for (const entry of downstreamRows) {
        const adjustment = adjustmentForLessonRow(entry);
        const student = cleanText(entry.student);
        if (!student) continue;
        const current = studentAmounts.get(student) || { amount: 0, duration: 0, lessons: 0 };
        current.amount = round(
          current.amount + discountedLessonAmount(entry.amount, adjustment.discountPercent),
        );
        current.duration = round(current.duration + (entry.duration || 0));
        current.lessons += 1;
        studentAmounts.set(student, current);
      }
      const amount = hasGroups
        ? round(groups.reduce((total, group) => total + group.amount, 0))
        : downstreamRows.length
          ? round(downstreamRows.reduce((total, entry) => {
            const adjustment = adjustmentForLessonRow(entry);
            return total + discountedLessonAmount(entry.amount, adjustment.discountPercent);
          }, 0))
          : result.totals.amount;
      const lessonBonus = hasGroups
        ? round(groups.reduce((total, group) => total + group.lessonBonus, 0))
        : downstreamRows.length
          ? round(downstreamRows.reduce((total, entry) => {
            const adjustment = adjustmentForLessonRow(entry);
            const multiplier = effectiveLessonMultiplier(
              adjustment.multiplier,
              feedbackRatesByMonth?.[month]?.get(teacherKey(teacher)),
            );
            return total + actualLessonAmount(entry.amount, adjustment.discountPercent, multiplier);
          }, 0))
          : null;
      views.teacher[month][teacher] = {
        ...result,
        groups,
        totals: {
          ...result.totals,
          amount,
          ...(lessonBonus == null ? {} : { lessonBonus }),
        },
      };
    }

    entityOptions.teacher[month] = Object.values(views.teacher[month])
      .map((result) => ({
        name: result.entity,
        amount: result.totals.amount,
        duration: result.totals.duration,
        lessons: result.totals.lessons,
        cancelledLessons: result.totals.cancelledLessons,
      }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));

    if (studentAmounts.size) {
      entityOptions.student[month] = [...studentAmounts.entries()]
        .map(([name, value]) => ({ name, ...value, cancelledLessons: 0 }))
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));
    } else {
      entityOptions.student[month] = source.entityOptions?.student?.[month] || [];
    }
  }

  return {
    ...source,
    views,
    entityOptions,
  };
}

function payrollInput() {
  return {
    baseSalaries: state.master.baseSalaries,
    studentOwnership: state.master.studentOwnership,
    teacherScoresByMonth: state.monthly.teacherScoresByMonth,
    parameters: state.master.parameters,
    nameAliases: state.master.nameAliases,
    taxSocial: state.monthly.taxSocial,
    reimbursements: state.monthly.reimbursements,
  };
}

function payrollReport() {
  if (!state.lessonReport) return null;
  const input = payrollInput();
  const preview = buildPayrollReport(state.lessonReport, input);
  const feedbackRatesByMonth = Object.fromEntries(
    Object.entries(preview.byMonth).map(([month, rows]) => [
      month,
      new Map(Object.values(rows).map((row) => [teacherKey(row.teacher), row.feedbackRate])),
    ]),
  );
  return buildPayrollReport(adjustedLessonReport(feedbackRatesByMonth), input);
}

function currentRows() {
  const payroll = payrollReport();
  if (!payroll || !state.month) return [];
  return Object.values(payroll.byMonth[state.month] || {})
    .sort((a, b) => b.personalTotalIncome - a.personalTotalIncome || a.teacher.localeCompare(b.teacher, "zh-CN"));
}

function currentRow() {
  return currentRows().find((row) => row.teacher === state.selectedTeacher) || currentRows()[0] || null;
}

async function readCsvFile(file, parser, onDone) {
  if (!file) return;
  const text = await file.text();
  const rows = parser(text);
  onDone(rows, file.name);
  render();
}

function persistMasterData(key) {
  try {
    const existing = JSON.parse(localStorage.getItem(MASTER_STORAGE_KEY) || "null");
    const sections = existing?.sections && typeof existing.sections === "object"
      ? existing.sections
      : {};
    sections[key] = state.master[key];
    localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify({
      version: 2,
      sections,
      teacherScoresByMonth: state.monthly.teacherScoresByMonth,
      teacherScoreSourcesByMonth: state.monthly.teacherScoreSourcesByMonth,
    }));
  } catch (error) {
    console.warn("无法保存主数据到浏览器", error);
  }
}

function persistMonthlyTeacherScores() {
  try {
    const existing = JSON.parse(localStorage.getItem(MASTER_STORAGE_KEY) || "null");
    const sections = existing?.sections && typeof existing.sections === "object"
      ? existing.sections
      : {};
    localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify({
      version: 2,
      sections,
      teacherScoresByMonth: state.monthly.teacherScoresByMonth,
      teacherScoreSourcesByMonth: state.monthly.teacherScoreSourcesByMonth,
    }));
  } catch (error) {
    console.warn("无法保存当月老师评分到浏览器", error);
  }
}

function restorePersistedMasterData() {
  try {
    const saved = JSON.parse(localStorage.getItem(MASTER_STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return false;
    const sections = saved.sections && typeof saved.sections === "object"
      ? saved.sections
      : saved;
    const restoredKeys = [];
    if (Array.isArray(sections.baseSalaries)) {
      state.master.baseSalaries = sections.baseSalaries;
      restoredKeys.push("baseSalaries");
    }
    if (Array.isArray(sections.studentOwnership)) {
      state.master.studentOwnership = sections.studentOwnership;
      restoredKeys.push("studentOwnership");
    }
    if (sections.parameters && typeof sections.parameters === "object") {
      state.master.parameters = { ...DEFAULT_PAYROLL_PARAMETERS, ...sections.parameters };
      restoredKeys.push("parameters");
    }
    for (const key of restoredKeys) {
      state.sources[key] = "浏览器上次保存";
    }
    if (saved.teacherScoresByMonth && typeof saved.teacherScoresByMonth === "object") {
      state.monthly.teacherScoresByMonth = saved.teacherScoresByMonth;
    }
    if (saved.teacherScoreSourcesByMonth && typeof saved.teacherScoreSourcesByMonth === "object") {
      state.monthly.teacherScoreSourcesByMonth = saved.teacherScoreSourcesByMonth;
    }
    return restoredKeys.length > 0 || Object.keys(state.monthly.teacherScoresByMonth).length > 0;
  } catch (error) {
    console.warn("忽略损坏的浏览器主数据", error);
    return false;
  }
}

function parseParametersCsv(csvText) {
  const rows = parseCsv(csvText);
  const labelsByField = new Map(
    MASTER_CONFIG.parameters.fields.flatMap(([field, label]) => [[field, field], [label, field]]),
  );
  const parameters = {};
  for (const row of rows) {
    const rawName = cleanText(row["参数"] || row["字段"] || row["parameter"] || row["Parameter"]);
    const field = labelsByField.get(rawName);
    const value = parseNumber(row["值"] || row["数值"] || row["value"] || row["Value"]);
    if (field && value != null) parameters[field] = value;
  }
  return parameters;
}

function parseMasterCsv(key, csvText) {
  const options = { nameAliases: state.master.nameAliases };
  if (key === "baseSalaries") return parseBaseSalaryCsv(csvText, options);
  if (key === "studentOwnership") return parseStudentOwnershipCsv(csvText, options);
  if (key === "teacherScores") return parseTeacherScoresCsv(csvText, options);
  if (key === "parameters") return parseParametersCsv(csvText);
  throw new Error(`不支持的主数据类型：${key}`);
}

async function loadDefaults() {
  try {
    const response = await fetch("/assets/payroll/defaults.json", { cache: "no-store" });
    if (!response.ok) throw new Error("no defaults");
    const defaults = await response.json();
    state.master.baseSalaries = defaults.baseSalaries || [];
    state.master.studentOwnership = defaults.studentOwnership || [];
    state.master.parameters = { ...DEFAULT_PAYROLL_PARAMETERS, ...(defaults.parameters || {}) };
    state.master.nameAliases = defaults.nameAliases || {};
  } catch (error) {
    console.warn("未加载项目默认主数据", error);
  }
  restorePersistedMasterData();
  render();
}

function renderMasterCards() {
  const cards = [
    ["baseSalaries", state.master.baseSalaries.length],
    ["studentOwnership", state.master.studentOwnership.length],
    ["teacherScores", currentTeacherScores().length],
    ["parameters", Object.keys(state.master.parameters).length],
  ];
  els.masterCards.innerHTML = cards.map(([key, count]) => `
    <button class="master-card" type="button" data-master="${escapeHtml(key)}">
      <span>${escapeHtml(MASTER_CONFIG[key].title)}</span>
      <strong>${number(count)} 条</strong>
      <em>${escapeHtml(key === "teacherScores" && state.month
        ? `${state.month} · ${currentTeacherScoreSource()}`
        : (key === "teacherScores" ? currentTeacherScoreSource() : (state.sources[key] || "项目默认")))}</em>
    </button>
  `).join("");
  els.masterCards.querySelectorAll("[data-master]").forEach((button) => {
    button.addEventListener("click", () => openMasterEditor(button.dataset.master));
  });
}

function renderSummary() {
  const rows = currentRows();
  const totals = rows.reduce((acc, row) => ({
    personalTotalIncome: acc.personalTotalIncome + row.personalTotalIncome,
    companyTotalCost: acc.companyTotalCost + row.companyTotalCost,
    issueCount: acc.issueCount + row.issues.length,
  }), { personalTotalIncome: 0, companyTotalCost: 0, issueCount: 0 });
  els.totalIncome.textContent = money(totals.personalTotalIncome);
  els.totalCost.textContent = money(totals.companyTotalCost);
  els.teacherCount.textContent = number(rows.length);
  els.issueCount.textContent = number(totals.issueCount);
  els.statusBadge.textContent = state.lessonReport ? `${state.month} · ${number(rows.length)} 位老师` : "等待课时费 CSV";
}

// 可搜索下拉（shadcn combobox）：点击展开全部选项，输入即模糊过滤，支持键盘上下/回车/ESC。
// 事件模型（参照 Radix 等成熟 primitive，避免 blur 时序编排）：
//   - 全局 pointerdown / focusin：按到/焦点到某个 combobox 外部 → 关闭它（唯一的"关外部"来源）
//   - 注册表保证同时只展开一个
//   - 输入框 pointerdown 时记录"按下前是否已展开"，click 再决定 toggle，避免 focus 抢先展开导致 toggle 失效
//   - 选项在 pointerdown 阶段选中并 preventDefault（不让输入框失焦）
const COMBOBOXES = [];
document.addEventListener("pointerdown", (event) => {
  for (const c of COMBOBOXES) if (!c.box.contains(event.target)) c.close();
});
document.addEventListener("focusin", (event) => {
  for (const c of COMBOBOXES) if (!c.box.contains(event.target)) c.close();
});

function setupCombobox(input, onSelect) {
  const box = input.closest(".combobox");
  const list = box.querySelector(".combo-list");
  const combo = { options: [], value: "", open: false, active: -1, filter: "", wasOpenOnPress: false };

  const labelOf = (value) => combo.options.find((o) => o.value === value)?.label || "";
  const filtered = () => {
    const query = combo.filter.trim().toLowerCase();
    if (!query) return combo.options;
    return combo.options.filter((o) =>
      o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query));
  };
  const paint = () => {
    const rows = filtered();
    list.innerHTML = rows.length
      ? rows.map((o, i) => `<button type="button" class="combo-option${o.value === combo.value ? " selected" : ""}${i === combo.active ? " active" : ""}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`).join("")
      : '<div class="combo-empty">没有匹配项</div>';
    list.querySelector(".combo-option.active")?.scrollIntoView({ block: "nearest" });
  };
  const close = (revert = true) => {
    if (!combo.open) return;
    combo.open = false;
    box.classList.remove("open");
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    if (revert) input.value = labelOf(combo.value);
  };
  const open = () => {
    if (input.disabled || combo.open) return;
    for (const c of COMBOBOXES) if (c.box !== box) c.close();
    combo.open = true;
    combo.active = -1;
    combo.filter = "";
    box.classList.add("open");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.select();
    paint();
  };
  const choose = (value) => {
    close(false);
    input.value = labelOf(value);
    if (value !== combo.value) {
      combo.value = value;
      onSelect(value);
    }
  };

  COMBOBOXES.push({ box, close });

  // pointerdown 先于 focus：记录按下前的展开状态，click 再决定开/收
  input.addEventListener("pointerdown", () => {
    combo.wasOpenOnPress = combo.open;
  });
  input.addEventListener("focus", open);
  input.addEventListener("click", () => {
    if (combo.wasOpenOnPress) close();
    else open();
  });
  input.addEventListener("input", () => {
    if (!combo.open) open();
    combo.filter = input.value;
    combo.active = combo.filter.trim() ? 0 : -1;
    paint();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!combo.open) open();
      const count = filtered().length;
      if (!count) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      combo.active = (combo.active + step + count) % count;
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const rows = filtered();
      const pick = rows[combo.active] || rows[0];
      if (pick) choose(pick.value);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
  // 选项在 pointerdown 阶段选中；preventDefault 保住输入框焦点
  list.addEventListener("pointerdown", (event) => {
    const option = event.target.closest("[data-value]");
    if (option) {
      event.preventDefault();
      choose(option.dataset.value);
    }
  });

  input._combo = {
    set(options, value, { disabled = false, placeholder = "" } = {}) {
      combo.options = options;
      combo.value = value;
      input.disabled = disabled;
      if (placeholder) input.placeholder = placeholder;
      if (combo.open) paint();
      else input.value = labelOf(value);
    },
  };
  return input._combo;
}

function renderMonthSelect() {
  const months = state.lessonReport?.months || [];
  els.monthSelect._combo.set(
    months.map((month) => ({ value: month, label: month })),
    state.month,
    { disabled: !months.length, placeholder: months.length ? "搜索月份" : "未上传课时费" },
  );
}

function renderTeacherSelect() {
  const rows = currentRows();
  if (!state.selectedTeacher || !rows.some((row) => row.teacher === state.selectedTeacher)) {
    state.selectedTeacher = rows[0]?.teacher || "";
  }
  els.teacherSelect._combo.set(
    rows.map((row) => ({ value: row.teacher, label: `${row.teacher} · ${money(row.personalTotalIncome)}` })),
    state.selectedTeacher,
    { disabled: !rows.length, placeholder: rows.length ? "搜索老师" : "未选择老师" },
  );
}

function renderOutputControls() {
  const hasRows = currentRows().length > 0;
  els.exportSelectedButton.disabled = !hasRows;
  els.exportAllButton.disabled = !hasRows;
}

function ledgerItem(kind, label, amount, source, formula = "") {
  return `
    <div class="ledger-row ${kind}">
      <div>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(source)}</span>
        ${formula ? `<em>${escapeHtml(formula)}</em>` : ""}
      </div>
      <b>${kind === "minus" ? "-" : kind === "total" ? "=" : "+"} ${money(amount)}</b>
    </div>
  `;
}

function feedbackDescription(row) {
  if (row.feedbackType === "part_time") return "兼职课时系数";
  if (row.feedbackMissingScore) return "缺少当月评分，按全职 0 项前 50% 计算";
  const labels = (row.qualifiedMetricKeys || []).map((metric) => FEEDBACK_METRIC_LABELS[metric]);
  return labels.length ? `全职前 50%：${labels.join("、")}` : "全职 0 项前 50%";
}

function lessonMultiplierDetails(adjustment, row) {
  const automatic = String(adjustment.multiplier ?? "").trim() === "";
  return {
    automatic,
    value: effectiveLessonMultiplier(adjustment.multiplier, row.feedbackRate),
    reason: automatic ? `自动读取课时系数 ${percent(row.feedbackRate)}` : adjustment.multiplierReason,
  };
}

function renderCommissionRows(row) {
  if (!row.commissionRows.length) return '<div class="empty-state small">没有提成明细</div>';
  return `
    <div class="mini-table">
      ${row.commissionRows.map((entry) => `
        <div>
          <span>${escapeHtml(entry.type === "owner" ? "归属提成" : "服务奖金")}</span>
          <strong>${escapeHtml(entry.student)}</strong>
          <em>${entry.studentFee < 0 ? `${money(entry.studentFee)} 按 ¥0.00 计提` : money(entry.studentFee)} × ${percent(entry.rate)} = ${money(entry.amount)}</em>
        </div>
      `).join("")}
    </div>
  `;
}

function renderLessonDetails(row) {
  const result = state.lessonReport?.views?.teacher?.[state.month]?.[row.teacher];
  if (result?.groups?.length) {
    return `
      <section class="lesson-section">
        <div class="lesson-section-head">
          <div>
            <h3>课时费明细</h3>
            <p>${escapeHtml(state.month)} · ${number(result.totals.lessons)} 课 · 原始课时费 ${money(result.totals.amount)} · 实际金额 = 总金额 × 折扣% × 乘数</p>
          </div>
          <span class="badge">${number(result.groups.length)} 个分组</span>
        </div>
        <div class="lesson-table-wrap">
          <table class="lesson-table">
            <thead>
              <tr>
                <th>学生</th>
                <th>课程类型</th>
                <th>授课类型</th>
                <th>取消/上课状态</th>
                <th class="numeric">总时长（h）</th>
                <th class="numeric">取消时长（h）</th>
                <th class="numeric">课程单价（¥）</th>
                <th class="numeric">折扣（%）</th>
                <th>折扣原因</th>
                <th class="numeric">乘数</th>
                <th>乘数原因</th>
                <th class="numeric">总金额（¥）</th>
                <th class="numeric">实际金额（¥）</th>
                <th>原始数据</th>
              </tr>
            </thead>
            <tbody>
              ${result.groups.map((group, index) => {
                const adjustment = adjustmentFor(state.month, row.teacher, group);
                const multiplier = lessonMultiplierDetails(adjustment, row);
                const actual = actualLessonAmount(
                  group.amount,
                  adjustment.discountPercent,
                  multiplier.value,
                );
                return `
                  <tr>
                    <td><strong>${escapeHtml(group.counterparty)}</strong></td>
                    <td>${escapeHtml(group.courseType)}</td>
                    <td>${escapeHtml(group.teachingType)}</td>
                    <td><span class="badge">${escapeHtml(group.cancellationStatus)}</span></td>
                    <td class="numeric">${number(group.duration)}</td>
                    <td class="numeric">${number(group.cancelledDuration)}</td>
                    <td class="numeric">${escapeHtml(group.unitPriceLabel)}</td>
                    <td class="numeric"><input class="table-input number-input" type="number" step="0.01" value="${escapeHtml(adjustment.discountPercent)}" data-lesson-discount="${index}" /></td>
                    <td><input class="table-input reason-input" type="text" value="${escapeHtml(adjustment.reason)}" data-lesson-reason="${index}" /></td>
                    <td class="numeric"><input class="table-input number-input" type="number" min="0" step="0.01" value="${escapeHtml(multiplier.value)}" title="默认自动读取当月课时系数；输入数值可覆盖，清空后恢复自动" data-lesson-multiplier="${index}" /></td>
                    <td><input class="table-input reason-input" type="text" value="${escapeHtml(multiplier.reason)}" ${multiplier.automatic ? "readonly" : ""} data-lesson-multiplier-reason="${index}" /></td>
                    <td class="numeric"><strong>${number(group.amount)}</strong></td>
                    <td class="numeric"><strong>${number(actual)}</strong></td>
                    <td>${group.rawRows?.length ? `${group.rawRows.length} 行明细` : "—"}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  const rows = state.lessonRows.filter((entry) => entry.month === state.month && entry.teacher === row.teacher);
  if (!rows.length) return '<section class="lesson-section"><div class="empty-state small">没有可罗列的课时明细</div></section>';
  return `
    <section class="lesson-section">
      <div class="lesson-section-head">
        <div>
          <h3>课时费明细</h3>
          <p>${escapeHtml(state.month)} · 来自下游课时费 CSV · 实际金额 = 总金额 × 折扣% × 乘数</p>
        </div>
      </div>
      <div class="lesson-table-wrap">
        <table class="lesson-table compact">
          <thead>
            <tr>
              <th>学生</th>
              <th class="numeric">时长（h）</th>
              <th class="numeric">折扣（%）</th>
              <th>折扣原因</th>
              <th class="numeric">乘数</th>
              <th>乘数原因</th>
              <th class="numeric">总金额（¥）</th>
              <th class="numeric">实际金额（¥）</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((entry, index) => {
              const adjustment = adjustmentForLessonRow(entry);
              const multiplier = lessonMultiplierDetails(adjustment, row);
              const actual = actualLessonAmount(
                entry.amount,
                adjustment.discountPercent,
                multiplier.value,
              );
              return `
                <tr>
                  <td><strong>${escapeHtml(entry.student || "未填写学生")}</strong></td>
                  <td class="numeric">${number(entry.duration)}</td>
                  <td class="numeric"><input class="table-input number-input" type="number" step="0.01" value="${escapeHtml(adjustment.discountPercent)}" data-row-discount="${index}" /></td>
                  <td><input class="table-input reason-input" type="text" value="${escapeHtml(adjustment.reason)}" data-row-reason="${index}" /></td>
                  <td class="numeric"><input class="table-input number-input" type="number" min="0" step="0.01" value="${escapeHtml(multiplier.value)}" title="默认自动读取当月课时系数；输入数值可覆盖，清空后恢复自动" data-row-multiplier="${index}" /></td>
                  <td><input class="table-input reason-input" type="text" value="${escapeHtml(multiplier.reason)}" ${multiplier.automatic ? "readonly" : ""} data-row-multiplier-reason="${index}" /></td>
                  <td class="numeric"><strong>${number(entry.amount)}</strong></td>
                  <td class="numeric"><strong>${number(actual)}</strong></td>
                  <td>${escapeHtml(cleanText(entry.source?.课程类型 || entry.source?.授课类型 || "汇总行"))}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function bindLessonDiscounts(row) {
  const result = state.lessonReport?.views?.teacher?.[state.month]?.[row.teacher];
  if (result?.groups?.length) {
    els.ledgerPanel.querySelectorAll("[data-lesson-discount]").forEach((input) => {
      input.addEventListener("change", () => {
        const group = result.groups[Number(input.dataset.lessonDiscount)];
        adjustmentFor(state.month, row.teacher, group).discountPercent = input.value;
        render();
      });
    });
    els.ledgerPanel.querySelectorAll("[data-lesson-reason]").forEach((input) => {
      input.addEventListener("change", () => {
        const group = result.groups[Number(input.dataset.lessonReason)];
        adjustmentFor(state.month, row.teacher, group).reason = input.value;
      });
    });
    els.ledgerPanel.querySelectorAll("[data-lesson-multiplier]").forEach((input) => {
      input.addEventListener("change", () => {
        const group = result.groups[Number(input.dataset.lessonMultiplier)];
        adjustmentFor(state.month, row.teacher, group).multiplier = input.value;
        render();
      });
    });
    els.ledgerPanel.querySelectorAll("[data-lesson-multiplier-reason]").forEach((input) => {
      input.addEventListener("change", () => {
        const group = result.groups[Number(input.dataset.lessonMultiplierReason)];
        adjustmentFor(state.month, row.teacher, group).multiplierReason = input.value;
      });
    });
    return;
  }

  const rows = state.lessonRows.filter((entry) => entry.month === state.month && entry.teacher === row.teacher);
  const bindRowField = (selector, datasetKey, field, shouldRender) => {
    els.ledgerPanel.querySelectorAll(selector).forEach((input) => {
      input.addEventListener("change", () => {
        const entry = rows[Number(input.dataset[datasetKey])];
        adjustmentForLessonRow(entry)[field] = input.value;
        if (shouldRender) render();
      });
    });
  };
  bindRowField("[data-row-discount]", "rowDiscount", "discountPercent", true);
  bindRowField("[data-row-reason]", "rowReason", "reason", false);
  bindRowField("[data-row-multiplier]", "rowMultiplier", "multiplier", true);
  bindRowField("[data-row-multiplier-reason]", "rowMultiplierReason", "multiplierReason", false);
}

function renderLedger() {
  const row = currentRow();
  if (!row) {
    els.ledgerPanel.innerHTML = '<div class="empty-state">上传课时费 CSV 后，选择老师查看收入来源、扣减和合计。</div>';
    return;
  }
  state.selectedTeacher = row.teacher;
  const bonusBeforeDeduction = round(row.lessonBonus + row.ownerCommission + row.serviceCommission);
  els.ledgerPanel.innerHTML = `
    <div class="ledger-head">
      <div>
        <p class="eyebrow">Income Detail</p>
        <h2>${escapeHtml(row.teacher)}</h2>
        <p>${escapeHtml(row.employmentType)} · 课时系数 ${percent(row.feedbackRate)} · ${escapeHtml(feedbackDescription(row))}</p>
      </div>
      <div class="headline-total">
        <span>个人总收入</span>
        <strong>${money(row.personalTotalIncome)}</strong>
      </div>
    </div>

    ${renderLessonDetails(row)}

    <section class="ledger">
      <h3>Bonus 计算</h3>
      ${ledgerItem(row.feedbackMissingScore ? "warning" : "plus", "课时反馈奖金", row.lessonBonus, `来源：课时明细实际金额合计`, `课时系数 ${percent(row.feedbackRate)} 已由每节课乘数体现 · ${feedbackDescription(row)}`)}
      ${ledgerItem("plus", "学员介绍提成", row.ownerCommission, "来源：学生归属服务表 + 学生当月学费", `学生学费 × ${percent(state.master.parameters.ownerCommissionRate)}`)}
      ${ledgerItem("plus", "服务/管理奖金", row.serviceCommission, "来源：学生归属服务表 + 学生当月学费", `学生学费 × ${percent(state.master.parameters.serviceCommissionRate)}`)}
      ${ledgerItem("subtotal", "Bonus 扣减前小计", bonusBeforeDeduction, "课时反馈奖金 + 介绍提成 + 服务奖金")}
      ${ledgerItem("minus", "基础薪水扣减", row.baseSalaryDeduction, "来源：老师基础薪水表 + 参数", `${money(row.baseSalary)} × ${number(state.master.parameters.baseSalaryDeductionMultiplier)}`)}
      ${ledgerItem("total", "Bonus 公式结果", row.bonusSalary, "Bonus 扣减前小计 - 基础薪水扣减")}
    </section>

    <section class="ledger">
      <h3>个人收入</h3>
      ${ledgerItem("plus", "基础薪水", row.baseSalary, "来源：老师基础薪水表")}
      ${ledgerItem("plus", "管理费", row.managementFee, "来源：老师基础薪水表")}
      ${ledgerItem("minus", "房租扣除", row.rentDeduction, "来源：老师基础薪水表")}
      ${ledgerItem(row.bonusSalary < 0 ? "warning" : "plus", "实际计入 Bonus", row.appliedBonusSalary, "来源：上方 Bonus 公式结果", row.bonusSalary < 0 ? `${money(row.bonusSalary)} 按 ¥0.00 计入个人收入` : "")}
      ${ledgerItem("plus", "补贴报销", row.reimbursement, "来源：补贴报销 CSV")}
      ${ledgerItem("minus", "个人五险", row.personalSocialInsurance, "来源：五险 + 个税 CSV")}
      ${ledgerItem("minus", "个税", row.tax, "来源：五险 + 个税 CSV")}
      ${ledgerItem("total", "个人总收入", row.personalTotalIncome, "基础薪水 + 管理费 - 房租扣除 + 实际计入 Bonus + 报销 - 个人五险 - 个税")}
    </section>

    <section class="ledger">
      <h3>公司成本</h3>
      ${ledgerItem("plus", "基础薪水", row.baseSalary, "来源：老师基础薪水表")}
      ${ledgerItem("plus", "管理费", row.managementFee, "来源：老师基础薪水表")}
      ${ledgerItem("minus", "房租扣除", row.rentDeduction, "来源：老师基础薪水表")}
      ${ledgerItem(row.bonusSalary < 0 ? "warning" : "plus", "实际计入 Bonus", row.appliedBonusSalary, "来源：上方 Bonus 公式结果", row.bonusSalary < 0 ? `${money(row.bonusSalary)} 按 ¥0.00 计入公司成本` : "")}
      ${ledgerItem("plus", "补贴报销", row.reimbursement, "来源：补贴报销 CSV")}
      ${ledgerItem("plus", "公司五险", row.companySocialInsurance, "来源：五险 + 个税 CSV")}
      ${ledgerItem("total", "公司总成本", row.companyTotalCost, "基础薪水 + 管理费 - 房租扣除 + 实际计入 Bonus + 报销 + 公司五险")}
    </section>

    <section class="source-panel">
      <h3>提成来源明细</h3>
      ${renderCommissionRows(row)}
    </section>

    <section class="source-panel">
      <h3>数据提醒</h3>
      ${row.issues.length ? row.issues.map((issue) => `<span class="badge warn">${escapeHtml(issue.label)}</span>`).join(" ") : '<span class="badge">数据完整</span>'}
    </section>
  `;
  bindLessonDiscounts(row);
}

function payrollSummaryRow(row) {
  return [
    row.teacher,
    row.employmentType,
    row.baseSalary,
    row.managementFee,
    row.rentDeduction,
    row.lessonFee,
    row.feedbackRate,
    (row.qualifiedMetricKeys || []).map((metric) => FEEDBACK_METRIC_LABELS[metric]).join("、") || "0 项",
    feedbackDescription(row),
    row.lessonBonus,
    row.ownerCommission,
    row.serviceCommission,
    row.baseSalaryDeduction,
    row.bonusSalary,
    row.appliedBonusSalary,
    row.reimbursement,
    row.personalSocialInsurance,
    row.tax,
    row.personalTotalIncome,
    row.companySocialInsurance,
    row.companyTotalCost,
    row.issues.map((issue) => issue.label).join("；"),
  ];
}

const SUMMARY_HEADERS = [
  "老师",
  "雇佣属性",
  "基础薪水",
  "管理费",
  "房租扣除",
  "月度课时费",
  "课时系数",
  "前 50% 项目",
  "评分说明",
  "课时反馈奖金",
  "学员介绍提成",
  "服务/管理奖金",
  "基础薪水扣减",
  "Bonus 公式结果",
  "实际计入 Bonus",
  "补贴报销",
  "个人五险",
  "个税",
  "个人总收入",
  "公司五险",
  "公司总成本",
  "数据提醒",
];

function teacherExportModel(row) {
  const result = state.lessonReport?.views?.teacher?.[state.month]?.[row.teacher];
  const lessonRows = result?.groups?.length
    ? result.groups.map((group) => {
      const adjustment = adjustmentFor(state.month, row.teacher, group);
      const multiplier = lessonMultiplierDetails(adjustment, row);
      return [
        group.counterparty,
        group.courseType,
        group.teachingType,
        group.cancellationStatus,
        group.duration,
        group.unitPriceLabel,
        Number(adjustment.discountPercent),
        adjustment.reason,
        multiplier.value,
        multiplier.reason,
        group.amount,
        actualLessonAmount(group.amount, adjustment.discountPercent, multiplier.value),
        group.rawRows?.join(" ") || "",
      ];
    })
    : state.lessonRows
      .filter((entry) => entry.month === state.month && entry.teacher === row.teacher)
      .map((entry) => {
        const adjustment = adjustmentForLessonRow(entry);
        const multiplier = lessonMultiplierDetails(adjustment, row);
        return [
          entry.student,
          cleanText(entry.source?.课程类型 || ""),
          cleanText(entry.source?.授课类型 || ""),
          "",
          entry.duration,
          "",
          Number(adjustment.discountPercent),
          adjustment.reason,
          multiplier.value,
          multiplier.reason,
          entry.amount,
          actualLessonAmount(entry.amount, adjustment.discountPercent, multiplier.value),
          entry.sourceIndex,
        ];
      });

  const bonusBeforeDeduction = round(row.lessonBonus + row.ownerCommission + row.serviceCommission);
  return {
    teacher: row.teacher,
    employmentType: row.employmentType,
    personalTotalIncome: row.personalTotalIncome,
    companyTotalCost: row.companyTotalCost,
    financialHeaders: ["类型", "项目", "来源", "公式/说明", "金额"],
    financialRows: [
      [row.feedbackMissingScore ? "提醒" : "加项", "课时反馈奖金", "课时明细实际金额合计", `课时系数 ${row.feedbackRate} 已由每节课乘数体现 · ${feedbackDescription(row)}`, row.lessonBonus],
      ["加项", "学员介绍提成", "学生归属服务表", `学生学费 × ${state.master.parameters.ownerCommissionRate}`, row.ownerCommission],
      ["加项", "服务/管理奖金", "学生归属服务表", `学生学费 × ${state.master.parameters.serviceCommissionRate}`, row.serviceCommission],
      ["小计", "Bonus 扣减前小计", "", "", bonusBeforeDeduction],
      ["减项", "基础薪水扣减", "老师基础薪水表 + 参数", `${row.baseSalary} × ${state.master.parameters.baseSalaryDeductionMultiplier}`, row.baseSalaryDeduction],
      ["合计", "Bonus 公式结果", "", "", row.bonusSalary],
      [row.bonusSalary < 0 ? "调整" : "加项", "实际计入 Bonus", "Bonus 公式结果", row.bonusSalary < 0 ? `${row.bonusSalary} 按 0 计入` : "", row.appliedBonusSalary],
      ["加项", "基础薪水", "老师基础薪水表", "", row.baseSalary],
      ["加项", "管理费", "老师基础薪水表", "", row.managementFee],
      ["减项", "房租扣除", "老师基础薪水表", "", row.rentDeduction],
      ["加项", "补贴报销", "补贴报销 CSV", "", row.reimbursement],
      ["减项", "个人五险", "五险 + 个税 CSV", "", row.personalSocialInsurance],
      ["减项", "个税", "五险 + 个税 CSV", "", row.tax],
      ["合计", "个人总收入", "固定收入 + 实际计入 Bonus + 报销 - 个人五险 - 个税", "", row.personalTotalIncome],
      ["合计", "公司总成本", "固定收入 + 实际计入 Bonus + 报销 + 公司五险", "", row.companyTotalCost],
    ],
    lessonHeaders: [
      "学生",
      "课程类型",
      "授课类型",
      "状态",
      "时长（h）",
      "单价",
      "折扣（%）",
      "折扣原因",
      "乘数",
      "乘数原因",
      "总金额",
      "实际金额",
      "原始行",
    ],
    lessonRows,
    lessonCurrencyColumns: [11, 12],
    commissionHeaders: ["提成类型", "学生", "来源学生", "计提基数", "比例", "金额"],
    commissionRows: row.commissionRows.map((entry) => [
      entry.type === "owner" ? "归属提成" : "服务奖金",
      entry.student,
      entry.sourceStudent,
      entry.commissionBase,
      entry.rate,
      entry.amount,
    ]),
  };
}

async function downloadIncomeWorkbook(rows, filename) {
  const model = {
    month: state.month,
    summaryHeaders: SUMMARY_HEADERS,
    summaryRows: rows.map(payrollSummaryRow),
    summaryCurrencyColumns: [3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    summaryRateColumns: [7],
    teachers: rows.map(teacherExportModel),
  };
  await buildIncomeWorkbook(window.writeXlsxFile, model).toFile(filename);
}

async function exportAllTeachers() {
  const rows = currentRows();
  if (!rows.length) return;
  await downloadIncomeWorkbook(rows, `老师收入汇总-${state.month}.xlsx`);
}

async function exportSelectedTeacher() {
  const row = currentRow();
  if (!row) return;
  await downloadIncomeWorkbook([row], `${row.teacher}-${state.month}-收入详情.xlsx`);
}

function emptyMasterRow(key) {
  const config = MASTER_CONFIG[key];
  return Object.fromEntries(config.fields.map(([field]) => [field, ""]));
}

function deleteEditorRow(button) {
  button.closest("tr")?.remove();
  els.drawerBody.querySelectorAll("tbody tr").forEach((row, rowIndex) => {
    row.querySelectorAll("[data-row]").forEach((input) => {
      input.dataset.row = String(rowIndex);
    });
  });
}

function deleteCell() {
  return '<td class="editor-action"><button class="button danger compact" type="button" data-delete-row>删除</button></td>';
}

function addMasterRow() {
  const key = state.editingMaster;
  if (!key || key === "parameters") return;
  const tbody = els.drawerBody.querySelector("tbody");
  if (!tbody) return;
  const config = MASTER_CONFIG[key];
  const rowIndex = tbody.querySelectorAll("tr").length;
  const row = emptyMasterRow(key);
  const tr = document.createElement("tr");
  tr.innerHTML = config.fields.map(([field,, type]) => `
    <td>
      <input data-row="${rowIndex}" data-field="${escapeHtml(field)}" type="${type === "number" ? "number" : "text"}" step="0.001" ${key === "teacherScores" && type === "number" ? 'min="1" max="5"' : ""} value="${escapeHtml(row[field] ?? "")}" />
    </td>
  `).join("")
    + (key === "teacherScores" ? "<td>—</td><td>保存后重排</td>" : "")
    + deleteCell();
  tbody.appendChild(tr);
  tr.querySelector("[data-delete-row]")?.addEventListener("click", (event) => deleteEditorRow(event.currentTarget));
  tr.querySelector("input")?.focus();
}

function openMasterEditor(key) {
  state.editingMaster = key;
  const config = MASTER_CONFIG[key];
  els.drawerTitle.textContent = key === "teacherScores" && state.month
    ? `${state.month} · ${config.title}`
    : config.title;
  els.drawerSubtitle.textContent = config.subtitle;
  els.addMasterRowButton.disabled = key === "parameters";
  els.uploadMasterButton.disabled = false;

  const ranking = key === "teacherScores" ? currentFeedbackRanking() : null;
  const rows = key === "parameters"
    ? [state.master.parameters]
    : key === "teacherScores"
      ? ranking.teachers.map((row) => ({
        teacher: row.teacher,
        ...(row.metrics || {}),
        average: row.average,
        eligible: row.eligible,
        rankingNote: row.rankingNote,
        qualifiedMetricKeys: row.qualifiedMetricKeys,
      }))
      : state.master[key];

  const scoreLegend = key === "teacherScores"
    ? `<div class="score-ranking-legend">
        <strong>${escapeHtml(state.month || "未选择月份")} 当月排名</strong>
        <span><i></i>绿色单元格 = 该项进入前 50%</span>
        <span>参与排名 ${number(ranking.eligibleCount)} 人 · 名义前 50% ${number(ranking.winnerCount)} 人</span>
        <span>分界线：学习提升 ${scoreNumber(ranking.metrics.learning.cutoff)} · 责任心 ${scoreNumber(ranking.metrics.responsibility.cutoff)} · 个人魅力 ${scoreNumber(ranking.metrics.charisma.cutoff)}</span>
      </div>`
    : "";
  const extraHeaders = key === "teacherScores" ? "<th>三项均分</th><th>前 50% 项</th>" : "";
  const actionHeader = key === "parameters" ? "" : "<th>操作</th>";

  els.drawerBody.innerHTML = `
    ${scoreLegend}
    <div class="editor-table-wrap">
      <table class="editor-table">
        <thead>
          <tr>${config.fields.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}${extraHeaders}${actionHeader}</tr>
        </thead>
        <tbody>
          ${rows.map((row, rowIndex) => `
            <tr>
              ${config.fields.map(([field,, type]) => `
                <td class="${key === "teacherScores" && row.qualifiedMetricKeys?.includes(field) ? "score-top50" : ""}">
                  <input data-row="${rowIndex}" data-field="${escapeHtml(field)}" type="${type === "number" ? "number" : "text"}" step="0.001" ${key === "teacherScores" && type === "number" ? 'min="1" max="5"' : ""} value="${escapeHtml(row[field] ?? "")}" />
                </td>
              `).join("")}
              ${key === "teacherScores" ? `<td class="numeric"><strong>${scoreNumber(row.average)}</strong></td><td>${row.eligible ? (row.qualifiedMetricKeys.length ? row.qualifiedMetricKeys.map((metric) => FEEDBACK_METRIC_LABELS[metric]).join("、") : "0 项") : escapeHtml(row.rankingNote || "不参与排名")}</td>` : ""}
              ${key === "parameters" ? "" : deleteCell()}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  els.drawerBody.querySelectorAll("[data-delete-row]").forEach((button) => {
    button.addEventListener("click", (event) => deleteEditorRow(event.currentTarget));
  });
  els.drawerBackdrop.classList.add("open");
  els.masterDrawer.classList.add("open");
  els.masterDrawer.setAttribute("aria-hidden", "false");
}

function saveMasterEditor() {
  const key = state.editingMaster;
  if (!key) return;
  const config = MASTER_CONFIG[key];
  const inputs = [...els.drawerBody.querySelectorAll("input")];
  const rows = [];
  for (const input of inputs) {
    const rowIndex = Number(input.dataset.row);
    const field = input.dataset.field;
    const type = config.fields.find(([name]) => name === field)?.[2];
    if (!rows[rowIndex]) rows[rowIndex] = {};
    const rawValue = input.value.trim();
    rows[rowIndex][field] = type === "number"
      ? (key === "teacherScores" && rawValue === "" ? null : Number(rawValue || 0))
      : rawValue;
  }
  if (key === "parameters") {
    state.master.parameters = { ...state.master.parameters, ...rows[0] };
  } else if (key === "teacherScores") {
    if (!state.month) {
      window.alert("请先选择工资月份，再编辑当月评分。");
      return;
    }
    state.monthly.teacherScoresByMonth[state.month] = rows
      .filter((row) => row.teacher)
      .map((row) => ({
        teacher: row.teacher,
        metrics: {
          learning: row.learning,
          responsibility: row.responsibility,
          charisma: row.charisma,
        },
      }));
    state.monthly.teacherScoreSourcesByMonth[state.month] = "网页端修改";
    persistMonthlyTeacherScores();
  } else {
    state.master[key] = rows.filter((row) => Object.values(row).some((value) => cleanText(value)));
  }
  if (key !== "teacherScores") {
    state.sources[key] = "网页端修改";
    persistMasterData(key);
  }
  closeDrawer();
  render();
}

function closeDrawer() {
  els.drawerBackdrop.classList.remove("open");
  els.masterDrawer.classList.remove("open");
  els.masterDrawer.setAttribute("aria-hidden", "true");
  state.editingMaster = null;
}

function render() {
  renderMonthSelect();
  renderTeacherSelect();
  renderOutputControls();
  renderMasterCards();
  renderTeacherScoreStatus();
  renderSummary();
  renderLedger();
}

els.lessonFeeInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { report, lessonRows } = buildDownstreamReport(text, file.name);
  state.lessonReport = report;
  state.lessonRows = lessonRows;
  state.month = report?.metadata?.defaultMonth || report?.months?.at(-1) || "";
  state.sources.lessonFee = file.name;
  els.lessonFeeStatus.textContent = `${file.name} · ${number(lessonRows.length)} 行`;
  state.selectedTeacher = "";
  state.adjustments = {};
  render();
});

setupCombobox(els.monthSelect, (value) => {
  state.month = value;
  state.selectedTeacher = "";
  render();
});

setupCombobox(els.teacherSelect, (value) => {
  state.selectedTeacher = value;
  render();
});

els.taxSocialInput.addEventListener("change", (event) => readCsvFile(event.target.files[0], parseTaxSocialCsv, (rows, source) => {
  state.monthly.taxSocial = rows;
  state.sources.taxSocial = source;
  els.taxSocialStatus.textContent = `${source} · ${number(rows.length)} 条`;
}));

els.reimbursementInput.addEventListener("change", (event) => readCsvFile(event.target.files[0], parseReimbursementsCsv, (rows, source) => {
  state.monthly.reimbursements = rows;
  state.sources.reimbursements = source;
  els.reimbursementStatus.textContent = `${source} · ${number(rows.length)} 条`;
}));

els.teacherScoresInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!state.month) {
    window.alert("请先上传课时费 CSV 并选择工资月份，再上传该月老师评分。");
    event.target.value = "";
    return;
  }
  try {
    const rows = parseTeacherScoresCsv(await file.text(), { nameAliases: state.master.nameAliases });
    if (!rows.length) throw new Error("没有识别到有效评分行");
    if (!rows.some(hasCompleteTeacherScore)) throw new Error("没有识别到三项均为 1–5 的完整评分");
    state.monthly.teacherScoresByMonth[state.month] = rows;
    state.monthly.teacherScoreSourcesByMonth[state.month] = `${file.name} · 浏览器保存`;
    persistMonthlyTeacherScores();
    render();
  } catch (error) {
    window.alert(`当月评分导入失败：${error.message}`);
  } finally {
    event.target.value = "";
  }
});

els.saveMasterButton.addEventListener("click", saveMasterEditor);
els.addMasterRowButton.addEventListener("click", addMasterRow);
els.uploadMasterButton.addEventListener("click", () => {
  els.masterCsvInput.value = "";
  els.masterCsvInput.click();
});
els.masterCsvInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const key = state.editingMaster;
  if (!file || !key) return;
  try {
    const imported = parseMasterCsv(key, await file.text());
    if (key === "parameters") {
      if (!Object.keys(imported).length) throw new Error("没有识别到参数和值");
      state.master.parameters = { ...DEFAULT_PAYROLL_PARAMETERS, ...imported };
    } else if (key === "teacherScores") {
      if (!state.month) throw new Error("请先上传课时费并选择工资月份");
      if (!imported.length) throw new Error("没有识别到有效评分行");
      if (!imported.some(hasCompleteTeacherScore)) throw new Error("没有识别到三项均为 1–5 的完整评分");
      state.monthly.teacherScoresByMonth[state.month] = imported;
      state.monthly.teacherScoreSourcesByMonth[state.month] = `${file.name} · 浏览器保存`;
      persistMonthlyTeacherScores();
    } else {
      if (!imported.length) throw new Error("没有识别到有效数据行");
      state.master[key] = imported;
    }
    if (key !== "teacherScores") {
      state.sources[key] = `${file.name} · 浏览器保存`;
      persistMasterData(key);
    }
    openMasterEditor(key);
    render();
  } catch (error) {
    window.alert(`CSV 导入失败：${error.message}`);
  }
});
els.closeDrawerButton.addEventListener("click", closeDrawer);
els.drawerBackdrop.addEventListener("click", closeDrawer);
els.exportSelectedButton.addEventListener("click", exportSelectedTeacher);
els.exportAllButton.addEventListener("click", exportAllTeachers);
document.querySelectorAll("[data-template]").forEach((button) => {
  button.addEventListener("click", () => downloadTemplate(button.dataset.template));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});

loadDefaults();
