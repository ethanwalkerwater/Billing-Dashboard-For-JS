import { PARENT_IDENTITY, STUDENT_IDENTITY } from "./monthly-feedback";
import type { MonthlyIdentity } from "./monthly-feedback";

/**
 * 月度反馈问卷，照飞书答卷表 tblk7U1Y4shjRhZB 的字段（2026-11-26 读取）。
 * field 是答卷表字段名，options 必须和飞书选项一字不差：写入不存在的选项时飞书会悄悄新建一个，评分就对不上了。
 * 改题流程：先改飞书表，再改这里，跑 `npm run check:questions`，然后部署 feedback-api 和学生页。
 */
export type MonthlyQuestionType = "single" | "multi" | "text";
export interface MonthlyQuestion {
  field: string;
  title: string;
  type: MonthlyQuestionType;
  required: boolean;
  options?: readonly string[];
  /** 选了「其他」后补充内容写进的字段；没有这个字段的题，「其他」就只是一个选项。 */
  otherField?: string;
}

export const OTHER_OPTION = "其他";
export const IDENTITY_FIELD = "身份";
export const SUGGESTION_MAX = 500;
export const OTHER_MAX = 200;

const STUDENT: MonthlyQuestion[] = [
  { field: "【学生】学习提升效果", title: "这段时间的课程，对您的成绩提升帮助有多大？", type: "single", required: true,
    options: ["帮助非常大，进步明显", "帮助较大，有一定提升", "帮助一般，提升有限", "帮助不大，收获较少"] },
  { field: "【学生】责任心与服务态度", title: "在整个课程期间，老师是否始终认真负责、态度热情、服务周到？", type: "single", required: true,
    options: ["是的，始终如此，非常满意", "大部分时候能做到，整体良好", "偶尔有所欠缺，但总体尚可", "有较明显的不足，希望改进"] },
  { field: "【学生】个人魅力", title: "您觉得这位老师的个人教学魅力如何？", type: "single", required: true,
    options: ["非常出色，深深吸引我投入学习", "较好，能够调动我的学习兴趣", "一般，课堂氛围较为平淡", "有待提升，较难引发我的学习热情"] },
  { field: "【学生】改进方面", title: "在日常学习过程中，您希望老师可以在哪些方面进一步提升？", type: "multi", required: false,
    otherField: "（选填）在日常学习过程中，您希望老师可以在哪些方面进一步提升？-其他-补充内容",
    options: ["已经很好了，没有需要提升的", "更得体的着装形象与职业气质", "更注重个人气味管理，保持清新的课堂气息", "更温和、鼓励性的语言表达方式",
      "更个性化地了解我的学习习惯与心理状态", "更灵活地调整教学节奏，适应我的学习状态", "更能激发我的学习主动性与自信心", "更加得体、更有分寸的谈吐", OTHER_OPTION] },
];
const PARENT: MonthlyQuestion[] = [
  { field: "【家长】学习提升效果", title: "这段时间的课程，您认为对孩子的成绩提升帮助有多大？", type: "single", required: true,
    options: ["帮助非常大，孩子进步明显", "帮助较大，孩子有一定提升", "帮助一般，提升较为有限", "帮助不大，收获较少"] },
  { field: "【家长】责任心与服务态度", title: "在整个课程期间，您感受到老师是否始终认真负责、态度热情、服务周到？", type: "single", required: true,
    options: ["是的，始终如此，非常满意", "大部分时候能做到，整体良好", "偶尔有所欠缺，但总体尚可", "有较明显的不足，希望改进"] },
  { field: "【家长】个人魅力", title: "您认为这位老师对学生的教学影响力如何？", type: "single", required: true,
    options: ["影响力非常显著，孩子在学习态度、思维方式和成绩上均有明显改变", "影响力较为积极，孩子的学习状态和兴趣有所提升",
      "影响力一般，孩子暂未呈现出明显的改变", "影响力有待加强，孩子的学习状态未见明显改善"] },
  { field: "顾问老师（Tinko）是否及时帮助学生优化课程安排：", title: "顾问老师（Tinko）是否及时帮助学生优化课程安排？", type: "single", required: true,
    options: ["已经很好了，不需要提升", "对沟通效率总体满意，但可以沟通更频繁", "基本满意，但可以更少打扰", "沟通稍有欠缺，建议多加反馈和沟通", "沟通太多，建议少打扰"] },
  { field: "【家长】改进方面", title: "在孩子的日常学习过程中，您希望老师可以在哪些方面进一步提升？", type: "multi", required: false,
    otherField: "【家长】改进方面其他",
    options: ["已经很好了，没有需要提升的", "更得体的着装形象与职业气质", "更温和、鼓励性的语言表达方式", "更个性化地了解孩子的学习习惯与心理状态",
      "课后能主动提供学习反馈和阶段性总结", "更灵活地调整教学节奏，适应孩子的学习状态", "更能激发孩子的学习主动性与自信心", OTHER_OPTION] },
];
const SHARED: MonthlyQuestion[] = [
  { field: "上课风格", title: "您如何评价这位老师的整体授课风格？", type: "single", required: false,
    otherField: "（选填）您如何评价这位老师的整体授课风格？-其他-补充内容",
    options: ["风趣幽默型 — 课堂氛围轻松活跃，善于调动学习热情", "严谨专注型 — 讲解严密深入，注重知识的系统性与准确性，课堂专注高效", OTHER_OPTION] },
  { field: "教学节奏", title: "您如何评价这位老师的教学进度与节奏把控？", type: "multi", required: false,
    options: ["高效紧凑型 — 知识点覆盖全面、推进迅速，适合基础扎实、学习节奏快的学生", "稳扎稳打型 — 讲解细致充分、循序渐进，注重每个知识点的理解与消化", OTHER_OPTION] },
  { field: "课堂互动", title: "您如何评价这位老师的课堂教学方式？", type: "single", required: false,
    options: ["系统讲授型 — 以老师讲解为主，知识体系完整、逻辑清晰，内容输出充分", "互动引导型 — 注重师生双向交流，善于通过提问、讨论引导学生主动思考"] },
  { field: "建议", title: "如果您可以对我们提一个最希望改进的建议，您最想说的是什么？", type: "text", required: false },
];

export const IDENTITY_OPTIONS: readonly MonthlyIdentity[] = [STUDENT_IDENTITY, PARENT_IDENTITY];

export function monthlyQuestions(identity: MonthlyIdentity): MonthlyQuestion[] {
  return [...(identity === STUDENT_IDENTITY ? STUDENT : PARENT), ...SHARED];
}

export const ALL_MONTHLY_QUESTIONS: readonly MonthlyQuestion[] = [...STUDENT, ...PARENT, ...SHARED];

/** 答案：key 是字段名（题目 field 或补充内容 otherField）。 */
export type MonthlyAnswers = Record<string, string | string[]>;

export function isAnswered(question: MonthlyQuestion, answers: MonthlyAnswers): boolean {
  const value = answers[question.field];
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim() !== "";
}
