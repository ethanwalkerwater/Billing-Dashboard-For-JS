import type { DetailRow } from "./report-types";

/** 问卷里「没什么要改进」的固定选项和常见客套话。默认隐藏，让真正的建议浮上来。 */
const NOTHING_TO_IMPROVE = "已经很好了，没有需要提升的";
const EMPTY_SUGGESTIONS = new Set(["无", "没有", "暂无", "无建议", "没有了", "都挺好的", "都很好", "很好", "挺好的", "/", "-"]);

/** 多选题的选项用「、」拼在一起（飞书导出形状），拆回一个个选项。 */
export function splitOptions(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[、|]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function improvementOptions(row: DetailRow): string[] {
  return [...splitOptions(row.texts.improvement_student), ...splitOptions(row.texts.improvement_parent)];
}

export function suggestionText(row: DetailRow): string {
  const text = (row.texts.suggestion ?? "").trim();
  return EMPTY_SUGGESTIONS.has(text.replace(/[。.！!]$/u, "")) ? "" : text;
}

/** 有没有值得看的内容：选了具体改进方向，或写了实际建议。 */
export function hasSubstance(row: DetailRow): boolean {
  return improvementOptions(row).some((option) => option !== NOTHING_TO_IMPROVE) || suggestionText(row) !== "";
}

export function isNothingToImprove(option: string): boolean {
  return option === NOTHING_TO_IMPROVE;
}

/** 合并后的身份显示：学生本人 / 家长 / 学生+家长 */
export function identityLabel(row: DetailRow): string {
  const source = row.sourceIdentities || row.identity;
  const student = /学生/u.test(source);
  const parent = /家长|监护/u.test(source);
  if (student && parent) return "学生+家长";
  return parent ? "家长" : "学生";
}
