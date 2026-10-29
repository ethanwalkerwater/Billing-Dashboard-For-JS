/**
 * 菁仕课堂云端的纯逻辑（不碰飞书 / 数据库 / 腾讯云），云函数 classroom-api 负责 IO。
 * 课表字段名与 jingshi-vocal、取消课程模块一致；「老师课程ID」公式 = [请假前缀｜]HH:MM-HH:MM｜学生｜课程类型｜授课类型。
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const SEGMENT_SECONDS = 30;
/** App 录音是 MP3 32 kbps 恒定码率：4000 字节 = 1 秒 */
export const AUDIO_BYTES_PER_SEC = 4000;
export const MAX_ATTEMPTS = 3;
/** 下课（finish 里的 endedAt）2 小时后仍缺段，就用已有分段出报告 */
export const MISSING_GRACE_MS = 2 * HOUR;
/**
 * 没发 finish 的课（合盖睡着、关机、退出 App）：云端按分段停传判断已经下课。
 * 课表里的课：过了下课时间、且 15 分钟没收到分段；上课中途断网时 App 会先存本机再补传，下课前不判断。
 * 随时录制：没有计划下课时间，30 分钟没收到分段就算结束。
 * ponytail: 下课后断网超过这个时长的，App 之后补传的那段不会再进报告；真碰上了再按 finish 重出
 */
export const ORPHAN_QUIET_MS = 15 * 60_000;
export const ADHOC_QUIET_MS = 30 * 60_000;
export const CHUNK_CHARS = 12_000;
/** 课堂时间档案一次交给模型的上限；线上最长的课约 6 万字，超过才切开 */
export const ARCHIVE_CHARS = 120_000;

export const SCHEDULE_FIELDS = ["老师", "学生", "上课时间", "下课时间", "课程时长", "课程类型", "上课地点", "临时取消", "老师课程ID"];

export type Stage = "recording" | "queued" | "transcribing" | "summarizing" | "done" | "failed";
export type LessonStatus = "upcoming" | "recording" | "processing" | "done" | "cancelled";
/** lesson = 课表里的课；adhoc = 随时录制选「课程」；meeting = 随时录制选「会议」；merged = 老师选几节课合并的一份反馈 */
export type LessonKind = "lesson" | "adhoc" | "meeting" | "merged";
/** 随时录制的课程编号由 App 生成，不在飞书课表里 */
export const isAdhocId = (id: string) => /^adhoc-[0-9a-f]{16}$/.test(id);
/** 合并反馈的编号也由 App 生成；它没有录音，只引用几节已出报告的课 */
export const isMergedId = (id: string) => /^merged-[0-9a-f]{16}$/.test(id);
/** 合并反馈最多选几节 */
export const MERGE_MAX = 8;
/** 随时录制最长 3 小时（App 到点自动停）；建档时先按这个占位下课时间，finish 时改成真实时间 */
export const ADHOC_MAX_MS = 3 * HOUR;
/** 录音（分段 + merged.mp3）保留 30 天，转写和总结一直保留 */
export const AUDIO_KEEP_MS = 30 * DAY;
export const MASTERY_STATUSES = ["本课已学习", "开始运用", "基本掌握", "需要巩固"] as const;
/** 课堂时间档案的环节类别（内部用，家长看不到） */
export const KINDS = ["课前", "讲解", "讲题", "练习", "答疑", "复习总结", "学习规划", "课堂交流", "课间休息", "课后"] as const;
export type Kind = (typeof KINDS)[number];
/** 算学习时间、交给第二步写报告的环节；课前、课后、课间、闲聊不交给模型，家长报告里永远不会出现 */
export const LEARN_KINDS: readonly Kind[] = ["讲解", "讲题", "练习", "答疑", "复习总结", "学习规划"];
/** 家长看到的章节类别（按「学生这段时间在做什么」分）；顺序 = 报告配色 .k0–.k5 */
export const CHAPTER_CATS = {
  新知讲解: "老师讲新的概念、公式、原理",
  例题精讲: "老师拿一道新题带着学生一步步做、讲思路",
  错题讲评: "讲学生考试、作业里已经做过的题：逐题看错在哪、为什么扣分、怎么改",
  当堂练习: "学生自己动手做题，老师批改、点评",
  方法总结: "归纳方法、题型和易错点",
  学习规划: "试卷分析、定目标、选课、学习方法",
} as const;
export type ChapterCat = keyof typeof CHAPTER_CATS;
/** 学习时间占「去掉课间的上课时间」不到 70%：不显示「比计划多」，家长页时长只算学习时间，后台标黄 */
export const LEARN_SHARE = 0.7;
export const PLAN_POINT = "试卷分析与学习规划";

export interface Lesson {
  id: string;
  date: string;
  start: string;
  end: string;
  startAt: number;
  endAt: number;
  title: string;
  topic: string;
  status: LessonStatus;
  copied: boolean;
  summary?: string;
  reportUrl?: string;
  kind?: "adhoc" | "meeting" | "merged";
  /** 课表里的课有学生；App 按它找同一个学生的课来合并 */
  student?: string;
  /** 合并反馈由哪几节课合并（按上课时间） */
  sources?: string[];
}

export interface ClassReport {
  topic: string;
  lead: string;
  content: string[];
  mastery: Array<{ name: string; status: (typeof MASTERY_STATUSES)[number]; evidence: string }>;
  performance: string;
  issue: { title: string; fix: string };
  homework: string;
  review: string;
  next: string;
  /** 家长看的章节，时间为录音里的秒；real = 章里学习环节的真实秒数；point = mastery 里的知识点名或「试卷分析与学习规划」 */
  chapters?: Chapter[];
  /** 学生主动提的问题，time 为秒 */
  questions?: Array<{ time: number | null; text: string; answer: string }>;
  gapMinutes?: number;
}

export interface Chapter { start: number; end: number; real: number; cat: ChapterCat; title: string; point: string }

export interface Segment { start: number; end: number; kind: Kind; title: string; detail: string }
/**
 * 合并反馈里的一节：几节课按顺序接成一条时间线（中间隔 5 分钟「两节之间」），start / end 是这一节在合并时间线上的第一句、最后一句；
 * 合并时间线上的秒 t 对应真实时刻 clock0 + t × 1000；plan = 这节课表上的时长（秒）
 */
export interface ArchivePart { lessonId: string; start: number; end: number; clock0: number; plan: number }
/** 课堂时间档案：整节课从第一个环节到最后一个环节首尾相接；时间为录音里的秒。含闲聊，只在后台看 */
export interface Archive {
  /** 合并反馈才有 */
  parts?: ArchivePart[];
  segments: Segment[];
  moments: Array<{ time: number; type: string; text: string }>;
  facts: Array<{ time: number; type: string; text: string }>;
  /** first / last = 第一句、最后一句（不含课前、课后）；learn / brk / chat 秒；share = learn ÷ (last − first − brk) */
  stats: { first: number; last: number; learn: number; brk: number; chat: number; share: number };
}

export interface ScheduleLesson {
  id: string;
  teacher: string;
  student: string;
  course: string;
  location: string;
  startAt: number;
  endAt: number;
  cancelled: boolean;
}

export interface FinishSegment { seq: number; sha256: string; bytes: number }

/** classroom_lessons 文档，_id = 飞书课表 record_id */
export interface LessonDoc {
  _id: string;
  teacherOpenId: string;
  teacherName: string;
  student: string;
  course: string;
  location: string;
  startAt: number;
  endAt: number;
  stage: Stage;
  failedStage?: Stage;
  attempts: number;
  error?: string;
  lockedUntil: number;
  /** 第一台上传的电脑；同一节课只收这台的分段 */
  device?: string | null;
  segments: Record<string, { sha256: string; bytes: number; fileId: string }>;
  /** pauses = 老师点了暂停的时段（ISO），这段 App 录的是静音 */
  finish?: { startedAt: string; endedAt: string; segments: FinishSegment[]; pauses?: Array<{ start: string; end: string }> };
  mergedFileId?: string;
  asrTaskId?: number | null;
  transcript?: string;
  /** 后台第一次改转写前的机器原文 */
  rawTranscript?: string | null;
  /** 网页上第一次改报告前的 AI 原稿 */
  rawReport?: ClassReport | MeetingReport | null;
  gapMinutes?: number;
  /** 实际收到的录音时长（秒），合并时按分段字节数算 */
  audioSec?: number | null;
  summary?: string;
  editedSummary?: string;
  /** 课 = 学情报告；会议 = 结构化会议纪要 */
  report?: ClassReport | MeetingReport;
  /** 课堂时间档案（会议没有） */
  archive?: Archive | null;
  reportToken?: string;
  /** 生成总结时用的提示词版本（classroom_prompts.version，0 = 代码里的默认） */
  promptVersion?: number;
  copied?: boolean;
  kind?: LessonKind;
  /** 录音过了保留期被删掉的时间 */
  audioDeletedAt?: number | null;
  /** 合并反馈由哪几节课合并 */
  sources?: string[] | null;
  createdAt: number;
  updatedAt: number;
}

