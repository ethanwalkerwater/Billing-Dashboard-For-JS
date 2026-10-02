/**
 * 雅思正向率的全部规则。纯函数，前后端共用：
 * 云函数用 parseScoreRecord / parseLesson 把飞书记录压成快照；浏览器用 buildSamples + tally 现算。
 * 口径见 specs/ielts-progress/design.md。
 */

export const SUBJECTS = ["听力", "阅读", "写作", "口语"] as const;
export type Subject = (typeof SUBJECTS)[number];

/** 阶段模考只做记录（学生视图里能看到走势），不当作实考、也不当作实考的比较对象。 */
export type ScoreKind = "baseline" | "mock" | "exam";
export const KIND_LABELS: Record<ScoreKind, string> = { baseline: "基线", mock: "阶段模考", exam: "实考" };
const KIND_BY_LABEL: Record<string, ScoreKind> = { 基线: "baseline", 阶段模考: "mock", 实考: "exam" };

/** 飞书「雅思成绩」表一行，云函数解析后存进快照。 */
export interface ScoreRecord {
  id: string;
  /** 飞书自动编号，给人看的 */
  no: string;
  studentId: string;
  studentName: string;
  kind: ScoreKind | null;
  /** 上海时区 YYYY-MM-DD；缺失为空串 */
  date: string;
  scores: Partial<Record<Subject, number>>;
  attachments: number;
  verified: boolean;
  submitter: string;
  note: string;
  /** 教务手动指定的授课老师（「听力老师」等字段），有就不按课表推算 */
  teachers: Partial<Record<Subject, string[]>>;
  /** 录入层面的问题（没选学生、分数不合法…），有问题的整条不计入 */
  problems: string[];
}

/** 课表里一节能对应到科目的雅思课。 */
export interface Lesson {
  studentIds: string[];
  teacher: string;
  subjects: Subject[];
  date: string;
}

export interface FeishuSnapshot {
  scores: ScoreRecord[];
  lessons: Lesson[];
  /** 含「雅思」但识别不出科目的课程类型 → 条数 */
  unknownTypes: Record<string, number>;
  syncedAt: string;
}

export type Outcome = "up" | "flat" | "down";
export const OUTCOME_LABELS: Record<Outcome, string> = { up: "提升", flat: "持平", down: "下降" };

/** 一次实考的一科 = 一条样本。多位老师共享同一条样本。 */
export interface Sample {
  key: string;
  recordId: string;
  studentId: string;
  studentName: string;
  subject: Subject;
  date: string;
  prevDate: string | null;
  prevKind: ScoreKind | null;
  before: number;
  after: number;
  delta: number;
  outcome: Outcome;
  /** 老师 → 两次成绩之间该科的课数 */
  teachers: Array<{ name: string; lessons: number }>;
  /** 老师来自教务手动指定，而不是课表推算 */
  assigned: boolean;
}

export type IssueKind = "录入有误" | "疑似重复" | "缺成绩单" | "待核验" | "缺少上一次成绩" | "无授课老师";
export const ISSUE_ORDER: IssueKind[] = ["待核验", "缺成绩单", "录入有误", "疑似重复", "缺少上一次成绩", "无授课老师"];

export interface Issue {
  kind: IssueKind;
  recordId: string;
  no: string;
  studentName: string;
  date: string;
  subject?: Subject;
  detail: string;
}

// ---------- 课程类型 → 科目 ----------

const EXCLUDED_TYPE = /刷题|试听|考试|模考|笔考/;

/** [] = 明确不计入；null = 含「雅思」但识别不出科目；非雅思课也返回 []。 */
export function subjectsOf(courseType: string): Subject[] | null {
  const type = courseType.trim();
  if (!type.includes("雅思") || EXCLUDED_TYPE.test(type)) return [];
  if (type === "雅思") return [...SUBJECTS];
  const found = SUBJECTS.filter((subject) => type.includes(subject));
  return found.length > 0 ? found : null;
}

// ---------- 飞书字段解析 ----------

const SHANGHAI_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export function shanghaiDate(milliseconds: number): string {
  return SHANGHAI_DATE.format(new Date(milliseconds));
}

/** v1 records 接口的关联字段：[{ record_ids, text, ... }]，兼容 [{ id }] / 裸字符串。 */
function readLinks(value: unknown): Array<{ id: string; text: string }> {
  if (!Array.isArray(value)) return [];
  const links: Array<{ id: string; text: string }> = [];
  for (const item of value) {
    if (typeof item === "string") links.push({ id: item, text: "" });
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const ids = [record.record_ids, record.link_record_ids].find(Array.isArray) as unknown[] | undefined;
      const single = [record.id, record.record_id].find((v) => typeof v === "string") as string | undefined;
      const text = typeof record.text === "string" ? record.text : "";
      for (const id of ids ?? (single ? [single] : [])) if (typeof id === "string" && id) links.push({ id, text });
    }
  }
  return links;
}

