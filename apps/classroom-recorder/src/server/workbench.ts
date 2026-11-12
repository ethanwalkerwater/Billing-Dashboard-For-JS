/**
 * 菁仕工作台的纯逻辑：飞书课表 / 学员信息 → 紧凑行，学情报告 → 工作台用的单节学情，月报和画像建议的提示词与校验。
 * 云函数（functions/classroom-api/workbench.ts）和网页（src/workbench/main.js）共用这里的常量。
 */
import type { ClassReport } from "./logic";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 画像四块；AI 只提前两块，后两块课上听不出来 */
export const PKEYS = ["学习偏好", "沟通注意", "辅导经历", "家长沟通"] as const;
export const AI_KEYS = ["学习偏好", "沟通注意"] as const;
/** 画像标签词表：建档、AI 建议都只用这些词，新词要人加进词表 */
export const PRESET: Record<string, { ask: string; tags: string[] }> = {
  学习偏好: { ask: "他在什么情况下学得最好？讲例子还是讲原理？", tags: ["例子先行", "先讲原理", "多做题", "需要即时反馈", "喜欢自己琢磨", "专注 40 分钟左右"] },
  沟通注意: { ask: "他听不懂时会怎样？有什么话不能说？", tags: ["不主动提问", "答错时会沉默", "需要鼓励", "怕被批评", "避免横向比较", "慢热"] },
  辅导经历: { ask: "以前补过什么，为什么停了？", tags: ["没补过", "大班课跟不上", "一对一 6 个月", "换过老师", "上一家缺少反馈", "自学为主"] },
  家长沟通: { ask: "谁做决定？怎么联系？最在意什么？", tags: ["妈妈决定", "爸爸决定", "微信", "电话", "21:00 后回复", "工作日白天不方便", "关心每节课内容", "只看成绩", "对考试焦虑"] },
};
/** 学员列表默认两列：标记（单选，选项和颜色教务自己定）和备注 */
export const DEFAULT_FIELDS = [
  { id: "mark", name: "标记", type: "select", options: [["重点关注", "bad"], ["待加课", "info"], ["准备结课", "warn"], ["待续费", "warn"], ["正常", "good"]] },
  { id: "note", name: "备注", type: "text" },
];
export const STAGES = ["咨询", "试听", "在读", "暂停", "结课"] as const;

// ---------- 上海时区的月份 ----------

const sh = (ms: number) => new Date(ms + 8 * HOUR).toISOString();
export const monthOf = (ms: number) => sh(ms).slice(0, 7);
/** 某月 [1 日 0 点, 下月 1 日 0 点)，上海时间 */
export function monthRange(month: string): [number, number] {
  const [y, m] = month.split("-").map(Number);
  return [Date.UTC(y, m - 1, 1) - 8 * HOUR, Date.UTC(y, m, 1) - 8 * HOUR];
}
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
/** 打开工作台时带上的月份：往前 3 个月（「我的学员」看最近 90 天）到下个月 */
export const windowMonths = (now: number) => [-3, -2, -1, 0, 1].map((n) => addMonths(monthOf(now), n));
/** 打开时发给网页的月份：上个月到下个月；更早的课表翻到再拉，学生档案里按学生拉 */
export const sendMonths = (now: number) => [-1, 0, 1].map((n) => addMonths(monthOf(now), n));

/**
 * 发给网页的课：字符串放进字典，一行约 50 字节（一个月全部老师约 1700 节）。
 * 行 = [编号, 开始（分钟）, 时长（分钟）, 学生[], 课程, 老师, 地点, 授课类型, 临时取消, 试听, 录课状态]，学生到临时取消都是字典下标
 */
export function encodeLessons(rows: LessonRow[], states: Map<string, string>) {
  const dict: string[] = [];
  const index = new Map<string, number>();
  const at = (value: string) => { let i = index.get(value); if (i === undefined) { i = dict.length; dict.push(value); index.set(value, i); } return i; };
  return {
    dict,
    rows: rows.map((r) => [r[0], Math.round(r[1] / 60_000), Math.round((r[2] - r[1]) / 60_000), r[3].map(at), at(r[5]), at(r[6]), at(r[7]), at(r[8]), at(r[9]), r[10], states.get(r[0]) ?? ""]),
  };
}
export const isMonth = (value: unknown): value is string => typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
/**
 * 课表快照多久算过期：当月和下月 10 分钟（改课、取消多发生在这两个月），更早的一天，
 * 再往后的月份一天（排得很远的课不常改）。force = 页面上点「刷新」，1 分钟内不重复拉。
 */