// ---------- 飞书字段读取（search 接口：公式是 {type, value:[…]}，数字可能是字符串） ----------

export function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(text).join("").trim();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) return text(record.value);
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.name === "string") return record.name.trim();
  }
  return "";
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value)) return readNumber(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("value" in record) return readNumber(record.value);
    if ("text" in record) return readNumber(record.text);
  }
  return null;
}

function readMs(value: unknown): number | null {
  const number = readNumber(value);
  if (number != null) return number < 10_000_000_000 ? number * 1000 : number;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/** 「15:30-16:30｜张浩然｜IG数学｜1v1」→ 张浩然；会议（无时间段）→ "" */
export function studentFromLabel(label: string): string {
  const parts = label.split(/[｜│|]/).map((part) => part.trim());
  const index = parts.findIndex((part) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(part));
  return index >= 0 ? parts[index + 1] ?? "" : "";
}

export function parseScheduleRecord(record: { record_id: string; fields: Record<string, unknown> }): ScheduleLesson | null {
  const f = record.fields;
  const startAt = readMs(f["上课时间"]);
  if (startAt == null) return null;
  const hours = readNumber(f["课程时长"]);
  return {
    id: record.record_id,
    teacher: text(f["老师"]),
    student: studentFromLabel(text(f["老师课程ID"])) || text(f["学生"]),
    course: text(f["课程类型"]),
    location: text(f["上课地点"]),
    startAt,
    endAt: readMs(f["下课时间"]) ?? startAt + (hours && hours > 0 ? hours : 1) * HOUR,
    cancelled: text(f["临时取消"]) !== "",
  };
}

// ---------- 上海时区 ----------

const shanghai = (ms: number) => new Date(ms + 8 * HOUR).toISOString();
export const shDate = (ms: number) => shanghai(ms).slice(0, 10);
export const shTime = (ms: number) => shanghai(ms).slice(11, 16);
export const shMonthDay = (ms: number) => `${Number(shanghai(ms).slice(5, 7))}月${Number(shanghai(ms).slice(8, 10))}日`;
export const dayStart = (ms: number) => Math.floor((ms + 8 * HOUR) / DAY) * DAY - 8 * HOUR;

/** 最近 7 天 + 今天 + 明天：[今天 0 点 - 7 天, 后天 0 点) */
export function lessonWindow(now: number) {
  const today = dayStart(now);
  return { from: today - 7 * DAY, to: today + 2 * DAY };
}

/** search 接口条件：ExactDate 只精确到天，前后各放宽一天，精确边界由 lessonWindow 再判 */
export function scheduleFilter(scheduleName: string, from: number, to: number) {
  return {
    conjunction: "and" as const,
    conditions: [
      { field_name: "老师", operator: "is", value: [scheduleName] },
      { field_name: "上课时间", operator: "isGreater", value: ["ExactDate", String(from - DAY)] },
      { field_name: "上课时间", operator: "isLess", value: ["ExactDate", String(to + DAY)] },
    ],
  };
}

// ---------- 课表 + 数据库 → Lesson ----------

const stageStatus = (stage: Stage): LessonStatus => (stage === "recording" ? "recording" : stage === "done" ? "done" : "processing");

export function lessonStatus(schedule: ScheduleLesson, doc?: Pick<LessonDoc, "stage">): LessonStatus {
  if (doc) return stageStatus(doc.stage);
  return schedule.cancelled ? "cancelled" : "upcoming";
}

/** 随时录制的行 → 老师端列表里的一节；标题 = 老师填的主题 */
export function adhocLesson(doc: LessonDoc, reportBaseUrl: string): Lesson {
  const lesson: Lesson = {
    id: doc._id, date: shDate(doc.startAt), start: shTime(doc.startAt), end: shTime(doc.endAt), startAt: doc.startAt, endAt: doc.endAt,
    title: doc.course || "随时录制", topic: "", status: stageStatus(doc.stage), copied: Boolean(doc.copied), kind: doc.kind === "meeting" ? "meeting" : "adhoc",
  };
  if (lesson.status === "done") {
    lesson.summary = doc.editedSummary || doc.summary || "";
    if (doc.reportToken) lesson.reportUrl = `${reportBaseUrl}?t=${doc.reportToken}`;
  }
  return lesson;
}

/** 合并反馈 → 老师端列表里的一项：日期、时间跟最后一节，排在它后面 */
export function mergedLesson(doc: LessonDoc, reportBaseUrl: string): Lesson {
  const lesson: Lesson = {
    id: doc._id, date: shDate(doc.startAt), start: shTime(doc.startAt), end: shTime(doc.endAt), startAt: doc.startAt, endAt: doc.endAt,
    title: `${doc.student} · 合并反馈`, topic: doc.course, status: stageStatus(doc.stage), copied: Boolean(doc.copied),
    kind: "merged", student: doc.student, sources: doc.sources ?? [],
  };
  if (lesson.status === "done") {
    lesson.summary = doc.editedSummary || doc.summary || "";
    if (doc.reportToken) lesson.reportUrl = `${reportBaseUrl}?t=${doc.reportToken}`;
  }
  return lesson;
}

export function toLesson(schedule: ScheduleLesson, doc: LessonDoc | undefined, reportBaseUrl: string): Lesson {
  const status = lessonStatus(schedule, doc);
  const lesson: Lesson = {
    id: schedule.id,
    date: shDate(schedule.startAt),
    start: shTime(schedule.startAt),
    end: shTime(schedule.endAt),
    startAt: schedule.startAt,
    endAt: schedule.endAt,
    title: [schedule.course, schedule.student].filter(Boolean).join(" · ") || "未命名课程",
    topic: [(doc?.report as ClassReport | undefined)?.topic, schedule.location].filter(Boolean).join(" · "),
    status,
    copied: Boolean(doc?.copied),
    student: schedule.student,
  };
  if (status === "done" && doc) {
    lesson.summary = doc.editedSummary || doc.summary || "";
    if (doc.reportToken) lesson.reportUrl = `${reportBaseUrl}?t=${doc.reportToken}`;
  }
  return lesson;
}

/** 按比例把 total 分给各项，整数加起来正好等于 total（最大余数法） */
export function apportion(items: Array<[string, number]>, total: number): Array<[string, number]> {
  const sum = items.reduce((a, [, v]) => a + v, 0);
  if (!sum) return items.map(([k]) => [k, 0]);
  const raw = items.map(([k, v]) => ({ k, x: (v / sum) * total, n: Math.floor((v / sum) * total) }));
  let left = total - raw.reduce((a, r) => a + r.n, 0);
  for (const r of [...raw].sort((a, b) => b.x - b.n - (a.x - a.n))) if (left-- > 0) r.n++;
  return raw.map((r) => [r.k, r.n]);
}

/**
 * 家长页的时间：课堂时长 = 第一句到最后一句；分钟数按比例摊开（课间总是摊开，闲聊只在学习占比够 70% 时摊开），
 * 合计 = 时间条下的「共 N 分钟」。没有档案的报告（会议、档案上线前的旧报告）返回 undefined。
 */
export function lessonClock(doc: Pick<LessonDoc, "archive" | "report" | "finish" | "startAt" | "endAt">) {
  const a = doc.archive?.stats;
  const parts = doc.archive?.parts;
  const chapters = (doc.report as ClassReport | undefined)?.chapters;
  if (!a || !chapters?.length) return undefined;
  // 合并反馈：课堂时长 = 各节相加，中间隔多久都不算；计划 = 各节课表时长之和
  const span = parts ? parts.reduce((sum, p) => sum + p.end - p.start, 0) : a.last - a.first;
  const full = a.share >= LEARN_SHARE;
  const total = Math.max(1, Math.round((full ? span : a.learn + a.brk) / 60));
  const over = span - (parts ? parts.reduce((sum, p) => sum + p.plan, 0) : (doc.endAt - doc.startAt) / 1000);
  const sum = (key: (c: Chapter) => string) => {
    const m = new Map<string, number>();
    for (const c of chapters) m.set(key(c), (m.get(key(c)) ?? 0) + c.real);
    return [...m];
  };
  const order = Object.keys(CHAPTER_CATS);
  const started = Date.parse(doc.finish?.startedAt ?? "");
  return {
    /** 录音开始的时刻（毫秒）：章节时间 = 它 + 秒数 */
    recStart: parts ? parts[0].clock0 : Number.isFinite(started) ? started : doc.startAt,
    /** 合并反馈各节：秒数 t 落在哪一节，真实时刻就是那一节的 recStart + t × 1000 */
    parts: parts?.map((p) => ({ start: p.start, end: p.end, recStart: p.clock0 })),
    first: a.first,
    last: a.last,
    full,
    total,
    over: full && over >= 180 ? Math.round(over / 60) : 0,
    cats: apportion(sum((c) => c.cat).sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0])), total),
    points: apportion(sum((c) => c.point), total).sort((x, y) => y[1] - x[1]),
  };
}

