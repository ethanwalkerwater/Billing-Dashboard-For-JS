import { cleanText, parseCsv, parseNumber } from "./report-core.js";

export const DEFAULT_PAYROLL_PARAMETERS = {
  fullTimeFeedbackBaseRate: 0.47,
  fullTimeFeedbackStepRate: 0.05,
  fullTimeFeedbackMaxRate: 0.62,
  partTimeLessonRate: 0.6,
  ownerCommissionRate: 0.2,
  serviceCommissionRate: 0.07,
  baseSalaryDeductionMultiplier: 1.2,
};

const NAME_ALIASES = {
  "Valentina 林": "Valentina Lin",
  "Valentina林": "Valentina Lin",
  "LOH JIAN WEN": "罗健文",
  "Loh Jian Wen": "罗健文",
  "王冰清": "王冰青",
  "华老师": "华心晨",
  "唐老师": "丁琪佳",
};

const MISSING = {
  baseSalary: "missing_base_salary",
  taxSocial: "missing_tax_social",
  tax: "missing_tax",
  socialInsurance: "missing_social_insurance",
  reimbursement: "missing_reimbursement",
  feedbackScore: "missing_feedback_score",
};

function round(value) {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function normalizeKey(value, aliases = {}) {
  const text = cleanText(value).replace(/老师$/u, "").replace(/\s+/g, "");
  const canonical = aliases[cleanText(value)] || aliases[text] || NAME_ALIASES[cleanText(value)] || NAME_ALIASES[text] || text;
  return cleanText(canonical).replace(/老师$/u, "").replace(/\s+/g, "").toLowerCase();
}

export function canonicalName(value, aliases = {}) {
  const text = cleanText(value);
  const compact = text.replace(/老师$/u, "").replace(/\s+/g, "");
  return aliases[text] || aliases[compact] || NAME_ALIASES[text] || NAME_ALIASES[compact] || text;
}

export function cleanStudentName(value) {
  return cleanText(value)
    .replace(/-\d+$/u, "")
    .replace(/-$/u, "")
    .trim();
}

function pick(row, candidates) {
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, name) && cleanText(row[name])) return row[name];
  }
  return "";
}

function rowName(row) {
  return pick(row, ["老师名字", "老师名", "老师", "姓名", "name", "Name"]);
}

function parseMoney(value) {
  return parseNumber(cleanText(value).replace(/¥/g, "")) ?? 0;
}

export function parseBaseSalaryCsv(csvText, options = {}) {
  const rows = parseCsv(csvText);
  return rows
    .map((row) => {
      const name = rowName(row);
      if (!cleanText(name)) return null;
      return {
        teacher: canonicalName(name, options.nameAliases),
        employmentType: cleanText(pick(row, ["雇佣属性", "属性", "类型"])) || "全职",
        baseSalary: parseMoney(pick(row, ["基础薪水", "基础收入 基础薪水", "基础收入-基础薪水", "底薪"])),
        managementFee: parseMoney(pick(row, ["管理费", "基础收入 管理费"])),
        marketingFee: parseMoney(pick(row, ["市场推广", "基础收入 市场推广"])),
        advisorFee: parseMoney(pick(row, ["教学顾问", "基础收入 教学顾问"])),
        schedulingFee: parseMoney(pick(row, ["排课", "基础收入 排课"])),
        adminFee: parseMoney(pick(row, ["行政前台", "基础收入 行政前台"])),
        rentDeduction: parseMoney(pick(row, ["房租扣除", "基础支出 房租扣除"])),
        sourceName: cleanText(name),
      };
    })
    .filter(Boolean);
}

export function parseStudentOwnershipCsv(csvText, options = {}) {
  return parseCsv(csvText)
    .map((row) => {
      const student = pick(row, ["学生姓名", "学生", "学生名"]);
      if (!cleanText(student)) return null;
      return {
        student: cleanStudentName(student),
        ownerTeacher: canonicalName(pick(row, ["归属老师(20%)", "归属老师", "介绍老师"]), options.nameAliases),
        serviceTeacher: canonicalName(pick(row, ["服务老师(7%)", "服务老师", "管理老师"]), options.nameAliases),
        sourceStudent: cleanText(student),
      };
    })
    .filter(Boolean);
}

