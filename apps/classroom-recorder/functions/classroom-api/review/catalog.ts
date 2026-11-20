import { pg, eq, requireEnv, feishu, sha256 } from "../index";
import { parseTeacher, TEACHER_FIELDS } from "../../../../teacher-birthday/src/domain/records";
import { AUDIO_FILE, EARLY_FILE, AUDIO_KEEP_MS, type LessonDoc } from "../../../src/server/logic";
import { isTeaching, monthOf, monthRange, type LessonRow } from "../../../src/server/workbench";
import { parseTranscript } from "./analyze.cjs";

const DAY = 86_400_000;
const PILOT = Date.parse("2026-11-11T00:00:00+08:00");
const LESSON_ID = /^(rec[A-Za-z0-9]{1,64}|adhoc-[0-9a-f]{16})$/;
const DATE = /^20\d\d-[01]\d-[0-3]\d$/;
type Actor = { openId: string; name: string };
type Query = Record<string, string>;
type Body = Record<string, unknown>;
type Metrics = {
  mode: string;
  rt: number;
  ch: number;
  talkRatio: number;
  questions: number;
  openQuestions: number;
  longestLectureSec: number;
};
type LessonRowDb = {
  id: string;
  teacherId: string;
  teacherName: string;
  course: string;
  student: string;
  startAt: number;
  endAt: number;
  stage: string;
  audioSec: number | null;
  audioDeleted: boolean;
  audioPresent: boolean;
  hasTranscript: boolean;
  reviewStatus: string | null;
  pending: number;
  confirmed: number;
  metrics: Metrics | null;
  firstIssue?: {
    category: string;
    priority: string;
    title: string;
    state: string;
    evidence: { start: number; text: string }[];
  } | null;
  miniSegments?: { start: number; end: number; kind: string }[];
};
type Stats = {
  id: string;
  name: string;
  aliases: string[];
  monthIds: string[];
  courses: string[] | null;
  modes: Record<string, number>;
  medianTalkRatio: number | null;
  pending: number;
  confirmed: number;
};
type Profile = {
  teacher_id: string;
  name: string;
  schedule_name: string;
  subject: string;
  grade: string;
  classes: string[];
};
type Cache = { rows: LessonRow[]; syncedAt: number };
type Teacher = {
  id: string;
  name: string;
  aliases: string[];
  subject: string;
  grade: string;
  classes: string[];
  monthly: number | null;
  recordedMonthly: number;
  pending: number;
  confirmed: number;
  topMode: string | null;
  modes: Record<string, number>;
  medianTalkRatio: number | null;
};
type Deps = { signedUrl: (name: string, seconds: number) => Promise<string> };
const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const dayOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim().length <= max ? v.trim() : "");
const dateMs = (date: string) => {
  const ms = Date.parse(date + "T00:00:00+08:00");
  if (!DATE.test(date) || !Number.isFinite(ms) || dayOf(ms) !== date) return fail(400, "请选择有效日期");
  return ms;
};
const lessonId = (id: string) => (LESSON_ID.test(id) ? id : fail(400, "课程编号无效"));
function termStart(now: number) {
  const [y, m] = monthOf(now).split("-").map(Number);
  return Date.UTC(m === 1 ? y - 1 : y, m === 1 || m >= 9 ? 8 : 1, 1) - 8 * 3_600_000;
}
async function schedule(month: string, from: number, to: number, id?: string) {
  const [cache] = await pg<Cache>("POST", "rpc/fupan_schedule", "", {
    p_month: month,
    p_from: from,
    p_to: to,
    p_id: id ?? null,
  });
  return { rows: (cache?.rows ?? []).filter(isTeaching), syncedAt: cache?.syncedAt ?? null };
}
const profiles = () =>
  pg<Profile>(
    "GET",
    "fupan_teacher_profiles",
    "select=teacher_id,name,schedule_name,subject,grade,classes&order=teacher_id",
  );
async function allRows<T>(table: string, query: string) {
  const items: T[] = [];
  for (;;) {
    const rows = await pg<T>("GET", table, query + "&limit=500&offset=" + items.length);
    items.push(...rows);
    if (rows.length < 500) return items;
  }
}