export function reportData(doc: LessonDoc) {
  const started = Date.parse(doc.finish?.startedAt ?? "");
  const ended = Date.parse(doc.finish?.endedAt ?? "");
  const recorded = Number.isFinite(started) && Number.isFinite(ended) && ended > started ? ended - started : doc.endAt - doc.startAt;
  const clock = lessonClock(doc);
  const parts = doc.archive?.parts;
  return {
    student: doc.student,
    course: doc.course,
    teacher: doc.teacherName,
    kind: doc.kind ?? "lesson",
    date: parts ? shDate(parts[0].clock0 + parts[0].start * 1000) : shDate(doc.startAt),
    // 有档案：实际上课的起止和时长（第一句到最后一句）；否则课表时间和录音时长。合并反馈列出各节，跨天时带日期
    time: parts ? partLabels(parts, false).join("、")
      : clock ? `${shTime(clock.recStart + clock.first * 1000)}–${shTime(clock.recStart + clock.last * 1000)}` : `${shTime(doc.startAt)}–${shTime(doc.endAt)}`,
    mins: parts ? Math.round(parts.reduce((sum, p) => sum + p.end - p.start, 0) / 60)
      : clock ? Math.round((clock.last - clock.first) / 60) : doc.audioSec != null ? Math.round(doc.audioSec / 60) : Math.round(recorded / 60_000),
    report: doc.report,
    gapMinutes: doc.gapMinutes ?? 0,
    clock,
  };
}

/** 合并反馈各节的时间，如「13:05–14:35」；跨天（或 withDay）时前面带日期「10.24 」/「10月24日 」 */
export function partLabels(parts: ArchivePart[], cn: boolean, withDay = false): string[] {
  const real = (p: ArchivePart, t: number) => p.clock0 + t * 1000;
  const days = new Set(parts.map((p) => shDate(real(p, p.start))));
  return parts.map((p) => {
    const day = withDay || days.size > 1 ? `${cn ? shMonthDay(real(p, p.start)) : shDate(real(p, p.start)).slice(5).replace("-", ".")} ` : "";
    return `${day}${shTime(real(p, p.start))}–${shTime(real(p, p.end))}`;
  });
}

// ---------- 处理流水线的状态推进 ----------

export function missingSeqs(expected: FinishSegment[], stored: LessonDoc["segments"]): number[] {
  return expected
    .filter((segment) => stored[String(segment.seq)]?.sha256 !== segment.sha256)
    .map((segment) => segment.seq)
    .sort((a, b) => a - b);
}

export type Step =
  | { action: "none" | "wait" | "poll" | "summarize" }
  | { action: "retry"; stage: Stage }
  | { action: "merge"; seqs: number[]; gapMinutes: number };

/** 没发 finish 的 recording 行：App 是不是已经不会再传了（见 ORPHAN_QUIET_MS） */
export function orphanEnded(doc: Pick<LessonDoc, "kind" | "endAt" | "updatedAt">, now: number): boolean {
  // 随时录制建档时 kind = adhoc，finish 才可能改成 meeting
  if (doc.kind === "adhoc" || doc.kind === "meeting") return now >= doc.updatedAt + ADHOC_QUIET_MS;
  return now >= doc.endAt && now >= doc.updatedAt + ORPHAN_QUIET_MS;
}

export function nextStep(doc: Pick<LessonDoc, "stage" | "failedStage" | "attempts" | "finish" | "segments" | "kind" | "endAt" | "updatedAt">, now: number): Step {
  if (doc.stage === "failed") {
    return doc.attempts < MAX_ATTEMPTS && doc.failedStage ? { action: "retry", stage: doc.failedStage } : { action: "none" };
  }
  if (doc.stage === "transcribing") return { action: "poll" };
  if (doc.stage === "summarizing") return { action: "summarize" };
  // App 没发 finish 就不传了（合盖睡着、关机、退出）：用已收到的分段先出报告；一段都没有则合并时报错走失败重试
  // ponytail: 没有清单就算不出缺失时长，gapMinutes 记 0；App 之后补发 finish 不会重出报告
  if (doc.stage === "recording" && !doc.finish && orphanEnded(doc, now)) {
    return { action: "merge", seqs: Object.keys(doc.segments).map(Number).sort((a, b) => a - b), gapMinutes: 0 };
  }
  if (doc.stage !== "queued" || !doc.finish) return { action: "none" };
  const missing = missingSeqs(doc.finish.segments, doc.segments);
  const endedAt = Date.parse(doc.finish.endedAt);
  if (missing.length && Number.isFinite(endedAt) && now < endedAt + MISSING_GRACE_MS) return { action: "wait" };
  return {
    action: "merge",
    seqs: Object.keys(doc.segments).map(Number).sort((a, b) => a - b),
    gapMinutes: missing.length ? Math.max(1, Math.round((missing.length * SEGMENT_SECONDS) / 60)) : 0,
  };
}

// ---------- 转写 ----------

export interface AsrSentence { StartMs?: number; EndMs?: number; SpeakerId?: number; FinalSentence?: string; SliceSentence?: string }

const mmss = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** 腾讯云 ResultDetail → 「[说话人N mm:ss-mm:ss] 文本」；ResultDetail 缺失时解析文本格式 [0:1.020,0:3.500,0] 文本 */
export function formatTranscript(detail: AsrSentence[] | undefined | null, fallback = ""): string {
  let sentences = detail ?? [];
  if (!sentences.length && fallback) {
    sentences = fallback.split("\n").flatMap((line) => {
      const m = line.trim().match(/^\[(\d+):(\d+(?:\.\d+)?),(\d+):(\d+(?:\.\d+)?)(?:,(\d+))?\]\s*(.*)$/);
      return m ? [{ StartMs: (Number(m[1]) * 60 + Number(m[2])) * 1000, EndMs: (Number(m[3]) * 60 + Number(m[4])) * 1000, SpeakerId: Number(m[5] ?? 0), FinalSentence: m[6] }] : [];
    });
  }
  return sentences
    .map((s) => ({ s, words: (s.FinalSentence || s.SliceSentence || "").trim() }))
    .filter(({ words }) => words)
    .map(({ s, words }) => `[说话人${(s.SpeakerId ?? 0) + 1} ${mmss(s.StartMs ?? 0)}-${mmss(s.EndMs ?? 0)}] ${words}`)
    .join("\n");
}

// ---------- 区分老师 / 学生：腾讯云只给「说话人N」，由大模型按内容判断谁是老师 ----------

const SPEAKER_LINE = /^\[说话人(\d+) (\d+):(\d{2})-(\d+):(\d{2})\] (.*)$/;

/** 各说话人的发言秒数、句数（按出现顺序） */
export function speakerStats(transcript: string) {
  const stats = new Map<number, { secs: number; lines: number }>();
  for (const line of transcript.split("\n")) {
    const m = line.match(SPEAKER_LINE);
    if (!m) continue;
    const s = stats.get(+m[1]) ?? { secs: 0, lines: 0 };
    s.secs += Math.max(0, +m[4] * 60 + +m[5] - (+m[2] * 60 + +m[3]));
    s.lines += 1;
    stats.set(+m[1], s);
  }
  return stats;
}

