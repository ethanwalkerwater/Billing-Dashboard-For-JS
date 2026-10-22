/**
 * 菁仕课堂云端的纯逻辑（不碰飞书 / 数据库 / 腾讯云），云函数 classroom-api 负责 IO。
 * 课表字段名与 jingshi-vocal、取消课程模块一致；「老师课程ID」公式 = [请假前缀｜]HH:MM-HH:MM｜学生｜课程类型｜授课类型。
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const SEGMENT_SECONDS = 30;
export const MAX_ATTEMPTS = 3;
/** 下课（finish 里的 endedAt）2 小时后仍缺段，就用已有分段出报告 */
export const MISSING_GRACE_MS = 2 * HOUR;
/** 没发 finish 的课：分段停止上传这么久才算 App 不会再回来（断网很久的 App 正在补传时不能抢先出报告） */
export const ORPHAN_QUIET_MS = 30 * 60_000;
export const CHUNK_CHARS = 12_000;

export const SCHEDULE_FIELDS = ["老师", "学生", "上课时间", "下课时间", "课程时长", "课程类型", "上课地点", "临时取消", "老师课程ID"];

export type Stage = "recording" | "queued" | "transcribing" | "summarizing" | "done" | "failed";
export type LessonStatus = "upcoming" | "recording" | "processing" | "done" | "cancelled";
/** lesson = 课表里的课；adhoc = 随时录制选「课程」；meeting = 随时录制选「会议」 */
export type LessonKind = "lesson" | "adhoc" | "meeting";
/** 随时录制的课程编号由 App 生成，不在飞书课表里 */
export const isAdhocId = (id: string) => /^adhoc-[0-9a-f]{16}$/.test(id);
/** 随时录制最长 3 小时（App 到点自动停）；建档时先按这个占位下课时间，finish 时改成真实时间 */
export const ADHOC_MAX_MS = 3 * HOUR;
/** 录音（分段 + merged.mp3）保留 30 天，转写和总结一直保留 */
export const AUDIO_KEEP_MS = 30 * DAY;
export const MASTERY_STATUSES = ["本课已学习", "开始运用", "基本掌握", "需要巩固"] as const;
/** 课堂时间轴的环节类型；顺序 = 报告里的配色顺序（styles.css .p0–.p6） */
export const PHASES = ["复习", "讲解", "例题", "练习", "答疑", "总结", "其他"] as const;

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
  kind?: "adhoc" | "meeting";
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
  /** 课堂时间轴，秒；points 只含 mastery 里的知识点名。旧报告没有这两项 */
  timeline?: Array<{ phase: (typeof PHASES)[number]; title: string; start: number; end: number; points: string[] }>;
  /** 学生主动提的问题，time 为秒 */
  questions?: Array<{ time: number | null; text: string; answer: string }>;
  gapMinutes?: number;
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
  finish?: { startedAt: string; endedAt: string; segments: FinishSegment[] };
  mergedFileId?: string;
  asrTaskId?: number | null;
  transcript?: string;
  gapMinutes?: number;
  summary?: string;
  editedSummary?: string;
  /** 课 = 学情报告；会议 = 结构化会议纪要 */
  report?: ClassReport | MeetingReport;
  reportToken?: string;
  /** 生成总结时用的提示词版本（classroom_prompts.version，0 = 代码里的默认） */
  promptVersion?: number;
  copied?: boolean;
  kind?: LessonKind;
  /** 录音过了保留期被删掉的时间 */
  audioDeletedAt?: number | null;
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
  };
  if (status === "done" && doc) {
    lesson.summary = doc.editedSummary || doc.summary || "";
    if (doc.reportToken) lesson.reportUrl = `${reportBaseUrl}?t=${doc.reportToken}`;
  }
  return lesson;
}