export function parseTaxSocialCsv(csvText, options = {}) {
  return parseCsv(csvText)
    .map((row) => {
      const name = rowName(row);
      if (!cleanText(name)) return null;
      return {
        teacher: canonicalName(name, options.nameAliases),
        tax: parseMoney(pick(row, ["个税", "个人所得税", "tax"])),
        companySocialInsurance: parseMoney(pick(row, ["公司五险", "公司五险支出", "公司总支出", "五险公司总支出", "公司支出"])),
        personalSocialInsurance: parseMoney(pick(row, ["个人五险", "个人五险支出", "个人支出", "五险个人支出"])),
        sourceName: cleanText(name),
      };
    })
    .filter(Boolean);
}

function parseCsvMatrix(csvText) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const text = csvText.replace(/^\uFEFF/, "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
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
      if (row.some((value) => cleanText(value))) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => cleanText(value))) rows.push(row);
  }
  return rows;
}

export function parseReimbursementsCsv(csvText, options = {}) {
  const regularRows = parseCsv(csvText);
  const regular = regularRows
    .map((row) => {
      const name = rowName(row);
      const amount = pick(row, ["报销", "补贴报销", "5月报销", "报销金额", "金额"]);
      if (!cleanText(name) || !cleanText(amount)) return null;
      return {
        teacher: canonicalName(name, options.nameAliases),
        reimbursement: parseMoney(amount),
        sourceName: cleanText(name),
      };
    })
    .filter(Boolean);
  if (regular.length) return aggregateReimbursements(regular, options.nameAliases);

  const matrix = parseCsvMatrix(csvText);
  const headerIndex = matrix.findIndex((row) => row.some((cell) => cleanText(cell) === "老师"));
  if (headerIndex < 0) return [];
  const header = matrix[headerIndex].map(cleanText);
  const teacherIndex = header.findIndex((cell) => cell === "老师");
  const reimbursementIndex = header.findIndex((cell) => /报销/u.test(cell));
  if (teacherIndex < 0 || reimbursementIndex < 0) return [];

  return aggregateReimbursements(matrix.slice(headerIndex + 1)
    .map((row) => {
      const name = cleanText(row[teacherIndex]);
      const amount = cleanText(row[reimbursementIndex]);
      if (!name || /总报销|营业额|占比/u.test(name)) return null;
      return {
        teacher: canonicalName(name, options.nameAliases),
        reimbursement: parseMoney(amount),
        sourceName: name,
      };
    })
    .filter(Boolean), options.nameAliases);
}

function aggregateReimbursements(rows, aliases = {}) {
  const byTeacher = new Map();
  for (const row of rows) {
    const key = normalizeKey(row.teacher, aliases);
    const current = byTeacher.get(key) || {
      teacher: row.teacher,
      reimbursement: 0,
      sourceName: row.sourceName,
      sourceNames: [],
    };
    current.reimbursement = round(current.reimbursement + row.reimbursement);
    if (row.sourceName) current.sourceNames.push(row.sourceName);
    byTeacher.set(key, current);
  }
  return [...byTeacher.values()].map((row) => ({
    teacher: row.teacher,
    reimbursement: row.reimbursement,
    sourceName: [...new Set(row.sourceNames)].join(" / ") || row.sourceName,
  }));
}

export function parseTeacherScoresCsv(csvText, options = {}) {
  return parseCsv(csvText)
    .map((row) => {
      const name = rowName(row);
      if (!cleanText(name)) return null;
      const learning = parseNumber(pick(row, ["学习提升效果", "学习提升"]));
      const responsibility = parseNumber(pick(row, ["责任心与服务态度", "责任心"]));
      const charisma = parseNumber(pick(row, ["个人魅力"]));
      return {
        teacher: canonicalName(name, options.nameAliases),
        metrics: { learning, responsibility, charisma },
        sourceName: cleanText(name),
      };
    })
    .filter(Boolean);
}

function indexByTeacher(rows, aliases = {}) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row.teacher) continue;
    map.set(normalizeKey(row.teacher, aliases), row);
  }
  return map;
}

function indexReimbursementsByTeacher(rows, aliases = {}) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row.teacher) continue;
    const key = normalizeKey(row.teacher, aliases);
    const current = map.get(key) || { ...row, reimbursement: 0 };
    current.reimbursement = round(current.reimbursement + (row.reimbursement || 0));
    map.set(key, current);
  }
  return map;
}