/** 学员信息主字段是「姓名-联系方式」，展示时去掉尾巴。 */
export function cleanStudentName(text: string): string {
  return text.replace(/-[^-]*$/, "").trim() || text.trim();
}

function readText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : (item as { text?: string })?.text ?? "")).join("").trim();
  if (value && typeof value === "object" && "name" in value) return String((value as { name: unknown }).name ?? "").trim();
  return "";
}

/** 0–9、步长 0.5 */
export function isValidBand(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 9 && Number.isInteger(value * 2);
}

export function parseScoreRecord(recordId: string, fields: Record<string, unknown>): ScoreRecord {
  const problems: string[] = [];
  const students = readLinks(fields["学生"]);
  if (students.length === 0) problems.push("没选学生");
  if (students.length > 1) problems.push(`选了 ${students.length} 个学生`);

  const kindText = readText(fields["成绩类型"]);
  const kind: ScoreKind | null = KIND_BY_LABEL[kindText] ?? null;
  if (!kind) problems.push(kindText ? `成绩类型「${kindText}」无法识别` : "没选成绩类型");

  const rawDate = fields["考试日期"];
  const date = typeof rawDate === "number" ? shanghaiDate(rawDate) : "";
  if (!date) problems.push("没填考试日期");

  const scores: Partial<Record<Subject, number>> = {};
  for (const subject of SUBJECTS) {
    const text = readText(fields[subject]);
    if (!text) continue;
    const value = Number(text);
    if (isValidBand(value)) scores[subject] = value;
    else problems.push(`${subject}分数「${text}」不合法`);
  }
  if (Object.keys(scores).length === 0 && !problems.some((p) => p.includes("分数"))) problems.push("四科都没填分数");

  const teachers: Partial<Record<Subject, string[]>> = {};
  for (const subject of SUBJECTS) {
    const names = readText(fields[`${subject}老师`]).split(/[、,，/&]+/).map((name) => name.trim()).filter(Boolean);
    if (names.length > 0) teachers[subject] = [...new Set(names)];
  }

  return {
    id: recordId,
    no: readText(fields["编号"]),
    studentId: students[0]?.id ?? "",
    studentName: cleanStudentName(students[0]?.text ?? ""),
    kind,
    date,
    scores,
    attachments: Array.isArray(fields["成绩单"]) ? fields["成绩单"].length : 0,
    verified: fields["已核验"] === true,
    submitter: readText(fields["提交人"]),
    note: readText(fields["备注"]),
    teachers,
    problems,
  };
}

/** 课表一行 → 雅思课。不计入的返回 null；识别不出科目的返回 { unknownType }。 */
export function parseLesson(fields: Record<string, unknown>): Lesson | { unknownType: string } | null {
  const courseType = readText(fields["课程类型"]);
  const subjects = subjectsOf(courseType);
  if (subjects === null) return { unknownType: courseType };
  const teacher = readText(fields["老师"]);
  const startsAt = fields["上课时间"];
  const cancelled = readText(fields["临时取消"]) !== "";
  const studentIds = readLinks(fields["学生"]).map((link) => link.id);
  if (subjects.length === 0 || cancelled || !teacher || typeof startsAt !== "number" || studentIds.length === 0) return null;
  return { studentIds, teacher, subjects, date: shanghaiDate(startsAt) };
}

// ---------- 配对与归属 ----------

function outcomeOf(delta: number): Outcome {
  return delta > 0 ? "up" : delta < 0 ? "down" : "flat";
}

const KIND_RANK: Record<ScoreKind, number> = { baseline: 0, mock: 1, exam: 2 };

/**
 * 每次已核验的实考，每科和该学生上一次该科有分的成绩比；授课老师取
 * 上一次成绩日期 ≤ 上课日期 < 本次考试日期 之间教过该科的老师。
 */