/** 只给大模型看开头一段（够判断角色），省 token */
export function teacherPrompt(transcript: string, max = 6000): string {
  const stats = [...speakerStats(transcript)].map(([id, s]) => `说话人${id}：${s.lines} 句，约 ${Math.round(s.secs / 60)} 分钟`).join("；");
  return `下面是一节课外辅导课录音转写的开头部分，「说话人N」由机器自动区分，同一个人偶尔会被拆成两个编号。
请判断哪些编号是老师：负责讲解知识、提问、纠错、布置任务的是老师；回答问题、做题、提问求助的是学生。不要按谁说得多来判断——口语课上学生往往比老师说得多。
各说话人统计：${stats}

${transcript.slice(0, max)}

只输出 JSON：{"teacher":[老师的编号数字]}，判断不出来就输出 {"teacher":[]}。`;
}

/** 解析大模型回复，只保留转写里真实存在的编号；所有人都被判成老师等于没判断 */
export function parseTeacher(raw: string, transcript: string): number[] {
  const ids = new Set(speakerStats(transcript).keys());
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")).teacher;
  } catch {
    return [];
  }
  const teacher = [...new Set(Array.isArray(value) ? value.map(Number).filter((n) => ids.has(n)) : [])];
  return teacher.length && teacher.length < ids.size ? teacher : [];
}

/**
 * 登录认人：先按老师档案的「飞书账号」；没绑过飞书账号的，按飞书姓名对「姓名 / 课表名」。
 * 名字只在全表唯一、且那一行还没绑人时才认（同名不猜，已绑的行不让别人顶替），认上后由调用方写回「飞书账号」。
 */
export function matchTeacher<T extends { name: string; scheduleName: string; openId: string | null }>(
  teachers: T[],
  openId: string,
  feishuName: string,
): { teacher: T; bind: boolean } | null {
  const bound = teachers.find((row) => row.openId === openId);
  if (bound) return { teacher: bound, bind: false };
  const key = feishuName.trim();
  if (!key) return null;
  const hits = teachers.filter((row) => row.name.trim() === key || row.scheduleName.trim() === key);
  return hits.length === 1 && !hits[0].openId ? { teacher: hits[0], bind: true } : null;
}

