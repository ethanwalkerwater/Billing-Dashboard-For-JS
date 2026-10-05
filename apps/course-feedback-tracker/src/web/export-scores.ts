import writeXlsxFile, { getSheetData } from "write-excel-file/browser";
import type { Column } from "write-excel-file/browser";

import { toCsv } from "@/server/export/csv";
import { DIMENSION_LABELS, METRICS } from "./report-types";
import type { Contribution, CumulativeTeacher, DetailRow, Dimension, TeacherScore } from "./report-types";
import { downloadBlob } from "./qr";

const HEADER = { fontWeight: "bold", backgroundColor: "#F4F4F5" } as const;
const SCORE = "0.000";

function text<T>(header: string, width: number, pick: (row: T) => string): Column<T> {
  return { header: { value: header, ...HEADER }, width, cell: (row) => ({ value: pick(row), type: String }) };
}

function num<T>(header: string, width: number, format: string, pick: (row: T) => number | null | undefined): Column<T> {
  return {
    header: { value: header, ...HEADER },
    width,
    cell: (row) => {
      const value = pick(row);
      // 无评分留空，不写 0：0 分会被当成真实低分参与 Excel 里的排序和平均。
      return value == null ? null : { value, type: Number, format };
    },
  };
}

/** 月度评分表。实时计算的月份带 学生/家长 分项；历史定稿月份只有总分。 */
export async function downloadMonthlyExcel(month: string, teachers: TeacherScore[], withVariants: boolean): Promise<string> {
  const dimensions: Dimension[] = withVariants ? ["total", "student", "parent"] : ["total"];
  const columns: Column<TeacherScore>[] = [
    num("排名", 6, "0", (row) => row.rank),
    text("老师", 16, (row) => row.teacher),
    num("课时", 8, "0.##", (row) => row.hours),
    num("反馈份数", 9, "0", (row) => row.responses),
    num("覆盖率", 8, "0%", (row) => row.coverage),
    ...METRICS.flatMap((metric) =>
      dimensions.map((dimension) =>
        num<TeacherScore>(
          dimension === "total" ? metric.label : `${metric.short}-${DIMENSION_LABELS[dimension]}`,
          dimension === "total" ? 16 : 13,
          SCORE,
          (row) => (dimension === "total" ? row.scores[metric.id] : row.variants?.[metric.id]?.[dimension]),
        ),
      ),
    ),
    num("总评分", 9, SCORE, (row) => row.overall),
  ];
  const fileName = `老师月度评分-${month}.xlsx`;
  await writeXlsxFile(teachers, { columns, sheet: month, stickyRowsCount: 1 }).toFile(fileName);
  return fileName;
}

/** 累计评分 + 逐月贡献两张表，可直接复算。 */
export async function downloadCumulativeExcel(label: string, teachers: CumulativeTeacher[], contributions: Contribution[]): Promise<string> {
  const summaryColumns: Column<CumulativeTeacher>[] = [
    num("排名", 6, "0", (row) => row.rank),
    text("老师", 16, (row) => row.teacher),
    ...METRICS.map((metric) => num<CumulativeTeacher>(metric.label, 16, SCORE, (row) => row.scores[metric.id])),
    num("总评分", 9, SCORE, (row) => row.overall),
    num("累计课时", 10, "0.##", (row) => row.hours),
    num("参与月份", 9, "0", (row) => row.monthCount),
    text("首月", 9, (row) => row.firstMonth),
    text("末月", 9, (row) => row.lastMonth),
    num("覆盖率", 8, "0%", (row) => row.coverage),
  ];
  const contributionColumns: Column<Contribution>[] = [
    text("课程月份", 10, (row) => row.month),
    text("老师", 16, (row) => row.teacher),
    num("当月课时（权重）", 14, "0.##", (row) => row.hours),
    ...METRICS.map((metric) => num<Contribution>(metric.label, 16, SCORE, (row) => row.scores[metric.id])),
    text("来源", 10, (row) => (row.source === "history" ? "历史定稿" : "实时计算")),
  ];
  const fileName = `老师累计评分-${label}.xlsx`;
  await writeXlsxFile([
    { data: getSheetData(teachers, summaryColumns), sheet: "累计评分", stickyRowsCount: 1, columns: summaryColumns.map((c) => ({ width: c.width })) },
    { data: getSheetData(contributions, contributionColumns), sheet: "逐月贡献", stickyRowsCount: 1, columns: contributionColumns.map((c) => ({ width: c.width })) },
  ]).toFile(fileName);
  return fileName;
}

/**
 * 与老看板 teacher_scores.csv 完全同格式（排名,老师,三项,总评分；三位小数；无评分写「无评分」），
 * 家长报告的 sync:cumulative-teacher-scores 可以直接吃。
 */
export function downloadScoresCsv(fileName: string, teachers: Array<Pick<CumulativeTeacher, "rank" | "teacher" | "scores" | "overall">>) {
  const format = (value: number | null) => (value == null ? "无评分" : value.toFixed(3));
  const headers = ["排名", "老师", ...METRICS.map((metric) => metric.label), "总评分"];
  const rows = teachers.map((row) => ({
    排名: row.rank ?? "",
    老师: row.teacher,
    ...Object.fromEntries(METRICS.map((metric) => [metric.label, format(row.scores[metric.id])])),
    总评分: format(row.overall),
  }));
  downloadBlob(new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" }), fileName);
}

export function downloadTextsCsv(fileName: string, rows: DetailRow[]) {
  const headers = ["老师", "学生", "身份", "提交时间", "学员改进反馈", "家长改进反馈", "其他建议"];
  downloadBlob(
    new Blob(
      [
        toCsv(
          headers,
          rows.map((row) => ({
            老师: row.teacher,
            学生: row.student,
            身份: row.sourceIdentities || row.identity,
            提交时间: row.submittedAt,
            学员改进反馈: row.texts.improvement_student ?? "",
            家长改进反馈: row.texts.improvement_parent ?? "",
            其他建议: row.texts.suggestion ?? "",
          })),
        ),
      ],
      { type: "text/csv;charset=utf-8" },
    ),
    fileName,
  );
}
