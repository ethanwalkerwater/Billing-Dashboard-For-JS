const MONEY_PRECISION = 100;

function round(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * MONEY_PRECISION) / MONEY_PRECISION;
}

export function buildRequiredSelectChoices(current, values, placeholderLabel) {
  const selectedValue = String(current || "").trim();
  const options = [...new Set(
    values.map((value) => String(value || "").trim()).filter(Boolean),
  )];
  if (selectedValue && !options.includes(selectedValue)) options.unshift(selectedValue);
  return [
    {
      value: "",
      label: placeholderLabel,
      selected: !selectedValue,
      placeholder: true,
    },
    ...options.map((value) => ({
      value,
      label: value,
      selected: value === selectedValue,
      placeholder: false,
    })),
  ];
}

function baselineLine(line) {
  return {
    teacher: line.teacher,
    courseType: line.courseType,
    teachingType: line.teachingType,
    duration: Number(line.duration || 0),
    unitPrice: Number(line.unitPrice || 0),
    cancellationPercent: inferCancellationPercent(line),
    payableAmount: Number(line.payableAmount || 0),
  };
}

function inferCancellationPercent(line) {
  if (!line.isLeave && line.status === "正常上课") return 0;
  const match = String(line.status || "").match(/(\d+(?:\.\d+)?)%/);
  if (match) return Number(match[1]);
  const gross = Number(line.grossAmount || 0);
  const payable = Number(line.payableAmount || 0);
  if (gross > 0) return round((payable / gross) * 100);
  return 0;
}

function changedFields(line) {
  const baseline = line._baseline;
  if (!baseline) return [];
  return [
    "teacher",
    "courseType",
    "teachingType",
    "duration",
    "unitPrice",
    "cancellationPercent",
    "payableAmount",
  ].filter((field) => String(line[field] ?? "") !== String(baseline[field] ?? ""));
}

function recalculateLine(line, { keepPayable = false } = {}) {
  const grossAmount = round(Number(line.unitPrice || 0) * Number(line.duration || 0));
  const isLeave = line.isLeave || line.status !== "正常上课";
  const normalRate = Number.isFinite(Number(line.discountRate))
    ? Number(line.discountRate) / 100
    : 1;
  const automaticRate = isLeave
    ? Number(line.cancellationPercent || 0) / 100
    : normalRate;
  const payableAmount = keepPayable
    ? round(line.payableAmount)
    : round(grossAmount * automaticRate);
  const discountAmount = round(grossAmount - payableAmount);

  const next = {
    ...line,
    isLeave,
    grossAmount,
    payableAmount,
    discountAmount,
    discountRate: grossAmount > 0 ? round((payableAmount / grossAmount) * 100) : 100,
    billingNote: isLeave ? `请假 ${Number(line.cancellationPercent || 0)}%` : "—",
    unitPriceLabel: Number(line.unitPrice || 0).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    }),
  };
  next._changedFields = changedFields(next);
  return next;
}

export function recomputeReportTotals(report) {
  const totals = report.courseLines.reduce((sum, line) => ({
    duration: sum.duration + Number(line.duration || 0),
    grossAmount: sum.grossAmount + Number(line.grossAmount || 0),
    discountAmount: sum.discountAmount + Number(line.discountAmount || 0),
    payableAmount: sum.payableAmount + Number(line.payableAmount || 0),
    cancelledDuration: sum.cancelledDuration + Number(line.cancelledDuration || 0),
  }), {
    duration: 0,
    grossAmount: 0,
    discountAmount: 0,
    payableAmount: 0,
    cancelledDuration: 0,
  });

  return {
    ...report,
    totals: Object.fromEntries(
      Object.entries(totals).map(([key, value]) => [key, round(value)]),
    ),
  };
}

export function prepareReportForEditing(report) {
  const next = structuredClone(report);
  next.courseLines = next.courseLines.map((line) => {
    const prepared = {
      ...line,
      cancellationPercent: inferCancellationPercent(line),
      manualPayable: false,
      adjustmentReason: "",
      _baseline: baselineLine(line),
      _changedFields: [],
    };
    return recalculateLine(prepared, { keepPayable: true });
  });
  return recomputeReportTotals(next);
}