export function buildSamples(scores: ScoreRecord[], lessons: Lesson[]): { samples: Sample[]; issues: Issue[]; records: ScoreRecord[] } {
  const issues: Issue[] = [];
  const issue = (record: ScoreRecord, kind: IssueKind, detail: string, subject?: Subject) =>
    issues.push({ kind, recordId: record.id, no: record.no, studentName: record.studentName || "（未选学生）", date: record.date, subject, detail });

  const clean = scores.filter((record) => {
    if (record.problems.length === 0) return true;
    issue(record, "录入有误", record.problems.join("；"));
    return false;
  });

  const groups = new Map<string, ScoreRecord[]>();
  for (const record of clean) {
    const key = `${record.studentId}|${record.date}|${record.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const usable: ScoreRecord[] = [];
  for (const group of groups.values()) {
    if (group.length > 1) {
      const nos = group.map((record) => `#${record.no}`).join("、");
      for (const record of group) issue(record, "疑似重复", `同一学生同一天有 ${group.length} 条${KIND_LABELS[record.kind!]}（${nos}），删掉多余的`);
      continue;
    }
    const record = group[0]!;
    // 「已核验」是教务的最终确认：历史补录没有成绩单，核验过照样计入
    if (record.kind === "exam" && !record.verified) {
      if (record.attachments === 0) issue(record, "缺成绩单", "实考没有上传成绩单");
      else issue(record, "待核验", "教务在飞书勾选「已核验」后计入");
    } else usable.push(record);
  }

  const lessonsByStudent = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    for (const id of lesson.studentIds) lessonsByStudent.set(id, [...(lessonsByStudent.get(id) ?? []), lesson]);
  }

  const byStudent = new Map<string, ScoreRecord[]>();
  for (const record of usable) byStudent.set(record.studentId, [...(byStudent.get(record.studentId) ?? []), record]);

  const samples: Sample[] = [];
  for (const [studentId, records] of byStudent) {
    records.sort((a, b) => a.date.localeCompare(b.date) || KIND_RANK[a.kind!] - KIND_RANK[b.kind!] || Number(a.no) - Number(b.no));
    const studentLessons = lessonsByStudent.get(studentId) ?? [];
    for (const subject of SUBJECTS) {
      let prev: ScoreRecord | null = null;
      for (const record of records) {
        const after = record.scores[subject];
        if (after === undefined || record.kind === "mock") continue;
        if (record.kind === "exam") {
          if (!prev) issue(record, "缺少上一次成绩", `${subject}之前没有基线或实考成绩可比`, subject);
          else {
            const counts = new Map<string, number>();
            for (const lesson of studentLessons) {
              if (lesson.subjects.includes(subject) && lesson.date >= prev.date && lesson.date < record.date) {
                counts.set(lesson.teacher, (counts.get(lesson.teacher) ?? 0) + 1);
              }
            }
            const assigned = record.teachers[subject];
            const teachers = assigned
              ? assigned.map((name) => ({ name, lessons: counts.get(name) ?? 0 }))
              : [...counts].map(([name, count]) => ({ name, lessons: count })).sort((a, b) => b.lessons - a.lessons);
            if (teachers.length === 0) issue(record, "无授课老师", `${prev.date} 至 ${record.date} 之间课表里没有${subject}课`, subject);
            else {
              const before = prev.scores[subject]!;
              const delta = after - before;
              samples.push({
                key: `${record.id}|${subject}`,
                recordId: record.id,
                studentId: record.studentId,
                studentName: record.studentName,
                subject,
                date: record.date,
                prevDate: prev.date,
                prevKind: prev.kind,
                before,
                after,
                delta,
                outcome: outcomeOf(delta),
                teachers,
                assigned: Boolean(assigned),
              });
            }
          }
        }
        prev = record;
      }
    }
  }
  return { samples, issues, records: usable };
}

// ---------- 汇总 ----------

export interface Tally {
  n: number;
  up: number;
  flat: number;
  down: number;
  deltaSum: number;
}

export const emptyTally = (): Tally => ({ n: 0, up: 0, flat: 0, down: 0, deltaSum: 0 });

export function addSample(tally: Tally, sample: Sample): Tally {
  tally.n += 1;
  tally[sample.outcome] += 1;
  tally.deltaSum += sample.delta;
  return tally;
}

/** 整体统计：每条样本只算一次。 */
export function tally(samples: Sample[]): Tally {
  return samples.reduce(addSample, emptyTally());
}

/** 按任意维度分组；一条样本可落进多个组（多位老师各算一次）。 */
export function groupTally(samples: Sample[], keysOf: (sample: Sample) => string[]): Map<string, Tally> {
  const groups = new Map<string, Tally>();
  for (const sample of samples) {
    for (const key of new Set(keysOf(sample))) addSample(groups.get(key) ?? groups.set(key, emptyTally()).get(key)!, sample);
  }
  return groups;
}

export const teachersOf = (sample: Sample) => sample.teachers.map((item) => item.name);

export function positiveRate(value: Tally): number | null {
  return value.n === 0 ? null : value.up / value.n;
}

export function averageDelta(value: Tally): number | null {
  return value.n === 0 ? null : value.deltaSum / value.n;
}

/** 样本少于这个数的老师灰显、不参与排名 */
export const MIN_SAMPLES = 5;
