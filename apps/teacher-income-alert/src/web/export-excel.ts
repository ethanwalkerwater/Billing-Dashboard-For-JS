import writeXlsxFile from "write-excel-file/browser";
import type { Column } from "write-excel-file/browser";

import { STATUS_LABELS } from "@/domain/income";
import type { Rates } from "@/domain/income";
import type { TeacherLine } from "./useIncomeData";

const HEADER = { fontWeight: "bold", backgroundColor: "#F4F4F5" } as const;
const INT = "#,##0";
const SIGNED = "+#,##0;-#,##0;0";

function text(header: string, width: number, pick: (line: TeacherLine) => string): Column<TeacherLine> {
  return { header: { value: header, ...HEADER }, width, cell: (line) => ({ value: pick(line), type: String }) };
}

function num(header: string, width: number, format: string, pick: (line: TeacherLine) => number | null): Column<TeacherLine> {
  return {
    header: { value: header, ...HEADER },
    width,
    cell: (line) => {
      const value = pick(line);
      return value == null ? null : { value, type: Number, format };
    },
  };
}

/** 表里看到的每一列都导出，口径和页面一致；数字保留为数字，教务能直接再算。 */
export function buildExcelColumns(rates: Rates): Column<TeacherLine>[] {
  return [
    text("老师", 14, (l) => l.teacher),
    text("状态", 8, (l) => STATUS_LABELS[l.status]),
    num("基础薪水", 10, INT, (l) => l.settings.baseSalary),
    num("本月课时费", 12, INT, (l) => l.lessonFee),
    num("节数", 6, "0", (l) => l.lessons),
    num("小时", 8, "0.##", (l) => l.hours),
    num(`预测最低 ×${rates.min}`, 14, INT, (l) => l.predictedMin),
    num(`预测最高 ×${rates.max}`, 14, INT, (l) => l.predictedMax),
    num("距脱离预警", 12, SIGNED, (l) => l.marginToAlert),
    num("距达标", 12, SIGNED, (l) => l.marginToTarget),
    num("课程单价", 10, INT, (l) => l.unitPrice),
    num("脱离预警需加(h)", 14, "0.#", (l) => l.hoursToAlert),
    num("达标需加(h)", 12, "0.#", (l) => l.hoursToTarget),
    text("备注", 24, (l) => l.settings.note),
    text("学生", 60, (l) => l.students.join("、")),
  ];
}

export async function downloadExcel(lines: TeacherLine[], rates: Rates, month: string): Promise<string> {
  const fileName = `教师薪资预警-${month}.xlsx`;
  await writeXlsxFile(lines, { columns: buildExcelColumns(rates), sheet: month, stickyRowsCount: 1 }).toFile(fileName);
  return fileName;
}