export function staleAfter(month: string, now: number, force = false) {
  if (force) return 60_000;
  const cur = monthOf(now);
  return month === cur || month === addMonths(cur, 1) ? 10 * 60_000 : DAY;
}

// ---------- 飞书「课程表管理」→ 紧凑行 ----------

export const LESSON_FIELDS = ["学生", "老师课程ID", "课程类型", "老师", "上课时间", "下课时间", "课程时长", "上课地点", "授课类型", "临时取消", "价格优惠"];
/** [编号, 开始, 结束, 学生 record_id[], 学生名（课表标签里的）, 课程, 老师, 地点, 授课类型, 临时取消, 试听 0/1] */
export type LessonRow = [string, number, number, string[], string, string, string, string, string, string, number];
/** 真上课：会议、咨询、考试不算，取消的也不算。老师的「我的学员」只按这个算 */
export const isTeaching = (r: LessonRow) => !r[9] && !/会议/.test(r[8]) && !/会议|咨询|到访|对接会|考试|模考|模测/.test(r[5]);

function str(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(str).filter(Boolean).join("+");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) return str(record.value);
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.name === "string") return record.name.trim();
  }
  return "";
}
function ms(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n;
  return null;
}
/** 「15:30-16:30｜张浩然｜IG数学｜1v1」→ 张浩然 */
function labelName(label: string) {
  const parts = label.split(/[｜│|]/).map((part) => part.trim());
  const i = parts.findIndex((part) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(part));
  return i >= 0 ? parts[i + 1] ?? "" : "";
}

const PLACEHOLDER = /^(空出|可排课|休息|请假|春节假期|课表确定|准备)$/;
export function parseLesson(record: { record_id: string; fields: Record<string, unknown> }): LessonRow | null {
  const f = record.fields;
  const startAt = ms(f["上课时间"]);
  const course = str(f["课程类型"]);
  // 没有课程也没有老师的是整天的占位行；「空出」「可排课」这类是给排课占的时段，都不算课
  if (startAt == null || (!course && !str(f["老师"])) || PLACEHOLDER.test(course)) return null;
  const hours = Number(str(f["课程时长"])) || 1;
  const link = f["学生"] as { link_record_ids?: string[] } | undefined;
  const discount = str(f["价格优惠"]);
  return [
    record.record_id, startAt, ms(f["下课时间"]) ?? startAt + hours * HOUR,
    Array.isArray(link?.link_record_ids) ? link.link_record_ids : [],
    labelName(str(f["老师课程ID"])), course, str(f["老师"]), str(f["上课地点"]), str(f["授课类型"]), str(f["临时取消"]),
    discount.startsWith("试听") || course.includes("试听") ? 1 : 0,
  ];
}

/** 飞书 search 条件：ExactDate 只精确到天，前后各放宽一天，再按 monthOf 精确筛 */
export function monthFilter(month: string) {
  const [from, to] = monthRange(month);
  return {
    conjunction: "and" as const,
    conditions: [
      { field_name: "上课时间", operator: "isGreater", value: ["ExactDate", String(from - DAY)] },
      { field_name: "上课时间", operator: "isLess", value: ["ExactDate", String(to + DAY)] },
    ],
  };
}

// ---------- 飞书「学员信息」 ----------

export const ROSTER_FIELDS = ["学生姓名", "所读学校", "学制", "当前学员年级", "出生日期", "联系方式n", "渠道信息", "负责老师", "归属老师(20%)", "服务老师(7%)", "排课提醒", "在读", "备注", "创建日期"];
export interface RosterStudent {
  id: string; name: string; school: string; system: string; grade: string; birth: string; contact: string; channel: string;
  owner: string; ownerTeacher: string; serviceTeacher: string; remind: string; status: string; note: string; created: number;
}
const isoDate = (value: number | null) => (value == null ? "" : sh(value).slice(0, 10));