function hasAllScores(score) {
  return Boolean(score) && Object.values(score.metrics || {}).every((value) => value != null && Number.isFinite(value));
}

function buildFeedbackRates(baseRows, scoreRows, params, aliases = {}) {
  const baseByTeacher = indexByTeacher(baseRows, aliases);
  const scoreByTeacher = indexByTeacher(scoreRows, aliases);
  const fullTimeScores = [];

  for (const [key, base] of baseByTeacher.entries()) {
    const score = scoreByTeacher.get(key);
    if (cleanText(base.employmentType) === "全职" && hasAllScores(score)) {
      fullTimeScores.push({ key, teacher: base.teacher, metrics: score.metrics });
    }
  }

  const winnersByMetric = new Map([
    ["learning", new Set()],
    ["responsibility", new Set()],
    ["charisma", new Set()],
  ]);
  const winnerCount = Math.floor(fullTimeScores.length * 0.5);

  for (const metric of winnersByMetric.keys()) {
    const sorted = fullTimeScores
      .slice()
      .sort((a, b) => b.metrics[metric] - a.metrics[metric] || a.teacher.localeCompare(b.teacher, "zh-CN"));
    const cutoff = winnerCount > 0 ? sorted[winnerCount - 1]?.metrics[metric] : null;
    sorted
      .filter((entry) => cutoff != null && entry.metrics[metric] >= cutoff)
      .forEach((entry) => winnersByMetric.get(metric).add(entry.key));
  }

  const rates = new Map();
  for (const row of baseRows || []) {
    const key = normalizeKey(row.teacher, aliases);
    const score = scoreByTeacher.get(key);
    if (cleanText(row.employmentType) !== "全职" || !hasAllScores(score)) {
      rates.set(key, {
        rate: params.partTimeLessonRate,
        type: "part_time",
        qualifiedMetrics: 0,
        missingScore: !hasAllScores(score),
      });
      continue;
    }

    const qualifiedMetrics = [...winnersByMetric.values()].filter((set) => set.has(key)).length;
    const rate = Math.min(
      params.fullTimeFeedbackMaxRate,
      params.fullTimeFeedbackBaseRate + qualifiedMetrics * params.fullTimeFeedbackStepRate,
    );
    rates.set(key, { rate, type: "full_time", qualifiedMetrics, missingScore: false });
  }
  return rates;
}

function buildStudentFees(reportData, month) {
  const fees = new Map();
  const students = reportData.entityOptions?.student?.[month] || [];
  for (const student of students) {
    const key = cleanStudentName(student.name).replace(/\s+/g, "").toLowerCase();
    fees.set(key, { student: cleanStudentName(student.name), amount: round(student.amount) });
  }
  return fees;
}

function buildCommissions(reportData, month, ownershipRows, params, aliases = {}) {
  const studentFees = buildStudentFees(reportData, month);
  const byTeacher = new Map();

  const add = (teacher, type, studentEntry, sourceStudent, rate) => {
    if (!teacher || !studentEntry) return;
    const key = normalizeKey(teacher, aliases);
    const current = byTeacher.get(key) || { ownerCommission: 0, serviceCommission: 0, rows: [] };
    const commissionBase = Math.max(studentEntry.amount, 0);
    const amount = round(commissionBase * rate);
    if (type === "owner") current.ownerCommission = round(current.ownerCommission + amount);
    if (type === "service") current.serviceCommission = round(current.serviceCommission + amount);
    current.rows.push({
      type,
      student: studentEntry.student,
      sourceStudent,
      teacher: canonicalName(teacher, aliases),
      studentFee: studentEntry.amount,
      commissionBase,
      rate,
      amount,
    });
    byTeacher.set(key, current);
  };

  for (const row of ownershipRows || []) {
    const studentKey = cleanStudentName(row.student).replace(/\s+/g, "").toLowerCase();
    const studentEntry = studentFees.get(studentKey);
    add(row.ownerTeacher, "owner", studentEntry, row.sourceStudent || row.student, params.ownerCommissionRate);
    add(row.serviceTeacher, "service", studentEntry, row.sourceStudent || row.student, params.serviceCommissionRate);
  }

  return byTeacher;
}