export function updateCourseLine(report, index, field, value) {
  const next = structuredClone(report);
  const line = { ...next.courseLines[index] };
  const numericFields = new Set(["duration", "unitPrice", "cancellationPercent", "payableAmount"]);
  line[field] = numericFields.has(field) ? Number(value) : value;

  if (field === "payableAmount") {
    line.manualPayable = true;
  } else if (["duration", "unitPrice", "cancellationPercent"].includes(field)) {
    line.manualPayable = false;
  }

  next.courseLines[index] = recalculateLine(line, {
    keepPayable: line.manualPayable || field === "adjustmentReason",
  });
  return recomputeReportTotals(next);
}

function lessonMatchesLine(lesson, baseline) {
  return lesson.teacher === baseline.teacher
    && lesson.courseType === baseline.courseType
    && lesson.teachingType === baseline.teachingType;
}

export function buildConfirmedReport(report) {
  const next = structuredClone(report);
  const editedLines = next.courseLines.map((line) => ({ ...line }));

  next.lessons = next.lessons.map((lesson) => {
    const edited = editedLines.find((line) => lessonMatchesLine(lesson, line._baseline));
    if (!edited) return lesson;
    return {
      ...lesson,
      teacher: edited.teacher,
      courseType: edited.courseType,
      teachingType: edited.teachingType,
    };
  });

  for (const cell of next.calendar.cells) {
    cell.lessons = next.lessons.filter((lesson) => lesson.date === cell.date);
  }

  next.activeTeacherNames = [...new Set(
    next.courseLines.map((line) => line.teacher).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b, "zh-CN"));

  next.courseLines = next.courseLines.map((line) => {
    const clean = { ...line };
    delete clean._baseline;
    delete clean._changedFields;
    delete clean.manualPayable;
    delete clean.cancellationPercent;
    clean.discountReason = clean.adjustmentReason || clean.discountReason;
    delete clean.adjustmentReason;
    return clean;
  });

  return next;
}

export function validateReport(report) {
  const issues = [];
  report.courseLines.forEach((line, index) => {
    const row = index + 1;
    if (!String(line.teacher || "").trim()) issues.push({ level: "error", row, message: "授课老师不能为空" });
    if (!String(line.courseType || "").trim()) issues.push({ level: "error", row, message: "课程名称不能为空" });
    if (!String(line.teachingType || "").trim()) issues.push({ level: "error", row, message: "授课类型不能为空" });
    if (!Number.isFinite(line.duration) || line.duration < 0) issues.push({ level: "error", row, message: "课时必须是非负数字" });
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) issues.push({ level: "error", row, message: "课程单价必须是非负数字" });
    if (!Number.isFinite(line.cancellationPercent) || line.cancellationPercent < 0 || line.cancellationPercent > 100) {
      issues.push({ level: "error", row, message: "取消比例必须在 0–100% 之间" });
    }
    if (!Number.isFinite(line.payableAmount) || line.payableAmount < 0) {
      issues.push({ level: "error", row, message: "应付金额必须是非负数字" });
    }
    if (line.manualPayable && !String(line.adjustmentReason || "").trim()) {
      issues.push({ level: "error", row, message: "手动覆盖应付金额时必须填写修改原因" });
    }
  });

  const lessonDuration = round(report.lessons.reduce((sum, lesson) => sum + Number(lesson.duration || 0), 0));
  if (lessonDuration !== round(report.totals.duration)) {
    issues.push({
      level: "warning",
      row: null,
      message: `汇总课时 ${report.totals.duration}h 与课表有效课时 ${lessonDuration}h 不一致`,
    });
  }
  return issues;
}

export function collectInvalidReports(reports) {
  return reports.flatMap((report, index) => {
    const errors = validateReport(report).filter((issue) => issue.level === "error");
    if (!errors.length) return [];
    return [{
      index,
      studentName: String(report.studentName || "未命名学生"),
      monthLabel: String(report.monthLabel || report.month || "月份未填写"),
      errors,
    }];
  });
}

export function formatMoney(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
  })}`;
}

export function hasChanges(report) {
  return report.courseLines.some((line) => line._changedFields?.length);
}