export function parseRoster(record: { record_id: string; fields: Record<string, unknown> }): RosterStudent {
  const f = record.fields;
  const system = str(f["学制"]);
  const g = str(f["当前学员年级"]);
  return {
    id: record.record_id, name: str(f["学生姓名"]), school: str(f["所读学校"]), system,
    grade: !Number(g) ? "" : system.startsWith("13") ? `Year ${g}` : system.startsWith("12") ? `Grade ${g}` : `${g} 年级`,
    birth: isoDate(ms(f["出生日期"])), contact: str(f["联系方式n"]), channel: str(f["渠道信息"]), owner: str(f["负责老师"]),
    ownerTeacher: str(f["归属老师(20%)"]), serviceTeacher: str(f["服务老师(7%)"]), remind: str(f["排课提醒"]), status: str(f["在读"]),
    note: str(f["备注"]), created: ms(f["创建日期"]) ?? 0,
  };
}
/** 老师看不到提成相关的字段 */
export const forTeacher = ({ ownerTeacher, serviceTeacher, channel, ...rest }: RosterStudent) => rest;

/** 新建学员写回飞书的字段；年级只取数字，飞书按「初始年级 + 创建日期」自己算当前年级 */
export function rosterFields(input: { name: string; school?: string; grade?: string; system?: string; parent?: string; channel?: string }) {
  const fields: Record<string, unknown> = { 学生姓名: input.name, 在读: "在读" };
  if (input.school) fields["所读学校"] = input.school;
  if (input.system === "12 年制" || input.system === "13 年制") fields["学制"] = input.system;
  const grade = Number(input.grade?.match(/\d{1,2}/)?.[0]);
  if (grade) fields["学生年级-初始记录"] = grade;
  if (input.parent) fields["联系方式n"] = input.parent;
  if (input.channel) fields["渠道信息"] = input.channel;
  return fields;
}

/** 飞书「排课提醒」混了阶段和排课进度，只取阶段那几项；工作台里改过的以工作台为准 */
export function stageOf(roster: Pick<RosterStudent, "remind" | "status"> | undefined, saved: string | null | undefined, recent: boolean): string {
  if (saved && (STAGES as readonly string[]).includes(saved)) return saved;
  const remind = roster?.remind ?? "";
  if (remind.includes("试听")) return "试听";
  if (remind.includes("暂时结课")) return "暂停";
  if (remind.includes("结课")) return "结课";
  return recent || roster?.status === "在读" ? "在读" : "结课";
}

// ---------- 菁仕课堂的学情报告 → 单节学情 ----------

/** 每节课的掌握情况：g 都掌握，a 有要巩固的，r 大半要巩固 */
export function masteryKey(report: Pick<ClassReport, "mastery"> | null | undefined): "g" | "a" | "r" {
  const all = report?.mastery ?? [];
  const weak = all.filter((m) => m.status === "需要巩固").length;
  return !weak ? "g" : weak / all.length > 0.6 ? "r" : "a";
}

export interface Rep { topic: string; kps: Array<[string, string]>; hw: string; issue: string; next: string; perf: string; qs: string[]; review: string }
export function repOf(report: ClassReport): Rep {
  const issue = [report.issue?.title, report.issue?.fix].filter(Boolean).map((s) => s!.replace(/[。.]$/, "")).join("。");
  return {
    topic: report.topic ?? "",
    kps: (report.mastery ?? []).map((m) => [m.name, m.status === "需要巩固" ? "需要巩固" : "已掌握"]),
    hw: report.homework ?? "", issue: issue ? `${issue}。` : "", next: report.next ?? "", perf: report.performance ?? "",
    qs: (report.questions ?? []).map((q) => q.text).filter(Boolean), review: report.review ?? "",
  };
}

// ---------- 月报 ----------

export interface MonthRep { sum: string; good: string[]; weak: string[]; adv: string }
export interface MonthInput { student: string; course: string; month: string; lessons: Array<{ date: string; report: ClassReport }>; total: number; cancelled: number }

/** 掌握得好 / 还要巩固直接按每个知识点最后一次的状态算，不让模型挑；模型只写「本月讲了」和「下月建议」 */
export function monthPoints(lessons: MonthInput["lessons"]) {
  const last = new Map<string, string>();
  for (const { report } of [...lessons].sort((a, b) => a.date.localeCompare(b.date))) for (const m of report.mastery ?? []) last.set(m.name, m.status);
  const pick = (want: (s: string) => boolean) => [...last].filter(([, s]) => want(s)).map(([n]) => n).slice(0, 6);
  return { good: pick((s) => s === "基本掌握"), weak: pick((s) => s === "需要巩固") };
}