export function courseRow(row: LessonRowDb, now: number) {
  const expired = row.audioDeleted || (row.audioPresent && row.startAt + AUDIO_KEEP_MS <= now);
  const hasAudio = row.audioPresent && !expired;
  const recording = expired
    ? "原音已过期"
    : hasAudio
      ? "有录音"
      : row.stage === "recording"
        ? "录音中"
        : row.stage === "empty"
          ? "录音质量不足"
          : row.stage === "failed"
            ? "录音处理失败"
            : "录音处理中";
  const analysisStatus =
    row.reviewStatus === "done"
      ? "分析完成"
      : row.reviewStatus === "failed"
        ? "失败待重试"
        : ["running", "pending"].includes(row.reviewStatus ?? "")
          ? "分析中"
          : row.hasTranscript
            ? "未分析"
            : "待转写";
  const {
    id,
    teacherId,
    teacherName,
    course,
    student,
    startAt,
    endAt,
    hasTranscript,
    pending,
    confirmed,
    metrics,
    audioSec,
  } = row;
  return {
    id,
    teacherId,
    teacherName,
    course,
    student,
    startAt,
    endAt,
    recording,
    analysisStatus,
    reviewable: true,
    hasAudio,
    hasTranscript,
    pending,
    confirmed,
    metrics,
    audioSec,
    firstIssue: row.firstIssue ?? null,
    miniSegments: row.miniSegments ?? [],
  };
}
function planned(r: LessonRow, teacherId: string, now: number) {
  return {
    id: r[0],
    teacherId,
    teacherName: r[6],
    course: r[5],
    student: r[4],
    startAt: r[1],
    endAt: r[2],
    hasAudio: false,
    hasTranscript: false,
    reviewable: false,
    recording: r[1] > now ? "未开始" : "未录音",
    analysisStatus: "未分析",
    pending: 0,
    confirmed: 0,
    metrics: null,
    audioSec: null,
    firstIssue: null,
    miniSegments: [],
  };
}
const scheduleId = (name: string) => "sched-" + sha256(name).slice(0, 32);
function aliasMap(teachers: { id: string; aliases: string[] }[]) {
  const out = new Map<string, string | null>();
  for (const t of teachers) {
    for (const alias of t.aliases.filter(Boolean)) {
      if (!out.has(alias)) out.set(alias, t.id);
      else if (out.get(alias) !== t.id) out.set(alias, null);
    }
  }
  return out;
}
export function summarizeTeachers(stats: Stats[], profiles: Profile[], cache: Cache | null): Teacher[] {
  const people = new Map<string, Teacher>();
  const monthly = new Map<string, Set<string>>();
  for (const s of stats) {
    const modes = Object.entries(s.modes).sort((a, b) => b[1] - a[1]);
    people.set(s.id, {
      id: s.id,
      name: s.name,
      aliases: s.aliases ?? [s.name],
      subject: (s.courses ?? []).join("、"),
      grade: "",
      classes: [],
      monthly: null,
      recordedMonthly: s.monthIds.length,
      pending: Number(s.pending),
      confirmed: Number(s.confirmed),
      modes: s.modes,
      topMode: modes[0]?.[0] ?? null,
      medianTalkRatio: s.medianTalkRatio,
    });
    monthly.set(s.id, new Set(s.monthIds));
  }
  const blank = (id: string, name: string): Teacher => ({
    id,
    name,
    aliases: [name],
    subject: "",
    grade: "",
    classes: [],
    monthly: null,
    recordedMonthly: 0,
    pending: 0,
    confirmed: 0,
    topMode: null,
    modes: {},
    medianTalkRatio: null,
  });
  for (const p of profiles) {
    const t = people.get(p.teacher_id) ?? blank(p.teacher_id, p.name);
    Object.assign(t, {
      name: p.name,
      aliases: [...t.aliases, p.name, p.schedule_name],
      grade: p.grade,
      classes: p.classes,
      subject: p.subject || t.subject,
    });
    people.set(t.id, t);
  }
  if (cache) {
    const aliases = aliasMap([...people.values()]);
    const recorded = new Map<string, string>();
    for (const [id, ids] of monthly) for (const lesson of ids) recorded.set(lesson, id);
    for (const r of cache.rows.filter(isTeaching)) {
      if (!r[6]) continue;
      const id = recorded.get(r[0]) ?? aliases.get(r[6]) ?? scheduleId(r[6]);
      const t = people.get(id) ?? blank(id, r[6]);
      if (!t.subject) t.subject = r[5];
      people.set(id, t);
      if (!monthly.has(id)) monthly.set(id, new Set());
      monthly.get(id)!.add(r[0]);
    }
    for (const t of people.values()) t.monthly = monthly.get(t.id)?.size ?? 0;
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
}
async function teachers(now: number) {
  const month = monthOf(now),
    [start] = monthRange(month);
  const [stat, prof, cache] = await Promise.all([
    pg<Stats>("POST", "rpc/fupan_teacher_stats", "", { p_term: termStart(now), p_month: start, p_now: now }),
    profiles(),
    schedule(month, start, now + 1),
  ]);
  const items = summarizeTeachers(stat, prof, cache.syncedAt ? { rows: cache.rows, syncedAt: cache.syncedAt } : null);
  return { items, month, scheduleAvailable: Boolean(cache.syncedAt), scheduleSyncedAt: cache.syncedAt };
}

async function lessons(q: Query, now: number) {
  const date = q.date || dayOf(now),
    from = dateMs(date),
    to = from + DAY;
  const monday = from - ((new Date(from + 8 * 3_600_000).getUTCDay() + 6) % 7) * DAY;
  const weekFrom = Math.max(PILOT, monday),
    weekTo = monday + 7 * DAY;
  if (weekTo <= PILOT)
    return { items: [], date, scheduleAvailable: false, scheduleSyncedAt: null, weekCounts: {}, grades: [], subjects: [] };
  const months = [...new Set([monthOf(weekFrom), monthOf(weekTo - 1)])];
  type WeekLesson = Pick<LessonRowDb, "id" | "teacherId" | "teacherName" | "course" | "student" | "startAt" | "pending"> & {
    analyzed: boolean;
    flagged: boolean;
  };
  const [dayRows, snapshots, prof, identities, weekRecorded] = await Promise.all([
    allRows<LessonRowDb>("fupan_catalog_lessons", `startAt=gte.${from}&startAt=lt.${to}&order=startAt,id`),
    Promise.all(months.map((m) => schedule(m, weekFrom, weekTo))),
    profiles(),
    pg<{ id: string; aliases: string[] }>("GET", "fupan_catalog_identities", "select=id,aliases"),
    pg<WeekLesson>("POST", "rpc/fupan_week", "", { p_from: weekFrom, p_to: weekTo }),
  ]);
  const profile = new Map(prof.map((p) => [p.teacher_id, p]));
  const aliases = aliasMap([...identities, ...prof.map((p) => ({ id: p.teacher_id, aliases: [p.name, p.schedule_name] }))]);
  const plannedLessons = snapshots.flatMap((c) => c.rows).map((r) => planned(r, aliases.get(r[6]) ?? scheduleId(r[6]), now));
  const day = new Map<string, ReturnType<typeof courseRow>>(
    plannedLessons.filter((l) => l.startAt >= from && l.startAt < to).map((l) => [l.id, l]),
  );
  for (const r of dayRows) day.set(r.id, courseRow(r, now));
  const week = new Map<string, WeekLesson>(plannedLessons.map((l) => [l.id, { ...l, analyzed: false, flagged: false }]));
  for (const l of weekRecorded) week.set(l.id, l);
  const find = text(q.q, 80).toLowerCase();
  function match(l: Pick<WeekLesson, "teacherId" | "course" | "teacherName" | "student">) {
    const p = profile.get(l.teacherId);
    return (
      (!q.teacherId || l.teacherId === q.teacherId) &&
      (!q.grade || q.grade === p?.grade) &&
      (!q.subject || l.course === q.subject || p?.subject === q.subject) &&
      (!find || [l.course, l.teacherName, l.student, p?.classes.join(" ")].join(" ").toLowerCase().includes(find))
    );
  }
  const weekCounts: Record<string, { total: number; analyzed: number; pending: number }> = {};
  const subjects = new Set<string>();
  const grades = new Set<string>();
  for (const l of week.values()) {
    const p = profile.get(l.teacherId);
    if (l.course) subjects.add(l.course);
    if (p?.subject) subjects.add(p.subject);
    if (p?.grade) grades.add(p.grade);
    if (!match(l)) continue;
    const d = dayOf(l.startAt),
      count = (weekCounts[d] ??= { total: 0, analyzed: 0, pending: 0 });
    count.total++;
    if (l.analyzed) count.analyzed++;
    if (l.pending > 0) count.pending++;
  }
  const result = [...day.values()]
    .filter((l) => match(l) && (q.issues !== "1" || l.firstIssue))
    .sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id));
  const synced = snapshots[months.indexOf(date.slice(0, 7))]?.syncedAt ?? null;
  return {
    items: result,
    date,
    scheduleAvailable: Boolean(synced),
    scheduleSyncedAt: synced,
    weekCounts,
    subjects: [...subjects].sort(),
    grades: [...grades].sort(),
  };
}
async function lesson(q: Query, now: number) {
  const id = lessonId(q.id);
  const [row] = await pg<LessonRowDb>("GET", "fupan_catalog_lessons", `id=${eq(id)}&limit=1`);
  if (!row) {
    const [snapshot] = await pg<{ row: LessonRow }>("POST", "rpc/fupan_scheduled_lesson", "", { p_id: id });
    if (!snapshot || !isTeaching(snapshot.row)) return fail(404, "没有找到这节试点课程");
    const r = snapshot.row;
    const identities = await pg<{ id: string; aliases: string[] }>("GET", "fupan_catalog_identities", "select=id,aliases");
    const who = aliasMap(identities).get(r[6]);
    return {
      ...planned(r, who ?? scheduleId(r[6]), now),
      summary: "",
      segments: [],
      transcript: [],
      transcriptText: "",
      recordingStart: null,
      recordingEnd: null,
    };
  }
  const [doc] = await pg<LessonDoc>(
    "GET",
    "classroom_lessons",
    `_id=${eq(id)}&startAt=gte.${PILOT}&or=(kind.is.null,kind.in.(lesson,adhoc))&select=transcript,archive,summary,editedSummary,started:finish->>startedAt,ended:finish->>endedAt`,
  );
  if (!doc) return fail(404, "课程已变更，请刷新");
  let transcript: ReturnType<typeof parseTranscript> = [];
  try {
    if (doc.transcript) transcript = parseTranscript(doc.transcript);
  } catch {
    /* 老转写没有时间标记，保留原文供核对。 */
  }
  const clocks = doc as typeof doc & { started?: string; ended?: string };
  return {
    ...courseRow(row, now),
    summary: doc.editedSummary || doc.summary || "",
    segments: doc.archive?.segments ?? [],
    transcript,
    transcriptText: transcript.length ? "" : (doc.transcript ?? ""),
    recordingStart: Date.parse(clocks.started ?? "") || null,
    recordingEnd: Date.parse(clocks.ended ?? "") || null,
  };
}
export function audioKey(row: Pick<LessonDoc, "_id" | "kind" | "startAt" | "mergedFileId" | "audioDeletedAt">, now: number) {
  if (!LESSON_ID.test(row._id) || !["lesson", "adhoc"].includes(row.kind ?? "lesson") || row.startAt < PILOT)
    return fail(404, "没有找到这节试点课程");
  if (row.audioDeletedAt || row.startAt + AUDIO_KEEP_MS <= now) return fail(410, "原音已过期");
  const key = row.mergedFileId;
  if (key !== row._id + "/" + AUDIO_FILE && key !== row._id + "/" + EARLY_FILE) return fail(404, "这节课暂无可回听的原音");
  return { key, expiresIn: Math.max(1, Math.min(300, Math.floor((row.startAt + AUDIO_KEEP_MS - now) / 1000))) };
}
const table = () => ({ appToken: requireEnv("TEACHER_APP_TOKEN"), tableId: requireEnv("TEACHER_TABLE_ID") });
async function options(q: Query) {
  const name = text(q.q, 50);
  if (!name) return fail(400, "请输入老师姓名");
  const F = TEACHER_FIELDS;
  const records = await feishu().searchRecords({
    ...table(),
    fieldNames: [F.name, F.scheduleName, F.feishu, F.subject],
    filter: {
      conjunction: "or",
      conditions: [F.name, F.scheduleName].map((field) => ({ field_name: field, operator: "contains", value: [name] })),
    },
  });
  return {
    items: records.slice(0, 50).map((r) => {
      const t = parseTeacher(r);
      return { id: t.recordId, name: t.name, scheduleName: t.scheduleName, subject: t.subject };
    }),
  };
}
async function addTeacher(b: Body, actor: Actor) {
  const recordId = text(b.teacherId, 70),
    name = text(b.name, 80),
    grade = text(b.grade, 32);
  const classes = Array.isArray(b.classes) ? [...new Set(b.classes.map((c) => text(c, 80)))] : [];
  if (
    !/^rec[A-Za-z0-9]+$/.test(recordId) ||
    !grade ||
    !name ||
    !classes.length ||
    classes.length > 40 ||
    classes.some((c) => !c)
  )
    return fail(400, "请选择老师，并填写年级和任教班级");
  const record = await feishu().getRecord({ ...table(), recordId });
  if (!record) return fail(404, "飞书老师档案不存在");
  const t = parseTeacher(record);
  if (t.name !== name) return fail(409, "老师姓名已变更，请重新选择");
  const id = t.openId || recordId;
  const saved = await pg<{ teacher_id: string }>(
    "POST",
    "fupan_teacher_profiles",
    "on_conflict=record_id&select=teacher_id",
    [
      {
        teacher_id: id,
        record_id: recordId,
        name: t.name,
        schedule_name: t.scheduleName,
        grade,
        classes,
        subject: text(b.subject, 80) || t.subject,
        updated_by: actor.openId,
        updated_at: new Date().toISOString(),
      },
    ],
    "resolution=ignore-duplicates,return=representation",
  );
  if (!saved.length) return fail(409, "这位老师已登记，请返回老师列表");
  return { id };
}
async function teacherDetail(q: Query, now: number) {
  const directory = await teachers(now),
    t = directory.items.find((x) => x.id === q.id);
  if (!t) return fail(404, "没有找到这位老师");
  const from = Math.max(PILOT, dateMs(dayOf(now)) - 13 * DAY),
    to = now + 1;
  const months = [...new Set([monthOf(from), monthOf(now)])];
  const aliases = aliasMap(directory.items);
  const scheduleNames = t.aliases.filter(name => (aliases.get(name) ?? scheduleId(name)) === t.id);
  const [recorded, cal, issues, notes, [coverage]] = await Promise.all([
    allRows<LessonRowDb>(
      "fupan_catalog_lessons",
      `teacherId=${eq(t.id)}&startAt=gte.${from}&startAt=lt.${to}&order=startAt.desc,id`,
    ),
    Promise.all(months.map((m) => schedule(m, from, to))),
    pg(
      "GET",
      "fupan_issues",
      `teacherOpenId=${eq(t.id)}&startAt=gte.${termStart(now)}&select=lessonId,findingId,category,priority,title,state,result,startAt&order=startAt.desc,findingId&limit=100`,
    ),
    pg("GET", "fupan_catalog_notes", `teacherId=${eq(t.id)}&startAt=gte.${termStart(now)}&order=at.desc&limit=100`),
    pg<{ recorded: number; total: number | null }>("POST", "rpc/fupan_teacher_coverage", "", {
      p_teacher: t.id, p_names: scheduleNames, p_start: termStart(now), p_now: now,
    }),
  ]);
  const recent = new Map<string, ReturnType<typeof courseRow>>();
  for (const r of cal.flatMap((c) => c.rows)) {
    const id = aliases.get(r[6]) ?? scheduleId(r[6]);
    if (id === t.id) recent.set(r[0], planned(r, t.id, now));
  }
  for (const r of recorded) recent.set(r.id, courseRow(r, now));
  return {
    ...t,
    coverage,
    recentLessons: [...recent.values()].sort((a, b) => b.startAt - a.startAt),
    issues,
    notes,
    month: directory.month,
    scheduleAvailable: directory.scheduleAvailable,
  };
}
export async function catalog(method: string, path: string, query: Query, body: Body, actor: Actor, deps: Deps) {
  const now = Date.now();
  if (method === "GET" && (query.q || query.id?.startsWith("schedule:") || query.teacherId?.startsWith("schedule:")))
    return fail(400, "请使用表单提交查询");
  const routes = ["/teacher-options", "/teacher", "/lessons", "/random"];
  const search = method === "POST" && path.endsWith("/search") && routes.includes(path.slice(0, -7));
  const route = search ? path.slice(0, -7) : path;
  if (method === "GET" || search) {
    let input = query;
    if (search) {
      input = {};
      for (const [key, value] of Object.entries(body)) {
        if (
          !["id", "teacherId", "date", "grade", "subject", "q", "issues"].includes(key) ||
          typeof value !== "string" ||
          value.length > 160
        )
          return fail(400, "查询条件无效");
        input[key] = value;
      }
    }
    if (route === "/lessons") return lessons(input, now);
    if (route === "/lesson") return lesson(input, now);
    if (route === "/teachers") return teachers(now);
    if (route === "/teacher") return teacherDetail(input, now);
    if (route === "/teacher-options" && search) return options(input);
    if (route === "/random") {
      const [r] = await pg<{ id: string }>("POST", "rpc/fupan_random", "", { p_teacher: input.teacherId || null });
      return { id: r?.id ?? null };
    }
    if (path === "/audio") {
      const id = lessonId(query.id);
      const [row] = await pg<LessonDoc>(
        "GET",
        "classroom_lessons",
        `_id=${eq(id)}&or=(kind.is.null,kind.in.(lesson,adhoc))&startAt=gte.${PILOT}&select=_id,kind,startAt,mergedFileId,audioDeletedAt`,
      );
      if (!row) return fail(404, "没有找到这节试点课程");
      const { key, expiresIn } = audioKey(row, now);
      return { url: await deps.signedUrl(key, expiresIn), expiresIn };
    }
  }
  if (method === "POST" && path === "/teachers") return addTeacher(body, actor);
  return fail(404, "没有这个课堂复盘接口");
}
