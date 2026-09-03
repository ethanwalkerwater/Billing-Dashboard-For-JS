const COLORS = {
  ink: "#18212B",
  accent: "#C99A54",
  pale: "#F5F1E8",
  white: "#FFFFFF",
  line: "#D8DEE6",
};

const FONT = "Microsoft YaHei";
const CURRENCY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00';

function titleCell(value, span) {
  return {
    value,
    columnSpan: span,
    height: 30,
    fontFamily: FONT,
    fontSize: 16,
    fontWeight: "bold",
    textColor: COLORS.white,
    backgroundColor: COLORS.ink,
    alignVertical: "center",
  };
}

function headerCell(value) {
  return {
    value,
    height: 24,
    fontFamily: FONT,
    fontWeight: "bold",
    textColor: COLORS.white,
    backgroundColor: COLORS.ink,
    bottomBorderColor: COLORS.accent,
    bottomBorderStyle: "thick",
    align: "center",
    alignVertical: "center",
    wrap: true,
  };
}

function bodyCell(value, format) {
  return {
    value: value ?? "",
    fontFamily: FONT,
    fontSize: 10,
    textColor: COLORS.ink,
    bottomBorderColor: COLORS.line,
    bottomBorderStyle: "hair",
    alignVertical: "center",
    wrap: true,
    ...(format ? { format } : {}),
  };
}

function sectionRow(title, span) {
  return [
    {
      value: title,
      columnSpan: span,
      height: 24,
      fontFamily: FONT,
      fontWeight: "bold",
      textColor: COLORS.ink,
      backgroundColor: COLORS.pale,
      alignVertical: "center",
    },
    ...Array.from({ length: Math.max(0, span - 1) }, () => null),
  ];
}

function spannedTitleRow(title, span) {
  return [titleCell(title, span), ...Array.from({ length: Math.max(0, span - 1) }, () => null)];
}

function safeSheetName(value) {
  const cleaned = String(value || "老师")
    .replace(/[\\/*?:\[\]]/g, "-")
    .replace(/^'+|'+$/g, "")
    .trim();
  return (cleaned || "老师").slice(0, 31);
}

function uniqueSheetName(usedNames, preferred) {
  const base = safeSheetName(preferred);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function summarySheet(model) {
  const span = model.summaryHeaders.length;
  const data = [
    spannedTitleRow(`老师收入汇总 · ${model.month}`, span),
    [null],
    model.summaryHeaders.map(headerCell),
    ...model.summaryRows.map((row) => row.map((value, index) => {
      const column = index + 1;
      const format = model.summaryCurrencyColumns.includes(column)
        ? CURRENCY_FORMAT
        : model.summaryRateColumns.includes(column)
          ? "0%"
          : "";
      return bodyCell(value, format);
    })),
  ];
  return {
    data,
    sheet: "本月汇总",
    columns: model.summaryHeaders.map((header, index) => ({
      width: index === 0 ? 14 : header.includes("提醒") ? 28 : header.includes("属性") ? 11 : 15,
    })),
    stickyRowsCount: 3,
    showGridLines: false,
    orientation: "landscape",
  };
}

function teacherSheet(model, teacher, usedNames) {
  const span = Math.max(
    teacher.lessonHeaders.length,
    teacher.financialHeaders.length,
    teacher.commissionHeaders.length,
  );
  const metaValues = [
    "雇佣属性",
    teacher.employmentType,
    "个人总收入",
    teacher.personalTotalIncome,
    "公司总成本",
    teacher.companyTotalCost,
  ];
  const metaRow = metaValues.map((value, index) => ({
    ...bodyCell(value, index === 3 || index === 5 ? CURRENCY_FORMAT : ""),
    fontWeight: index % 2 === 0 ? "bold" : undefined,
    backgroundColor: COLORS.pale,
  }));
  const financialRows = teacher.financialRows.map((row) => row.map((value, index) => (
    bodyCell(value, index === 4 ? CURRENCY_FORMAT : "")
  )));
  const lessonRows = teacher.lessonRows.map((row) => row.map((value, index) => (
    bodyCell(value, teacher.lessonCurrencyColumns.includes(index + 1) ? CURRENCY_FORMAT : "")
  )));
  const commissionRows = teacher.commissionRows.map((row) => row.map((value, index) => (
    bodyCell(value, index === 3 || index === 5 ? CURRENCY_FORMAT : index === 4 ? "0%" : "")
  )));

  return {
    data: [
      spannedTitleRow(`${teacher.teacher} · ${model.month} 工资情况`, span),
      metaRow,
      [null],
      sectionRow("收入计算", span),
      teacher.financialHeaders.map(headerCell),
      ...financialRows,
      [null],
      sectionRow("课时费明细", span),
      teacher.lessonHeaders.map(headerCell),
      ...lessonRows,
      [null],
      sectionRow("提成来源明细", span),
      teacher.commissionHeaders.map(headerCell),
      ...commissionRows,
    ],
    sheet: uniqueSheetName(usedNames, teacher.teacher),
    columns: Array.from({ length: span }, (_, index) => ({
      width: index === 0 ? 14 : index === 1 ? 18 : index >= 7 ? 16 : 15,
    })),
    stickyRowsCount: 3,
    showGridLines: false,
    orientation: "landscape",
  };
}

export function buildIncomeWorkbookSheets(model) {
  const usedNames = new Set(["本月汇总"]);
  return [
    summarySheet(model),
    ...model.teachers.map((teacher) => teacherSheet(model, teacher, usedNames)),
  ];
}

export function buildIncomeWorkbook(writeXlsxFile, model) {
  if (typeof writeXlsxFile !== "function") throw new Error("XLSX 导出组件未加载");
  return writeXlsxFile(buildIncomeWorkbookSheets(model));
}