export function reportData(doc: LessonDoc) {
  const started = Date.parse(doc.finish?.startedAt ?? "");
  const ended = Date.parse(doc.finish?.endedAt ?? "");
  const recorded = Number.isFinite(started) && Number.isFinite(ended) && ended > started ? ended - started : doc.endAt - doc.startAt;
  return {
    student: doc.student,
    course: doc.course,
    teacher: doc.teacherName,
    kind: doc.kind ?? "lesson",
    date: shDate(doc.startAt),
    time: `${shTime(doc.startAt)}–${shTime(doc.endAt)}`,
    mins: Math.round(recorded / 60_000),
    report: doc.report,
    gapMinutes: doc.gapMinutes ?? 0,
  };
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

export function nextStep(doc: Pick<LessonDoc, "stage" | "failedStage" | "attempts" | "finish" | "segments" | "endAt" | "updatedAt">, now: number): Step {
  if (doc.stage === "failed") {
    return doc.attempts < MAX_ATTEMPTS && doc.failedStage ? { action: "retry", stage: doc.failedStage } : { action: "none" };
  }
  if (doc.stage === "transcribing") return { action: "poll" };
  if (doc.stage === "summarizing") return { action: "summarize" };
  // App 再没回来（没发 finish）：课表下课 2 小时后、且分段停传 30 分钟，用已收到的分段先出报告；一段都没有则合并时报错走失败重试
  // ponytail: 没有清单就算不出缺失时长，gapMinutes 记 0；App 之后补发 finish 不会重出报告
  if (doc.stage === "recording" && !doc.finish && now >= doc.endAt + MISSING_GRACE_MS && now >= doc.updatedAt + ORPHAN_QUIET_MS) {
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
1. 二次函数的三种形式：一般式、顶点式、交点式，以及它们之间怎么互相转换；
2. 用配方法求顶点坐标和对称轴；
3. 做了 2 道历年真题里的作图题。

【课堂表现】
浩然配方法的步骤已经很熟练，作图题第一次就画对了开口方向和顶点。需要注意的是，审题时容易漏看“x > 0”这类条件，今天有一题因此多写了一个解。

【课后建议】
请孩子做题前先用笔圈出题目里的条件。下节课我们会讲二次不等式。

有任何问题欢迎随时联系我～`;

export interface PromptMeta { student: string; course: string; teacher: string; monthDay: string }

/** 后台可编辑的四段提示词；JSON 结构与 status 取值写死在代码里（parseSummary / parseMeetingReport 依赖它们）。meeting 只给会议用，不套 rules */
export interface Prompts { rules: string; parent: string; report: string; meeting: string }

export const DEFAULT_PROMPTS: Prompts = {
  rules: `${ROLE_RULE}

可信原则：只使用转写里有依据的内容，不编造学生的表现、分数或没讲过的知识点。某一项在转写里找不到足够依据时，直接写「本课数据不足」，不要硬凑。`,
  parent: `parentSummary 写作要求（纯文字，老师会复制到微信直接发给家长）：
- 第一行：「{称呼}，今天（{日期}）的{课程}课向您汇报一下：」。称呼默认用「{学生}家长您好」；只有转写里明确说到对接的是妈妈或爸爸时，才写「{学生}妈妈您好」或「{学生}爸爸您好」。
- 接着依次三段，标题各占一行：【今天学了什么】用 1. 2. 3. 编号列 1–3 条；【课堂表现】先写一个具体的进步，再写一个需要改进的地方，不空夸；【课后建议】写具体可执行的练习，转写里提到了下节课内容就补一句。
- 最后一行：「有任何问题欢迎随时联系我～」
- 段与段之间空一行，总长 250–400 字。用家长能看懂的话，不写分数、正确率、专注度这类评判性数字，不用教研术语，不用 Markdown 符号（不要 **、#、- ）。

范例（只学格式和语气，不要照抄内容）：
${SAMPLE}`,
  report: `- topic：本课主题，12 字以内，如「二次函数」「Part 2 难忘的旅行」
- lead：一句话总结，35 字以内：已经能做到什么，下一步重点是什么
- content：本课学习内容，2–4 条，每条一句话，不要编号
- mastery：本课真实讲到的 3–6 个知识点；evidence 是判断依据，一句话，写课堂里的具体表现
- performance：学生课堂表现，2–3 句：先写具体的进步，再写一个需要改进的地方
- issue：最主要的一个易错点（title 15 字以内）和改进方法（fix 1–2 句，可直接照做）
- homework：作业与练习；review：复习方法
- next：下节课衔接；转写里没提到就写「具体内容待老师安排」
- timeline：按时间顺序把整节课切成 4–10 个环节，前后相接覆盖整节课。phase 从「${PHASES.join(" / ")}」里选一个（开场寒暄、调试设备、休息、闲聊算「其他」）；title 12 字以内，写这段在做什么；start / end 照抄转写里的时间（mm:ss）；points 写这段讲到的知识点，只能用 mastery 里的 name 原文，没讲知识点就写 []
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
    "performance": "", "issue": {"title": "", "fix": ""}, "homework": "", "review": "", "next": "",
    "timeline": [{"phase": "${PHASES.join(" / ")} 选一", "title": "", "start": "mm:ss", "end": "mm:ss", "points": ["mastery 里的 name"]}],
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

export function chunkPrompt(chunk: string, index: number, total: number, rules = DEFAULT_PROMPTS.rules): string {
  return `下面是一节课录音转写的第 ${index + 1}/${total} 段。${rules}
请按时间顺序整理这一段的要点（纯文字，1000 字以内）：先按环节列出这一段的时间线，每个环节写起止时间（mm:ss，照抄转写里的时间）、在做什么（复习 / 讲解 / 例题 / 练习 / 答疑 / 总结 / 其他）、涉及哪些知识点；再写学生答对了什么、答错了什么、主动问了什么（保留学生原话和时间）；老师怎么纠正；布置了什么作业、提到下节课讲什么。只写转写里有的内容，不要推测。

${chunk}`;
}

export function summaryMessages(meta: PromptMeta, material: string, isNotes: boolean, prompts: Prompts = DEFAULT_PROMPTS) {
  const system = `你是菁仕教育的资深教研老师，根据一节课的录音转写，同时写两份内容：给家长的课堂总结、给老师和教研看的结构化课堂报告。
${fill(prompts.rules, meta)}
只输出一个 JSON 对象，不要 markdown 代码块，不要任何其他文字。`;
  const user = `课程信息：学生 ${meta.student || "学生"}；课程 ${meta.course || "本课"}；日期 ${meta.monthDay}；老师 ${meta.teacher}。

JSON 结构：
${SKELETON}

report 各字段要求：
${fill(prompts.report, meta)}

${fill(prompts.parent, meta)}

parentSummary 与 report 的内容必须一致。

${isNotes ? "课堂要点（由完整转写按时间分段整理）" : "课堂转写（[角色 开始-结束] 文本）"}：
${material}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
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

/** 时间轴：丢掉时间不合法的环节，按开始排序，重叠的部分从前一段结束处截断；知识点只认 mastery 里有的 */
function parseTimeline(raw: unknown, names: Set<string>): NonNullable<ClassReport["timeline"]> {
  if (!Array.isArray(raw)) return [];
  let last = 0;
  return raw
    .flatMap((item: Record<string, unknown>) => {
      const start = seconds(item?.start);
      const end = seconds(item?.end);
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      if (!(end > start) || !title) return [];
      const phase = (PHASES as readonly string[]).includes(item.phase as string) ? (item.phase as (typeof PHASES)[number]) : "其他";
      const points = Array.isArray(item.points) ? [...new Set(item.points.map((p) => String(p).trim()).filter((p) => names.has(p)))] : [];
      return [{ phase, title, start, end, points }];
    })
    .sort((a, b) => a.start - b.start)
    .flatMap((item) => {
      const start = Math.max(item.start, last);
      if (item.end <= start) return [];
      last = item.end;
      return [{ ...item, start }];
    });
}

function parseQuestions(raw: unknown): NonNullable<ClassReport["questions"]> {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((q: Record<string, unknown>) => {
      const text = typeof q?.text === "string" ? q.text.trim() : "";
      const time = seconds(q?.time);
      return text ? [{ time: Number.isFinite(time) ? time : null, text, answer: typeof q.answer === "string" ? q.answer.trim() : "" }] : [];
    })
    .slice(0, 5);
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${name}`);
  return value.trim();
}

export function parseSummary(raw: string, headings = promptHeadings(DEFAULT_PROMPTS)): { parentSummary: string; report: ClassReport } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("输出里没有 JSON");
  const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, any>;
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
      homework: str(r.homework, "report.homework"),
      review: str(r.review, "report.review"),
      next: str(r.next, "report.next"),
      // 新加的两项不强制：线上提示词是旧版本时也能出报告，只是不显示时间轴和提问
      timeline: parseTimeline(r.timeline, new Set(mastery.map((m: { name: string }) => m.name))),
      questions: parseQuestions(r.questions),
    },
  };
}