/** 「[说话人N 」→「[老师 」/「[学生 」；没判断出来就原样返回 */
export function labelSpeakers(transcript: string, teacher: number[]): string {
  if (!teacher.length) return transcript;
  return transcript.replace(/^\[说话人(\d+) /gm, (_, id: string) => (teacher.includes(+id) ? "[老师 " : "[学生 "));
}

export function chunkTranscript(transcript: string, max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of transcript.split("\n")) {
    if (current && current.length + line.length + 1 > max) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- 大模型提示词 ----------

const ROLE_RULE =
  "转写里的「老师」「学生」是 AI 根据说话内容预先判断的，个别句子可能标错；仍是「说话人N」的说明没能判断。负责讲解知识、提问、纠错和布置任务的是老师，其余是学生。不要按谁说得多来判断——口语课上学生往往比老师说得多。";

const SAMPLE = `浩然家长您好，今天（10月15日）的 IG 数学课向您汇报一下：

【今天学了什么】
1. quadratic function 的三种形式：standard form、vertex form、factored form，以及它们之间怎么互相转换；
2. 用 completing the square（配方法）求 turning point（顶点）和 line of symmetry；
3. 做了 2 道历年真题里的作图题。

【课堂表现】
浩然 completing the square 的步骤已经很熟练，作图题第一次就画对了开口方向和 turning point。需要注意的是，审题时容易漏看“x > 0”这类条件，今天有一题因此多写了一个解。

【课后建议】
请孩子做题前先用笔圈出题目里的条件。下节课我们会讲二次不等式。

有任何问题欢迎随时联系我～`;

export interface PromptMeta {
  student: string; course: string; teacher: string; monthDay: string;
  /** 合并反馈：各节的日期时间（如「10月24日 13:05–14:35」）、涉及的日期（不止一天时总结开头要改） */
  merged?: { labels: string[]; days: string[] };
}

/** 后台可编辑的四段提示词；JSON 结构与 status 取值写死在代码里（parseSummary / parseMeetingReport 依赖它们）。meeting 只给会议用，不套 rules */
export interface Prompts { rules: string; parent: string; report: string; meeting: string }

export const DEFAULT_PROMPTS: Prompts = {
  rules: `${ROLE_RULE}

可信原则：只使用转写里有依据的内容，不编造学生的表现、分数或没讲过的知识点。某一项在转写里找不到足够依据时，直接写「本课数据不足」，不要硬凑。

英文术语：课上老师用英文讲的学科术语、考试用语和题型名（如 turning point、completing the square、Part 2、Task Response、Paper 1），直接写英文原词，不要翻译成中文，也不要写成「中文（英文）」；转写可能把英文识别错，按学科标准写法纠正拼写。课上本来就用中文讲的概念照常写中文。`,
  parent: `parentSummary 写作要求（纯文字，老师会复制到微信直接发给家长）：
- 第一行：「{称呼}，今天（{日期}）的{课程}课向您汇报一下：」。称呼默认用「{学生}家长您好」；只有转写里明确说到对接的是妈妈或爸爸时，才写「{学生}妈妈您好」或「{学生}爸爸您好」。
- 接着依次三段，标题各占一行：【今天学了什么】用 1. 2. 3. 编号列 1–3 条；【课堂表现】先写一个具体的进步，再写一个需要改进的地方，不空夸；【课后建议】写具体可执行的练习，转写里提到了下节课内容就补一句。
- 最后一行：「有任何问题欢迎随时联系我～」
- 段与段之间空一行，总长 250–400 字。用家长能看懂的话，不写分数、正确率、专注度这类评判性数字，不用中文教研术语；英文术语照通用规则保留英文，只给最关键、家长最可能看不懂的词在第一次出现时补括号中文，整篇最多 3 处，其余英文词不加注释；加了英文也要守住 250–400 字。例：写「用 completing the square（配方法）求 turning point（顶点）」，不要写「用配方法（completing the square）求顶点（turning point）」。不用 Markdown 符号（不要 **、#、- ）。

范例（只学格式和语气，不要照抄内容）：
${SAMPLE}`,
  report: `- topic：本课主题，12 字以内，如「二次函数」「Part 2 难忘的旅行」
- lead：一句话总结，35 字以内：已经能做到什么，下一步重点是什么
- content：本课学习内容，2–4 条，每条一句话，不要编号
- mastery：本课真实讲到的 3–6 个知识点；evidence 是判断依据，一句话，写课堂里的具体表现
- performance：学生课堂表现，2–3 句：先写具体的进步，再写一个需要改进的地方
- issue：最主要的一个易错点（title 15 字以内）和改进方法（fix 1–2 句，可直接照做）
- review：复习方法，1–2 句
- questions：学生主动提出的问题（不是回答老师的提问，也不是「听不清」「什么意思」这类），按时间顺序最多 5 个，没有就写 []。time 照抄时间；text 尽量保留学生原话，去掉口头语；answer 一句话，写老师怎么解答或学生由此弄懂了什么`,
  meeting: `只写转写里有依据的内容，不编造人名、日期和数字；听不清、没结论的不要替它下结论，放进 followups。转写由机器识别，同音错字按上下文理解，不要照抄明显的错字。

字段要求：
- title：会议主题，15 字以内；lead：一句话总结，40 字以内，写最重要的结论或下一步
- sections：先把整场会分成 2–6 个板块（如「学生近况」「申请进度」「招聘」「制度与政策」）；每个板块下按时间顺序列出具体议题 items，每个 item 是一件具体的事（一个学生、一个岗位、一条政策），整场最多 40 个；start / end 照抄转写里的时间（mm:ss）；conclusion 一句话、30 字以内，没有结论写「未定」
- decisions：会上明确拍板的事，最多 15 条，挑最重要的；只是讨论、没拍板的不算
- todos：明确有人要去做的事，最多 20 条；owner 用转写里的称呼（如「郭老师」），听不出就留空；due 转写里说了才写
- followups：提出了但没有结论、需要会后确认的问题，最多 8 条`,
};

const SKELETON = `{
  "parentSummary": "给家长的课堂总结",
  "report": {
    "topic": "", "lead": "", "content": [""],
    "mastery": [{"name": "知识点", "status": "${MASTERY_STATUSES.join(" / ")} 四选一", "evidence": ""}],
    "performance": "", "issue": {"title": "", "fix": ""}, "review": "",
    "questions": [{"time": "mm:ss", "text": "学生原话", "answer": ""}]
  }
}`;

/** 提示词里的 {学生} {课程} {日期} {老师} 换成本课信息；{称呼} 这类留给模型 */
function fill(template: string, meta: PromptMeta): string {
  const values: Record<string, string> = { 学生: meta.student || "学生", 课程: meta.course, 日期: meta.monthDay, 老师: meta.teacher };
  return template.replace(/\{(学生|课程|日期|老师)\}/g, (_, key: string) => values[key]);
}

/** 家长总结提示词里出现的【标题】，生成结果必须都有 */
export const promptHeadings = (prompts: Prompts) => [...new Set(prompts.parent.match(/【[^】\n]{1,12}】/g) ?? [])];

// ---------- 第一步：整节课 → 课堂时间档案（结构写死在代码里，程序要靠它检查） ----------

export function archivePrompt(transcript: string, rules = DEFAULT_PROMPTS.rules, retry = ""): string {
  return `下面是一节课录音的完整转写。${rules}${retry ? `\n注意：${retry}` : ""}
把整节课按时间顺序切成环节：前后相接，从第一句到最后一句每一分钟都要落在某个环节里；一个环节通常 1–6 分钟，换了一道题或一个话题就切开。转写里时间跳过去的地方是没人说话（学生安静做题、课间），也要归进环节：前后在做题就算练习，否则算课间休息。
kind 从这几类选一个：课前（第一句正式上课之前）/ 讲解（老师讲概念、方法）/ 讲题（师生一起做某道题）/ 练习（学生自己做、老师看）/ 答疑（学生提问、分析错题）/ 复习总结 / 学习规划（试卷分析、选课升学、学习方法与心态）/ 课堂交流（和学习无关的闲聊）/ 课间休息 / 课后。
只输出 JSON：
{"segments":[{"start":"mm:ss","end":"mm:ss","kind":"","title":"12 字以内","detail":"一句具体说明：哪道题、什么方法、学生怎么答的，60 字以内"}],
"moments":[{"time":"mm:ss","type":"答对 / 答错 / 提问 / 老师纠正","text":"尽量保留学生原话"}],
"facts":[{"time":"mm:ss","type":"作业 / 下节课 / 考试成绩 / 选课规划","text":""}]}
moments 里「提问」只算学生自己主动提出的问题（不是回答老师，也不是「听不清」「什么意思」），text 写学生原话。
facts 里「作业」指老师让学生课后做的任何事（包括「回去再做一遍」「把过程写一遍」）；「下节课」只算明确说下次上课讲什么，「下半堂课」不算。没有的写空列表。start / end / time 照抄转写里的时间。

${transcript}`;
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
function jsonOf(raw: string): Record<string, any> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("输出里没有 JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 程序检查档案：按开始排序，重叠从前一段结束处截断，空当并进前一段。
 * 空当里没人说话（转写里没有句子）是正常的；有人说话的空当加起来太多，说明模型漏切了，报错让调用方重试。
 */
export function parseArchive(raw: string | string[], transcript = ""): Archive {
  const spoken = [...transcript.matchAll(/^\[\S+ (\d+):(\d{2})-/gm)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  // 超长的课分几段抽，各段时间都是整节录音里的时间，直接拼起来再一起检查
  const parts = (Array.isArray(raw) ? raw : [raw]).map(jsonOf);
  const d = Object.fromEntries(["segments", "moments", "facts"].map((k) => [k, parts.flatMap((x) => list(x[k]))]));
  const segs = list(d.segments)
    .flatMap((s): Segment[] => {
      const start = seconds(s?.start);
      const end = seconds(s?.end);
      const kind = (KINDS as readonly string[]).includes(s?.kind) ? (s.kind as Kind) : "课堂交流";
      return end > start ? [{ start, end, kind, title: plain(s.title) || kind, detail: plain(s.detail) }] : [];
    })
    .sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let gap = 0;
  for (const s of segs) {
    const prev = segments.at(-1);
    if (prev && s.end <= prev.end) continue;
    if (prev && s.start > prev.end) {
      const [a, b] = [prev.end, s.start];
      if (!transcript || spoken.some((t) => t > a + 5 && t < b - 5)) gap += b - a;
      prev.end = b;
    }
    segments.push({ ...s, start: prev ? prev.end : s.start });
  }
  if (!segments.length) throw new Error("segments 里没有带合法时间的环节");
  const span = segments.at(-1)!.end - segments[0].start;
  if (gap > Math.max(120, span * 0.05)) throw new Error(`环节之间有 ${Math.round(gap / 60)} 分钟没有归进任何环节，请从第一句到最后一句前后相接地切`);
  const items = (value: unknown) => list(value).flatMap((x) => {
    const time = seconds(x?.time);
    return Number.isFinite(time) && plain(x.type) ? [{ time, type: plain(x.type), text: plain(x.text) }] : [];
  });
  return { segments, moments: items(d.moments), facts: items(d.facts), stats: archiveStats(segments) };
}

export function archiveStats(segments: Segment[]): Archive["stats"] {
  const secs = (kinds: readonly Kind[]) => segments.filter((s) => kinds.includes(s.kind)).reduce((a, s) => a + s.end - s.start, 0);
  const speech = segments.filter((s) => s.kind !== "课前" && s.kind !== "课后");
  const first = speech[0]?.start ?? 0;
  const last = speech.at(-1)?.end ?? 0;
  const learn = secs(LEARN_KINDS);
  const brk = secs(["课间休息"]);
  return { first, last, learn, brk, chat: secs(["课堂交流"]), share: learn / Math.max(1, last - first - brk) };
}

/**
 * 老师点了暂停的时段（录音里的秒）从档案里挖出来，标成「暂停 N 分钟」：算上课时间、不算学习时间（同闲聊）。
 * 暂停期间录的是静音，模型多半把它并进了前后环节；不到 30 秒的不单列。
 */
export function applyPauses(a: Archive, pauses: Array<[number, number]>): Archive {
  let segs = a.segments;
  for (const [ps, pe] of pauses) {
    // 只挖第一句到最后一句之间：课前等学生、课后和家长单聊时的暂停不能把课堂时长撑长
    const start = Math.max(ps, a.stats.first);
    const end = Math.min(pe, a.stats.last);
    if (end - start < 30) continue;
    const pause: Segment = { start, end, kind: "课堂交流", title: `暂停 ${Math.max(1, Math.round((end - start) / 60))} 分钟`, detail: "老师暂停了录制，这段没有录音" };
    segs = [
      ...segs.flatMap((s) => [...(s.start < start ? [{ ...s, end: Math.min(s.end, start) }] : []), ...(s.end > end ? [{ ...s, start: Math.max(s.start, end) }] : [])]),
      pause,
    ].sort((x, y) => x.start - y.start);
  }
  return segs === a.segments ? a : { ...a, segments: segs, stats: archiveStats(segs) };
}

/** 合并时两节之间空出的秒数：够 5 分钟，章节就不会跨节（同课间休息） */
const PART_GAP = 300;

/**
 * 几节课的档案 → 合并反馈的档案：去掉课前、课后，按上课先后接成一条时间线，两节之间插一段 5 分钟的「两节之间」（课间休息）。
 * 统计按各节相加，两节之间不算；parts 记下每节在新时间线上的位置和真实时刻。
 */
export function mergeArchives(items: Array<{ lessonId: string; archive: Archive; recStart: number; plan: number }>): Archive {
  const out: Archive = { parts: [], segments: [], moments: [], facts: [], stats: { first: 0, last: 0, learn: 0, brk: 0, chat: 0, share: 0 } };
  let cursor = 0;
  let base = 0;
  for (const [k, { lessonId, archive: a, recStart, plan }] of items.entries()) {
    const { first, last } = a.stats;
    if (k) {
      out.segments.push({ start: cursor, end: cursor + PART_GAP, kind: "课间休息", title: "两节之间", detail: "" });
      cursor += PART_GAP;
    }
    const shift = cursor - first;
    const clamp = (t: number) => Math.min(last, Math.max(first, t)) + shift;
    out.segments.push(...a.segments
      .filter((s) => s.kind !== "课前" && s.kind !== "课后")
      .map((s) => ({ ...s, start: clamp(s.start), end: clamp(s.end) }))
      .filter((s) => s.end > s.start));
    out.moments.push(...a.moments.filter((m) => m.time >= first && m.time <= last).map((m) => ({ ...m, time: m.time + shift })));
    out.facts.push(...a.facts.map((f) => ({ ...f, time: clamp(f.time) }))); // 下课后才说的作业也算进来
    out.parts!.push({ lessonId, start: cursor, end: cursor + last - first, clock0: recStart - shift * 1000, plan });
    for (const key of ["learn", "brk", "chat"] as const) out.stats[key] += a.stats[key];
    base += last - first - a.stats.brk;
    cursor += last - first;
  }
  out.stats.last = cursor;
  out.stats.share = out.stats.learn / Math.max(1, base);
  return out;
}

/** 秒数 t 在合并反馈的第几节（从 0 起）；不是合并反馈都算第 0 节 */
const partOf = (a: Archive, t: number) => Math.max(0, (a.parts ?? []).filter((p) => p.start <= t).length - 1);

const learnSegments = (a: Archive) => a.segments.filter((s) => LEARN_KINDS.includes(s.kind));
const segLine = (s: Segment, i: number) => `${i}. ${mmss(s.start * 1000)}–${mmss(s.end * 1000)} ${s.kind}｜${s.title}｜${s.detail}`;
/** 合并反馈：每一节开头加一行「—— 第 N 节 ——」 */
const partHead = (a: Archive, list: Segment[], i: number) =>
  a.parts && (i === 0 || partOf(a, list[i - 1].start) !== partOf(a, list[i].start)) ? `—— 第 ${partOf(a, list[i].start) + 1} 节 ——\n` : "";
const CN_NUM = ["零", "一", "两", "三", "四", "五", "六", "七", "八"];

/** 作业、下节课由程序从档案的「事项」取：下节课只认最后 30 分钟里说的（前面说的多半是「下半堂课」） */
export function archiveFacts(a: Archive) {
  const pick = (type: string, from = -Infinity) => a.facts.filter((f) => f.type === type && f.time >= from && f.text).map((f) => f.text);
  return { homework: pick("作业"), next: pick("下节课", a.stats.last - 1800) };
}

/** 第二步两次调用的结果 + 档案 → 完整报告：作业、下节课、章节都由程序填 */
export function assembleReport(report: Omit<ClassReport, "homework" | "next">, archive: Archive, chapterRaw: string): ClassReport {
  const { homework, next } = archiveFacts(archive);
  return {
    ...report,
    homework: homework.join("；") || "课上没有明确布置作业",
    next: next.join("；") || "具体内容待老师安排",
    chapters: buildChapters(chapterRaw, archive, report.mastery.map((m) => m.name)),
  };
}

// ---------- 第二步 A：只拿学习环节写家长总结和报告（闲聊、课前课后模型根本看不到） ----------

export function reportMessages(meta: PromptMeta, archive: Archive, prompts: Prompts = DEFAULT_PROMPTS) {
  const learn = learnSegments(archive);
  const inLearn = (t: number) => learn.some((s) => t >= s.start && t < s.end);
  const { homework, next } = archiveFacts(archive);
  const system = `你是菁仕教育的资深教研老师，根据一节课的课堂时间档案（由程序从录音整理，已去掉课前、课间和闲聊），同时写两份内容：给家长的课堂总结、给老师和教研看的结构化课堂报告。
${fill(prompts.rules, meta)}
只输出一个 JSON 对象，不要 markdown 代码块，不要任何其他文字。`;
  const m = meta.merged;
  const merged = m
    ? `\n这是 ${m.labels.length} 节课合并的一份反馈（${m.labels.join("、")}），把它们当成一次汇报来写，不要逐节分开写。${m.days.length > 1
      ? `这几节不在同一天：parentSummary 第一行写成「{称呼}，这${CN_NUM[m.labels.length] ?? m.labels.length}次课（${m.days.join("、")}）的${meta.course || "本"}课向您汇报一下：」，其余照常。`
      : ""}\n`
    : "";
  const user = `课程信息：学生 ${meta.student || "学生"}；课程 ${meta.course || "本课"}；日期 ${meta.monthDay}；老师 ${meta.teacher}。
${merged}
JSON 结构：
${SKELETON}

report 各字段要求：
${fill(prompts.report, meta)}

${fill(prompts.parent, meta)}

parentSummary 与 report 的内容必须一致。作业和下节课只用下面「作业」「下节课」里写的，没有就不要编。

学习环节（[编号. 开始–结束 类别｜标题｜说明]）：
${learn.map((s, i) => partHead(archive, learn, i) + segLine(s, i)).join("\n") || "无"}

课堂瞬间：
${archive.moments.filter((m) => inLearn(m.time)).map((m) => `${mmss(m.time * 1000)} ${m.type}：${m.text}`).join("\n") || "无"}

作业：${homework.join("；") || "无"}
下节课：${next.join("；") || "无"}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------- 第二步 B：学习环节归成章节（单独一次调用：和写报告混在一起会归成 30 多章） ----------

/** 课间后的第一个学习环节编号：章节不能跨过课间 */
function breakCuts(a: Archive): number[] {
  const learn = learnSegments(a);
  return a.segments
    .filter((s) => s.kind === "课间休息" && s.end - s.start >= 300)
    .map((b) => learn.findIndex((s) => s.start >= b.end - 1))
    .filter((k) => k > 0);
}

export function chapterPrompt(archive: Archive, points: string[], retry = ""): string {
  const learn = learnSegments(archive);
  const cuts = breakCuts(archive);
  return `下面是一节课里的学习环节（程序已去掉课前、课间、闲聊），按时间排好，前面是编号；后面附课堂里学生作答、提问的记录。
共 ${learn.length} 个环节，请归成 ${chapterRange(learn.length).join("–")} 个章节给家长看（平均每章约 ${Math.max(1, Math.round(learn.length / 10))} 个环节）：每个章节是连续的若干环节，用 from / to 写起止编号，所有编号都要用上，不重叠。
- cat：这一章的类别，按「这段时间学生主要在做什么」判断，从下面选一个：
${Object.entries(CHAPTER_CATS).map(([k, v]) => `  ${k}：${v}`).join("\n")}
  学生先自己做、老师再讲的算「当堂练习」；说到试卷或作业的第几题、错因、扣分的算「错题讲评」，不算例题精讲。夹在讲题中间的几句鼓励、闲谈，并进所在章节，不单独成章。课间休息前后的环节不能放在同一章。
- title：一句话 20–32 字，先写知识点或题目，再写关键方法或结论，让家长看得懂这段具体学了什么。例如「第 15 题判别式求参数：唯一实数解令 Δ=0，解出 M=±√10」。不要写评价，不要用省略号。
- point：从这几个知识点里选这一章主要讲的一个：${points.join(" / ")}；学习规划章写「${PLAN_POINT}」。
只输出 JSON：{"chapters":[{"from":0,"to":0,"cat":"","title":"","point":""}]}${retry ? `\n${retry}` : ""}

环节：
${learn.map((s, i) => `${partHead(archive, learn, i) || (cuts.includes(i) ? "—— 课间休息 ——\n" : "")}${segLine(s, i)}`).join("\n")}

学生作答与提问：
${archive.moments.map((m) => `${mmss(m.time * 1000)} ${m.type}：${m.text}`).join("\n") || "无"}`;
}

/** 章节数：8–12；环节本来就少的短课按环节数来 */
const chapterRange = (n: number) => [Math.min(8, n), Math.min(12, n)];

/** 检查章节：数量、首尾相接覆盖全部编号、类别合法、不跨课间。返回问题描述，没问题返回空串 */
export function chapterProblem(raw: string, archive: Archive): string {
  const n = learnSegments(archive).length;
  const cuts = breakCuts(archive);
  const [min, max] = chapterRange(n);
  let cs: any[];
  try {
    cs = list(jsonOf(raw).chapters);
  } catch {
    return "输出不是合法 JSON";
  }
  if (cs.length < min || cs.length > max) return `上次你给了 ${cs.length} 章，必须是 ${min}–${max} 章${cs.length > max ? "：同一道题或同一个知识点的连续环节放进一章，学习规划和鼓励的话并进相邻章节" : ""}。`;
  if (!cs.every((c, i) => Number.isInteger(c?.from) && Number.isInteger(c?.to) && c.to >= c.from && c.from === (i ? cs[i - 1].to + 1 : 0)) || cs.at(-1)?.to !== n - 1) return `编号要首尾相接覆盖 0–${n - 1}。`;
  if (!cs.every((c) => c.cat in CHAPTER_CATS)) return "cat 必须在列表里。";
  if (cs.some((c) => cuts.some((k) => c.from < k && k <= c.to))) return "课间休息前后的环节不能在同一章。";
  return "";
}

/**
 * 模型的章节 → 家长看的章节。先修正（重试后仍不合格时兜底，不让整节课失败）：编号排好接上、跨课间的拆开、类别不认识的算例题精讲、
 * 多于 12 章把最短的并进相邻较长的一章；再算时间：首尾相接（闲聊并进前一章），跨过课间的那一章停在课间开始，课间不单列。
 * 闲聊多（学习占比不到 70%）的课不并闲聊，每章就是它学习环节的真实起止，免得一章挂着半小时闲聊。
 */
export function buildChapters(raw: string, archive: Archive, points: string[]): Chapter[] {
  const learn = learnSegments(archive);
  const n = learn.length;
  if (!n) return [];
  const cuts = breakCuts(archive);
  let cs: Array<{ from: number; to: number; cat: ChapterCat; title: string; point: string }> = [];
  try {
    cs = list(jsonOf(raw).chapters)
      .filter((c) => Number.isInteger(c?.from) && Number.isInteger(c?.to) && plain(c.title))
      .sort((a, b) => a.from - b.from)
      .map((c) => ({ from: c.from, to: c.to, cat: c.cat in CHAPTER_CATS ? c.cat : "例题精讲", title: plain(c.title), point: plain(c.point) }));
  } catch { /* 下面按一章兜底 */ }
  cs = cs.flatMap((c, i) => {
    const from = i ? cs[i - 1].to + 1 : 0; // 前一章已按修正后的 to 改过
    const to = i === cs.length - 1 ? n - 1 : Math.min(n - 1, Math.max(from, c.to));
    if (from > n - 1) return [];
    c.from = from;
    c.to = to;
    return [c];
  });
  if (!cs.length) cs = [{ from: 0, to: n - 1, cat: "例题精讲", title: learn[0].title, point: points[0] ?? PLAN_POINT }];
  cs = cs.flatMap((c) => {
    const inside = cuts.filter((k) => c.from < k && k <= c.to);
    return [c.from, ...inside].map((from, i, all) => ({ ...c, from, to: i < all.length - 1 ? all[i + 1] - 1 : c.to }));
  });
  const secs = (c: { from: number; to: number }) => learn.slice(c.from, c.to + 1).reduce((a, s) => a + s.end - s.start, 0);
  const crosses = (a: { from: number; to: number }, b: { from: number; to: number }) => cuts.some((k) => Math.min(a.from, b.from) < k && k <= Math.max(a.to, b.to));
  while (cs.length > 12) {
    const i = cs.reduce((m, c, k) => (secs(c) < secs(cs[m]) ? k : m), 0);
    const j = [i - 1, i + 1].filter((k) => cs[k] && !crosses(cs[i], cs[k])).sort((a, b) => secs(cs[b]) - secs(cs[a]))[0];
    if (j === undefined) break;
    cs[j] = { ...cs[j], from: Math.min(cs[i].from, cs[j].from), to: Math.max(cs[i].to, cs[j].to) };
    cs.splice(i, 1);
  }
  const breaks = archive.segments.filter((s) => s.kind === "课间休息");
  let lastPoint = points[0] ?? PLAN_POINT;
  const full = archive.stats.share >= LEARN_SHARE;
  return cs.map((c, i) => {
    if (points.includes(c.point)) lastPoint = c.point;
    const point = c.cat === "学习规划" ? PLAN_POINT : lastPoint;
    if (!full) return { start: learn[c.from].start, end: learn[c.to].end, real: secs(c), cat: c.cat, title: c.title, point };
    const start = i ? learn[c.from].start : archive.stats.first;
    const next = i < cs.length - 1 ? learn[cs[i + 1].from].start : archive.stats.last;
    const brk = breaks.find((b) => b.start >= learn[c.to].end - 1 && b.end <= next + 1);
    return { start, end: brk ? brk.start : next, real: secs(c), cat: c.cat, title: c.title, point };
  });
}

// ---------- 会议纪要（随时录制选「会议」）：结构化纪要 + 纪要网页，不出家长总结和学情报告 ----------

export interface MeetingReport {
  title: string;
  lead: string;
  /** 板块 → 具体议题；时间为秒 */
  sections: Array<{ title: string; items: Array<{ title: string; start: number; end: number; conclusion: string }> }>;
  decisions: Array<{ text: string; time: number | null }>;
  todos: Array<{ task: string; owner: string; due: string; time: number | null }>;
  followups: string[];
  /** 各说话人发言秒数，程序按转写算 */
  speakers: Array<[string, number]>;
}

const MEETING_SKELETON = `{
  "title": "", "lead": "",
  "sections": [{"title": "板块", "items": [{"title": "议题", "start": "mm:ss", "end": "mm:ss", "conclusion": ""}]}],
  "decisions": [{"text": "", "time": "mm:ss"}],
  "todos": [{"task": "", "owner": "", "due": "", "time": "mm:ss"}],
  "followups": [""]
}`;

export function meetingChunkPrompt(chunk: string, index: number, total: number): string {
  return `下面是一场会议录音转写的第 ${index + 1}/${total} 段，「说话人N」由机器自动区分。
按时间顺序整理这一段（纯文字，1000 字以内）：先按议题列出时间线，每个议题写起止时间（mm:ss，照抄转写里的时间）、讨论了什么、结论是什么；再单独列出这一段里的决定、待办（谁做什么、什么时候）、没讨论出结论的问题。只写转写里有的内容，不要推测。

${chunk}`;
}

export function meetingMessages(meta: { topic: string; monthDay: string }, material: string, isNotes: boolean, prompt = DEFAULT_PROMPTS.meeting) {
  return [
    { role: "system", content: `你是会议记录员，根据会议录音转写写一份结构化的会议纪要。\n只输出一个 JSON 对象，不要 markdown 代码块，不要任何其他文字。` },
    { role: "user", content: `会议：${meta.topic || "会议"}；日期：${meta.monthDay}。

JSON 结构：
${MEETING_SKELETON}

${prompt}

${isNotes ? "会议要点（由完整转写按时间分段整理）" : "会议转写（[说话人 开始-结束] 文本）"}：
${material}` },
  ];
}

const plain = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const timeOrNull = (value: unknown) => {
  const t = seconds(value);
  return Number.isFinite(t) ? t : null;
};

/** 大模型输出 → MeetingReport：至少要有一个带合法时间的议题；条数上限防止长会把页面撑爆 */
export function parseMeetingReport(raw: string, speakers: MeetingReport["speakers"] = []): MeetingReport {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("输出里没有 JSON");
  const d = JSON.parse(raw.slice(start, end + 1)) as Record<string, any>;
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const sections = list(d.sections)
    .map((s: Record<string, unknown>) => ({
      title: plain(s?.title),
      items: list(s?.items).flatMap((it: Record<string, unknown>) => {
        const a = seconds(it?.start);
        const b = seconds(it?.end);
        const title = plain(it?.title);
        return b > a && title ? [{ title, start: a, end: b, conclusion: plain(it.conclusion) || "未定" }] : [];
      }),
    }))
    .filter((s) => s.title && s.items.length);
  if (!sections.length) throw new Error("sections 里没有带合法时间的议题");
  return {
    title: str(d.title, "title"),
    lead: str(d.lead, "lead"),
    sections,
    decisions: list(d.decisions).flatMap((x: Record<string, unknown>) => (plain(x?.text) ? [{ text: plain(x.text), time: timeOrNull(x.time) }] : [])).slice(0, 15),
    todos: list(d.todos).flatMap((x: Record<string, unknown>) => (plain(x?.task) ? [{ task: plain(x.task), owner: plain(x.owner), due: plain(x.due), time: timeOrNull(x.time) }] : [])).slice(0, 30),
    followups: list(d.followups).map(plain).filter(Boolean).slice(0, 10),
    speakers,
  };
}

/** App 卡片、飞书私信、「复制纪要」用的纯文本，从同一份 MeetingReport 拼出来 */
export function meetingText(r: MeetingReport, monthDay: string): string {
  const numbered = (rows: string[]) => (rows.length ? rows.map((row, i) => `${i + 1}. ${row}`).join("\n") : "无");
  return [
    `${r.title} · ${monthDay} 会议纪要`,
    r.lead,
    `【决定】\n${numbered(r.decisions.map((x) => x.text))}`,
    `【待办】\n${numbered(r.todos.map((x) => `${x.owner ? `${x.owner}：` : ""}${x.task}${x.due ? `（${x.due}）` : ""}`))}`,
    `【待跟进】\n${numbered(r.followups)}`,
  ].join("\n\n");
}

/** 发言占比：按转写里的标签（「说话人N」，后台测试时也可能是「老师 / 学生」）累计发言秒数，从多到少 */
export function meetingSpeakers(transcript: string): MeetingReport["speakers"] {
  const secs = new Map<string, number>();
  for (const m of transcript.matchAll(/^\[(\S+) (\d+):(\d{2})-(\d+):(\d{2})\]/gm)) {
    secs.set(m[1], (secs.get(m[1]) ?? 0) + Math.max(0, +m[4] * 60 + +m[5] - (+m[2] * 60 + +m[3])));
  }
  return [...secs].sort((a, b) => b[1] - a[1]);
}

// ---------- 大模型输出校验 ----------

/** "mm:ss" 或 "h:mm:ss" → 秒；分钟可以超过 59（转写不按小时回绕）。不合法返回 NaN */
function seconds(value: unknown): number {
  const m = String(value ?? "").trim().match(/^(?:(\d+):)?(\d+):(\d{2})$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/** 像一个问题：6 个字以上，带问号或疑问词。挡掉「选 dog」「为什么」这类把回答、口头语当成提问的 */
export const isQuestion = (text: string) => text.length >= 6 && /[？?]|什么|为什么|怎么|哪|吗|呢|是不是|几|啥|多少/.test(text);

function parseQuestions(raw: unknown): NonNullable<ClassReport["questions"]> {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((q: Record<string, unknown>) => {
      const text = typeof q?.text === "string" ? q.text.trim() : "";
      const time = seconds(q?.time);
      return isQuestion(text) ? [{ time: Number.isFinite(time) ? time : null, text, answer: typeof q.answer === "string" ? q.answer.trim() : "" }] : [];
    })
    .slice(0, 5);
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${name}`);
  return value.trim();
}

/** 第二步 A 的输出；作业、下节课、章节不归模型写，由调用方按档案填 */
export function parseSummary(raw: string, headings = promptHeadings(DEFAULT_PROMPTS)): { parentSummary: string; report: Omit<ClassReport, "homework" | "next"> } {
  const data = jsonOf(raw);
  const parentSummary = str(data.parentSummary, "parentSummary").replace(/\*\*/g, "").replace(/\r\n/g, "\n");
  for (const heading of headings) {
    if (!parentSummary.includes(heading)) throw new Error(`parentSummary 缺少 ${heading}`);
  }
  const r = data.report;
  if (!r || typeof r !== "object") throw new Error("缺少 report");
  if (!Array.isArray(r.content) || !r.content.length) throw new Error("report.content 应为非空数组");
  if (!Array.isArray(r.mastery)) throw new Error("report.mastery 应为数组");
  const mastery = r.mastery.slice(0, 6).map((item: Record<string, unknown>, index: number) => {
    const status = str(item?.status, `mastery[${index}].status`);
    if (!(MASTERY_STATUSES as readonly string[]).includes(status)) throw new Error(`mastery[${index}].status 不在 ${MASTERY_STATUSES.join("/")} 中`);
    return { name: str(item.name, `mastery[${index}].name`), status: status as ClassReport["mastery"][number]["status"], evidence: str(item.evidence, `mastery[${index}].evidence`) };
  });
  return {
    parentSummary,
    report: {
      topic: str(r.topic, "report.topic"),
      lead: str(r.lead, "report.lead"),
      content: r.content.map((line: unknown, index: number) => str(line, `content[${index}]`).replace(/^\d+[.、]\s*/, "")),
      mastery,
      performance: str(r.performance, "report.performance"),
      issue: { title: str(r.issue?.title, "report.issue.title"), fix: str(r.issue?.fix, "report.issue.fix") },
      review: str(r.review, "report.review"),
      questions: parseQuestions(r.questions),
    },
  };
}

// ---------- 老师在网页上改报告：只改文字，结构、时间、掌握程度、发言统计都不变 ----------

const clean = (v: unknown, max = 2000) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : undefined);
/** 必填文字：没传或清空就保留原文 */
const keep = (v: unknown, old: string) => clean(v) || old;
/** 可删的列表项：没传保留原文，清空 = 删掉这一条（返回 null） */
const drop = (v: unknown, old: string) => { const s = clean(v); return s === undefined ? old : s || null; };
/** 可留空的文字（如回答、负责人） */
const free = (v: unknown, old: string) => clean(v) ?? old;
const at = (list: unknown, i: number): any => (Array.isArray(list) ? (list[i] ?? {}) : {});

export function applyReportEdits(kind: LessonKind | undefined, old: ClassReport | MeetingReport, edited: any): ClassReport | MeetingReport {
  const e = edited && typeof edited === "object" ? edited : {};
  if (kind === "meeting") {
    const o = old as MeetingReport;
    return {
      ...o,
      title: keep(e.title, o.title),
      lead: keep(e.lead, o.lead),
      // 议题带时间，撑着时间分布图：只改字，不删
      sections: o.sections.map((s, i) => ({
        ...s, title: keep(at(e.sections, i).title, s.title),
        items: s.items.map((it, j) => ({ ...it, title: keep(at(at(e.sections, i).items, j).title, it.title), conclusion: keep(at(at(e.sections, i).items, j).conclusion, it.conclusion) })),
      })),
      decisions: o.decisions.flatMap((d, i) => { const text = drop(at(e.decisions, i).text, d.text); return text ? [{ ...d, text }] : []; }),
      todos: o.todos.flatMap((t, i) => {
        const x = at(e.todos, i);
        const task = drop(x.task, t.task);
        return task ? [{ ...t, task, owner: free(x.owner, t.owner), due: free(x.due, t.due) }] : [];
      }),
      followups: o.followups.flatMap((f, i) => { const v = drop(Array.isArray(e.followups) ? e.followups[i] : undefined, f); return v ? [v] : []; }),
    };
  }
  const o = old as ClassReport;
  const renamed = new Map<string, string | null>(); // 知识点改名跟着改章节归属；删掉的知识点，章节保留原名（知识点用时不丢时间）
  const mastery = o.mastery.flatMap((m, i) => {
    const x = at(e.mastery, i);
    const name = drop(x.name, m.name);
    if (name !== m.name) renamed.set(m.name, name);
    return name ? [{ ...m, name, evidence: keep(x.evidence, m.evidence) }] : [];
  });
  return {
    ...o,
    topic: keep(e.topic, o.topic),
    lead: keep(e.lead, o.lead),
    content: o.content.flatMap((c, i) => { const v = drop(Array.isArray(e.content) ? e.content[i] : undefined, c); return v ? [v] : []; }),
    mastery,
    performance: keep(e.performance, o.performance),
    issue: { title: keep(e.issue?.title, o.issue.title), fix: keep(e.issue?.fix, o.issue.fix) },
    homework: keep(e.homework, o.homework),
    review: keep(e.review, o.review),
    next: keep(e.next, o.next),
    ...(o.chapters && {
      chapters: o.chapters.map((c, i) => ({ ...c, title: keep(at(e.chapters, i).title, c.title), point: renamed.get(c.point) || c.point })),
    }),
    ...(o.questions && {
      questions: o.questions.flatMap((q, i) => { const x = at(e.questions, i); const text = drop(x.text, q.text); return text ? [{ ...q, text, answer: free(x.answer, q.answer) }] : []; }),
    }),
  };
}