export function monthPrompt(input: MonthInput) {
  const { good, weak } = monthPoints(input.lessons);
  const lines = input.lessons.map(({ date, report }) => [
    `${date}：${report.topic}`,
    `  知识点：${(report.mastery ?? []).map((m) => `${m.name}（${m.status}）`).join("、")}`,
    report.issue?.title ? `  主要问题：${report.issue.title}` : "",
    report.homework ? `  作业：${report.homework}` : "",
  ].filter(Boolean).join("\n"));
  const system = [
    "你是菁仕教育的教务助手，给教务写一个学生一门课的月度小结，只给内部看，可以直接说问题。",
    "只根据给出的每节课报告写，不要编造报告里没有的内容。用简体中文的完整句子，不用破折号和箭头。",
    '输出 JSON：{"sum": "本月讲了：一到两句，不超过 120 字，说讲了哪些主题、掌握得怎么样、有没有取消；没录的课多就直说有几节没录，不用逐个列知识点", "adv": "下月建议：一句话，具体到先练什么、要不要加课"}',
  ].join("\n");
  const user = [
    `学生：${input.student}；课程：${input.course}；月份：${input.month}。这个月上了 ${input.total} 节，其中 ${input.lessons.length} 节录了课、有报告（下面只有这几节的内容，没录的课不要猜），取消 ${input.cancelled} 节。`,
    `掌握得好：${good.join("、") || "没有"}；还要巩固：${weak.join("、") || "没有"}。`,
    "每节课：",
    ...lines,
  ].join("\n");
  return { system, user, good, weak };
}

export function parseMonthRep(raw: string, points: { good: string[]; weak: string[] }): MonthRep {
  const body = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim()) as Record<string, unknown>;
  // 超长时在句号处截断，不留半句话
  const clean = (v: unknown, max: number) => {
    const text = typeof v === "string" ? v.replace(/[—→]/g, "，").trim() : "";
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    return cut.slice(0, cut.lastIndexOf("。") + 1) || cut;
  };
  const sum = clean(body.sum, 300);
  const adv = clean(body.adv, 200);
  if (!sum || !adv) throw new Error("月报缺少 sum 或 adv");
  return { sum, adv, ...points };
}

/** 生成月报用到的课：编号排序后拼起来，有新报告就会变 */
export const basisOf = (ids: string[]) => [...ids].sort().join(",");

// ---------- 画像建议 ----------

export interface SuggestInput {
  lessons: Array<{ date: string; course: string; report: ClassReport }>;
  persona: Record<string, { tags: string[] } | undefined>;
  ignored: Array<{ key: string; tag: string }>;
}
export function suggestPrompt(input: SuggestInput) {
  const vocab = AI_KEYS.map((k) => `${k}：${PRESET[k].tags.filter((t) => !input.persona[k]?.tags.includes(t) && !input.ignored.some((x) => x.key === k && x.tag === t)).join("、")}`);
  const system = [
    "你是菁仕教育的教务助手。根据一个学生最近几节课的课堂报告，判断能不能给他的学生画像加标签。",
    "规则：只能从给出的词表里选标签；同一个表现至少在两节课里出现才提；why 写清是哪几节课（用 月/日）、什么表现，一句话；",
    "只看课堂表现，不提健康、家庭关系、情绪诊断；没有把握就不提。最多 3 条，可以一条都没有。",
    '输出 JSON：{"items": [{"key": "学习偏好 或 沟通注意", "tag": "词表里的标签", "why": "10/22、10/26 两节课都……"}]}',
  ].join("\n");
  const user = [
    "可选词表（已经有的和最近忽略过的已去掉）：", ...vocab, "",
    "最近的课：",
    ...input.lessons.map(({ date, course, report }) => [
      `${date} ${course}：${report.topic}`,
      report.performance ? `  课堂表现：${report.performance}` : "",
      report.issue?.title ? `  主要问题：${report.issue.title}` : "",
      `  主动提问：${(report.questions ?? []).length} 次`,
    ].filter(Boolean).join("\n")),
  ].join("\n");
  return { system, user };
}