function teacherNamesForMonth(reportData, month, baseRows, extraRows) {
  const names = new Map();
  for (const option of reportData.entityOptions?.teacher?.[month] || []) names.set(normalizeKey(option.name), option.name);
  for (const row of baseRows || []) names.set(normalizeKey(row.teacher), row.teacher);
  for (const rows of extraRows) {
    for (const row of rows || []) names.set(normalizeKey(row.teacher), row.teacher);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function buildPayrollReport(reportData, input = {}) {
  const params = { ...DEFAULT_PAYROLL_PARAMETERS, ...(input.parameters || {}) };
  const aliases = input.nameAliases || {};
  const baseRows = input.baseSalaries || [];
  const ownershipRows = input.studentOwnership || [];
  const reimbursementRows = input.reimbursements || [];
  const taxSocialRows = input.taxSocial || [];
  const scoreRows = input.teacherScores || [];
  const baseByTeacher = indexByTeacher(baseRows, aliases);
  const reimbursementsByTeacher = indexReimbursementsByTeacher(reimbursementRows, aliases);
  const taxSocialByTeacher = indexByTeacher(taxSocialRows, aliases);
  const feedbackRates = buildFeedbackRates(baseRows, scoreRows, params, aliases);
  const months = reportData.months || [];
  const byMonth = {};

  for (const month of months) {
    const commissionsByTeacher = buildCommissions(reportData, month, ownershipRows, params, aliases);
    byMonth[month] = {};
    for (const teacher of teacherNamesForMonth(reportData, month, baseRows, [reimbursementRows, taxSocialRows])) {
      const key = normalizeKey(teacher, aliases);
      const base = baseByTeacher.get(key);
      const reimbursement = reimbursementsByTeacher.get(key);
      const taxSocial = taxSocialByTeacher.get(key);
      const feedback = feedbackRates.get(key) || {
        rate: params.partTimeLessonRate,
        type: "part_time",
        qualifiedMetrics: 0,
        missingScore: true,
      };
      const lessonFee = round(reportData.views?.teacher?.[month]?.[teacher]?.totals?.amount || 0);
      const commissions = commissionsByTeacher.get(key) || { ownerCommission: 0, serviceCommission: 0, rows: [] };
      const baseSalary = round(base?.baseSalary || 0);
      const lessonBonus = round(lessonFee * feedback.rate);
      const baseSalaryDeduction = round(baseSalary * params.baseSalaryDeductionMultiplier);
      const bonusSalary = round(lessonBonus + commissions.ownerCommission + commissions.serviceCommission - baseSalaryDeduction);
      const reimbursementAmount = round(reimbursement?.reimbursement || 0);
      const tax = round(taxSocial?.tax || 0);
      const personalSocialInsurance = round(taxSocial?.personalSocialInsurance || 0);
      const companySocialInsurance = round(taxSocial?.companySocialInsurance || 0);
      const personalTotalIncome = round(baseSalary + bonusSalary + reimbursementAmount - personalSocialInsurance - tax);
      const companyTotalCost = round(baseSalary + bonusSalary + reimbursementAmount + companySocialInsurance);
      const issues = [];
      if (!base) issues.push({ code: MISSING.baseSalary, label: "缺少基础薪水" });
      if (!taxSocial) issues.push({ code: MISSING.taxSocial, label: "缺少五险+个税" });
      if (!reimbursement) issues.push({ code: MISSING.reimbursement, label: "缺少报销，按 0 处理" });
      if (feedback.missingScore) issues.push({ code: MISSING.feedbackScore, label: "缺少反馈分数，按兼职 60% 处理" });
      if (bonusSalary < 0) issues.push({ code: "bonus_negative", label: "Bonus 为负数" });

      byMonth[month][teacher] = {
        teacher,
        employmentType: base?.employmentType || "未知",
        baseSalary,
        lessonFee,
        feedbackRate: feedback.rate,
        feedbackType: feedback.type,
        qualifiedMetrics: feedback.qualifiedMetrics,
        lessonBonus,
        ownerCommission: round(commissions.ownerCommission),
        serviceCommission: round(commissions.serviceCommission),
        commissionRows: commissions.rows,
        baseSalaryDeduction,
        bonusSalary,
        reimbursement: reimbursementAmount,
        personalSocialInsurance,
        companySocialInsurance,
        tax,
        personalTotalIncome,
        companyTotalCost,
        issues,
      };
    }
  }

  return { months, byMonth, parameters: params };
}
