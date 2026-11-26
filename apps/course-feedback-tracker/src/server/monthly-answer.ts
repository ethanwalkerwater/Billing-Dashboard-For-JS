import { FEEDBACK_MONTH_FIELD } from "../domain/form-url";
import {
  ALL_MONTHLY_QUESTIONS, IDENTITY_FIELD, IDENTITY_OPTIONS, monthlyQuestions, OTHER_MAX, OTHER_OPTION, SUGGESTION_MAX,
} from "../domain/monthly-questions";
import type { MonthlyIdentity } from "../domain/monthly-feedback";
import type { FeishuField } from "./feishu/types";

/** 把浏览器交来的答案校验成飞书答卷表的一行；只收白名单里的字段和选项。 */
export function answerFields(
  task: { student_name: string; teacher_canonical_name: string; course_month: string },
  identity: unknown, answers: unknown,
): { fields: Record<string, unknown> } | { error: string } {
  if (!IDENTITY_OPTIONS.includes(identity as MonthlyIdentity)) return { error: "请选择您的身份。" };
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { error: "答卷格式有误，请刷新后重试。" };
  const input = answers as Record<string, unknown>;
  const questions = monthlyQuestions(identity as MonthlyIdentity);
  const allowed = new Set(questions.flatMap((question) => [question.field, question.otherField ?? []].flat()));
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: "题目已更新，请刷新页面后重新填写。" };

  const fields: Record<string, unknown> = {
    学生姓名: task.student_name, 老师姓名: task.teacher_canonical_name, [FEEDBACK_MONTH_FIELD]: task.course_month, [IDENTITY_FIELD]: identity,
  };
  for (const question of questions) {
    const value = input[question.field];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      if (question.required) return { error: `请回答：${question.title}` };
      continue;
    }
    if (question.type === "text") {
      if (typeof value !== "string" || [...value].length > SUGGESTION_MAX) return { error: `建议请控制在 ${SUGGESTION_MAX} 字以内。` };
      if (value.trim()) fields[question.field] = value.trim();
      continue;
    }
    const picked = question.type === "multi" ? value : [value];
    if (!Array.isArray(picked) || picked.length === 0 || new Set(picked).size !== picked.length
      || !picked.every((option) => typeof option === "string" && question.options!.includes(option))) {
      return { error: "题目选项已更新，请刷新页面后重新填写。" };
    }
    fields[question.field] = question.type === "multi" ? picked : picked[0];
    if (question.otherField) {
      const other = input[question.otherField];
      if (other !== undefined && (typeof other !== "string" || [...other].length > OTHER_MAX)) return { error: `「其他」请控制在 ${OTHER_MAX} 字以内。` };
      if (picked.includes(OTHER_OPTION) && typeof other === "string" && other.trim()) fields[question.otherField] = other.trim();
    }
  }
  return { fields };
}

const TYPE = { single: 3, multi: 4, text: 1 } as const;
// 答卷表里我们不写、但知道的字段：自动字段、旧问卷留下的补充字段。
const KNOWN_EXTRA = new Set(["学生姓名", "老师姓名", FEEDBACK_MONTH_FIELD, "自动编号", "提交时间", "机构优势其他"]);

/** 菁仕页面写死的题目和飞书答卷表比对，返回给开发看的差异；学生、老师姓名的选项天天在变，不比。 */
export function formDrift(live: readonly FeishuField[]): string[] {
  const byName = new Map(live.map((field) => [field.field_name, field]));
  const problems: string[] = [];
  const compare = (name: string, type: number, options?: readonly string[]) => {
    const field = byName.get(name);
    if (!field) return problems.push(`飞书里找不到字段「${name}」（被删除或改名）`);
    if (field.type !== type) return problems.push(`字段「${name}」的类型变了`);
    if (!options) return;
    const names = (field.property?.options ?? []).map((option) => option.name);
    for (const option of options) if (!names.includes(option)) problems.push(`「${name}」少了选项「${option}」`);
    for (const option of names) if (!options.includes(option)) problems.push(`「${name}」多了选项「${option}」`);
  };
  compare(IDENTITY_FIELD, TYPE.single, IDENTITY_OPTIONS);
  for (const question of ALL_MONTHLY_QUESTIONS) {
    compare(question.field, TYPE[question.type], question.options);
    if (question.otherField) compare(question.otherField, TYPE.text);
  }
  const known = new Set([IDENTITY_FIELD, ...KNOWN_EXTRA, ...ALL_MONTHLY_QUESTIONS.flatMap((question) => [question.field, question.otherField ?? []].flat())]);
  for (const field of live) if (!known.has(field.field_name)) problems.push(`飞书新增了字段「${field.field_name}」`);
  for (const name of ["学生姓名", "老师姓名", FEEDBACK_MONTH_FIELD]) if (!byName.has(name)) problems.push(`飞书里找不到字段「${name}」`);
  return problems;
}