export function parseSuggestions(raw: string, input: SuggestInput) {
  const body = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim()) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const { key, tag, why } = (item ?? {}) as Record<string, unknown>;
    if (typeof key !== "string" || typeof tag !== "string" || typeof why !== "string") return [];
    if (!(AI_KEYS as readonly string[]).includes(key) || !PRESET[key].tags.includes(tag)) return [];
    if (input.persona[key]?.tags.includes(tag) || input.ignored.some((x) => x.key === key && x.tag === tag) || seen.has(tag)) return [];
    // 要有两节课的证据：why 里至少两个日期
    if ((why.match(/\d{1,2}\/\d{1,2}/g) ?? []).length < 2) return [];
    seen.add(tag);
    return [{ key, tag, why: why.replace(/[—→]/g, "，").trim().slice(0, 120) }];
  }).slice(0, 3);
}

/** 上次提建议之后又多了几节有报告的课才再提，否则每次打开档案都调一次模型 */
export const suggestBasis = (ids: string[]) => `${ids.length}:${[...ids].sort().at(-1) ?? ""}`;

// ---------- 成绩单识别：腾讯云文字识别出文字，大模型整理成一行行成绩 ----------

export interface GradeRow { date: string; exam: string; subject: string; score: string }
export function gradePrompt(text: string, subjects: string[], today: string) {
  const system = [
    "你是菁仕教育的教务助手。下面是一张成绩单截图或 PDF 识别出来的文字，把里面的考试成绩整理出来。",
    "每一科一行：date 是考试或出成绩的日期（YYYY-MM-DD，看不出就空着），exam 是考试名（如 期中考试、Mock、期末考试），subject 是科目，score 是成绩原样（如 A*、7、85/100）。",
    "成绩单上有成绩的每一科都要列出来；能对上给出的课程名就用课程名，对不上就照成绩单原样写。没有成绩的科目、评语、出勤这些都不要。看不出是成绩单就返回空数组。",
    '输出 JSON：{"rows": [{"date": "", "exam": "", "subject": "", "score": ""}]}',
  ].join("\n");
  const user = `学生的课程：${subjects.join("、") || "没有"}\n今天：${today}\n\n识别出的文字：\n${text.slice(0, 6000)}`;
  return { system, user };
}
export function parseGradeRows(raw: string): GradeRow[] {
  const body = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim()) as { rows?: unknown };
  return (Array.isArray(body.rows) ? body.rows : []).flatMap((r: any) => {
    const row = {
      date: typeof r?.date === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(r.date) ? r.date : "",
      exam: typeof r?.exam === "string" ? r.exam.trim().slice(0, 40) : "",
      subject: typeof r?.subject === "string" ? r.subject.trim().slice(0, 60) : "",
      score: typeof r?.score === "string" || typeof r?.score === "number" ? String(r.score).trim().slice(0, 20) : "",
    };
    return row.subject && row.score ? [row] : [];
  }).slice(0, 20);
}

// ---------- 家长收集表 ----------

/** 家长填的三块：课上看不出来、只有家长知道的；沟通注意由老师观察 */
export const FORM_KEYS = ["学习偏好", "辅导经历", "家长沟通"] as const;
/** 家长填的并进画像：标签取并集，说明接在原来的后面；来源记成「家长收集表」 */
export function mergeForm(persona: Record<string, { tags: string[]; text: string; src: string } | undefined>, blocks: unknown, src: string) {
  const out = { ...persona };
  for (const key of FORM_KEYS) {
    const b = (blocks as Record<string, any> | null)?.[key];
    if (!b) continue;
    const tags = (Array.isArray(b.tags) ? b.tags : []).filter((t: unknown) => typeof t === "string" && PRESET[key].tags.includes(t));
    const text = typeof b.text === "string" ? b.text.replace(/\r/g, "").trim().slice(0, 300) : "";
    if (!tags.length && !text) continue;
    const old = out[key];
    out[key] = {
      tags: [...new Set([...(old?.tags ?? []), ...tags])],
      text: [old?.text, text && old?.text ? `家长：${text}` : text].filter(Boolean).join("；"),
      src,
    };
  }
  return out;
}

export const md = (ms: number) => { const d = sh(ms); return `${Number(d.slice(5, 7))}/${d.slice(8, 10)}`; };
export const DAY_MS = DAY;
