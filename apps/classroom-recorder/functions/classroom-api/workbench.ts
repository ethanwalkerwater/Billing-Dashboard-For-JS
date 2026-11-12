/**
 * 菁仕工作台接口（/classroom-api/wb/*）：和后台共用飞书登录与会话（classroom_admin_sessions），按角色给数据。
 *   老师 = 老师档案对上的课表名，只看自己的课和「我的学员」（最近 90 天上过课或已排课）及这些学生的其他科；
 *   教务 = wb_roles；管理员 = ADMIN_OPEN_IDS + classroom_admins。教务和管理员能「以老师身份查看」（x-view-as-teacher）。
 * 课表和学员信息是飞书的快照（wb_cache），打开页面时按过期时间同步，不加定时器；一个月全部老师约 1700 条，存成一行紧凑数组。
 */
import { randomBytes } from "node:crypto";

import { CommonClient } from "tencentcloud-sdk-nodejs-common";

import type { ClassReport, LessonDoc } from "../../src/server/logic";
import * as W from "../../src/server/workbench";
import type { LessonRow, RosterStudent } from "../../src/server/workbench";
import {
  ADMIN_SESSIONS, chat, eq, fail, feishu, getObject, getRow, header, inList, isAdmin, json, jsonBody, pg, putObject, requireEnv, schedule, sha256, signedUrl,
} from "./index";

type HttpEvent = Parameters<typeof jsonBody>[0];
type Role = "teacher" | "staff" | "admin";
export interface WbUser { openId: string; name: string; role: Role; scheduleName: string; viewing?: Role }

const CACHE = "wb_cache";
const LESSONS = "classroom_lessons";
const ROSTER_KEY = "roster";
const RECENT_MS = 90 * W.DAY_MS;
const FILE_MAX = 2_000_000;

const rosterTable = () => ({ appToken: process.env.ROSTER_APP_TOKEN?.trim() || requireEnv("SCHEDULE_APP_TOKEN"), tableId: process.env.ROSTER_TABLE_ID?.trim() || "tblQGkH5DweXpOW8" });
const newId = () => randomBytes(8).toString("hex");
const staffOnly = (user: WbUser) => (user.role === "teacher" ? fail(403, "FORBIDDEN", "只有教务和管理员可以操作") : null);
const cleanText = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\r/g, "").trim().slice(0, max) : "");
const isDate = (value: unknown): value is string => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value);
const safeDecode = (value: string) => { try { return decodeURIComponent(value); } catch { return ""; } };
/** 附件目录：学员信息的编号直接用；课表里没关联学员的（n:名字）用 hash */
const folderOf = (id: string) => (/^rec\w+$/.test(id) ? id : `n-${sha256(id).slice(0, 12)}`);

// ---------- 登录 ----------

export async function authenticateWb(event: HttpEvent): Promise<WbUser | "RELOGIN" | undefined> {
  const token = header(event, "authorization").replace(/^Bearer\s+/i, "").trim();
  const session = token ? await getRow<{ openId: string; name: string; expiresAt: number; scheduleName?: string | null }>(ADMIN_SESSIONS, sha256(token)) : undefined;
  if (!session || session.expiresAt <= Date.now()) return undefined;
  const [admin, staff] = await Promise.all([isAdmin(session.openId), pg("GET", "wb_roles", `openId=${eq(session.openId)}&select=openId`)]);
  const role: Role = admin ? "admin" : staff.length ? "staff" : "teacher";
  // 工作台上线前登录的后台会话没有课表名：老师要重新登录一次
  if (role === "teacher" && !session.scheduleName) return "RELOGIN";
  const viewAs = decodeURIComponent(header(event, "x-view-as-teacher")).trim();
  if (role !== "teacher" && viewAs && viewAs.length <= 40) return { openId: session.openId, name: session.name, role: "teacher", scheduleName: viewAs, viewing: role };
  return { openId: session.openId, name: session.name, role, scheduleName: session.scheduleName ?? "" };
}

// ---------- 飞书快照 ----------

interface Cached<T> { h: string; rows: T[] }
type CacheRow<T> = { key: string; data: Cached<T>; syncedAt: number };
const hashOf = (rows: unknown) => sha256(JSON.stringify(rows)).slice(0, 16);

async function readCache<T>(keys: string[]): Promise<Map<string, CacheRow<T>>> {
  const rows = await pg<CacheRow<T>>("GET", CACHE, `key=${inList(keys)}&select=key,data,syncedAt`);
  return new Map(rows.map((row) => [row.key, row]));
}

/** 原子领取一次同步：过期的才领，领到的人去拉飞书，别人直接用旧快照。返回领取前的 hash */
async function claim(key: string, staleMs: number, now: number): Promise<{ h: string; before: number } | null> {
  await pg("POST", CACHE, "on_conflict=key", [{ key, data: { h: "", rows: [] }, syncedAt: 0 }], "resolution=ignore-duplicates,return=minimal");
  const [old] = await pg<{ h: string | null; syncedAt: number }>("GET", CACHE, `key=${eq(key)}&select=h:data->>h,syncedAt`);
  if (!old || old.syncedAt > now - staleMs) return null;
  const won = await pg("PATCH", CACHE, `key=${eq(key)}&syncedAt=eq.${old.syncedAt}&select=key`, { syncedAt: now });
  return won.length ? { h: old.h ?? "", before: old.syncedAt } : null;
}

async function syncOne(key: string, staleMs: number, now: number): Promise<boolean> {
  const won = await claim(key, staleMs, now);
  if (!won) return false;
  try {
    let rows: unknown[];
    if (key === ROSTER_KEY) {
      // list 接口的 field_names 要 JSON 数组，共用客户端是逐个传的，所以走 search
      rows = (await feishu().searchRecords({ ...rosterTable(), fieldNames: W.ROSTER_FIELDS, filter: { conjunction: "and", conditions: [] } })).map(W.parseRoster).filter((s) => s.name);
    } else {
      const month = key.slice(2);
      rows = (await feishu().searchRecords({ ...schedule(), fieldNames: W.LESSON_FIELDS, filter: W.monthFilter(month) }))
        .map(W.parseLesson)
        .filter((row): row is LessonRow => row !== null && W.monthOf(row[1]) === month)
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    }
    const h = hashOf(rows);
    if (h !== won.h) await pg("PATCH", CACHE, `key=${eq(key)}`, { data: { h, rows } }, "return=minimal");
    return h !== won.h;
  } catch (error) {
    await pg("PATCH", CACHE, `key=${eq(key)}`, { syncedAt: won.before }, "return=minimal"); // 拉失败：下次打开再试
    throw error;
  }
}

/** 同步过期的月份和学员信息；返回有没有变化（有变化网页再拉一次） */
async function sync(event: HttpEvent) {
  const body = jsonBody(event);
  const now = Date.now();
  const force = body.force === true;
  const months = Array.isArray(body.months) && body.months.every(W.isMonth) && body.months.length <= 6 ? (body.months as string[]) : W.windowMonths(now);
  const results = await Promise.all([
    ...months.map((m) => syncOne(`m:${m}`, W.staleAfter(m, now, force), now)),
    syncOne(ROSTER_KEY, force ? 60_000 : 30 * 60_000, now),
  ]);
  return json(200, { changed: results.some(Boolean), syncedAt: now });
}

// ---------- 课和学生 ----------

interface Ctx {
  user: WbUser; now: number; rows: LessonRow[]; roster: Map<string, RosterStudent>; mine: Set<string>; syncedAt: number; stale: boolean;
}

/** 课表里没关联学员信息的课，用标签里的名字当编号（n:名字） */
function normalize(row: LessonRow): LessonRow {
  return row[3].length || !row[4] ? row : [row[0], row[1], row[2], [`n:${row[4]}`], ...row.slice(4)] as LessonRow;
}

async function context(user: WbUser, months: string[]): Promise<Ctx> {
  const now = Date.now();
  const cache = await readCache<unknown>([...months.map((m) => `m:${m}`), ROSTER_KEY]);
  const rows = months.flatMap((m) => ((cache.get(`m:${m}`)?.data.rows ?? []) as LessonRow[]).map(normalize));
  const roster = new Map(((cache.get(ROSTER_KEY)?.data.rows ?? []) as RosterStudent[]).map((s) => [s.id, s]));
  const synced = months.map((m) => cache.get(`m:${m}`)?.syncedAt ?? 0);
  const stale = months.some((m, i) => synced[i] < now - W.staleAfter(m, now)) || (cache.get(ROSTER_KEY)?.syncedAt ?? 0) < now - 30 * 60_000;
  // 我的学员：最近 90 天给他上过课，或者已经排了课（开会、考试不算）
  const mine = new Set(rows.filter((r) => r[6] === user.scheduleName && r[2] >= now - RECENT_MS && W.isTeaching(r)).flatMap((r) => r[3]));
  return { user, now, rows, roster, mine, syncedAt: Math.min(...synced), stale };
}

const canSeeStudent = (ctx: Ctx, id: string) => ctx.user.role !== "teacher" || ctx.mine.has(id);
/** 写入前的权限：教务和管理员看全部，不用读课表快照；老师要是「我的学员」 */
async function allowed(user: WbUser, student: string) {
  return Boolean(student) && (user.role !== "teacher" || (await context(user, W.windowMonths(Date.now()))).mine.has(student));
}
const visibleRows = (ctx: Ctx) =>
  ctx.user.role === "teacher"
    ? ctx.rows.filter((r) => r[6] === ctx.user.scheduleName || r[3].some((id) => ctx.mine.has(id)))
    : ctx.rows.filter((r) => r[3].length); // 看全部老师时不带会议

/** 每节课的录课状态：g/a/r 有报告（掌握情况），p 整理中，空 = 没录 */
async function lessonStates(rows: LessonRow[]) {
  const states = new Map<string, string>();
  if (!rows.length) return states;
  const from = Math.min(...rows.map((r) => r[1])) - W.DAY_MS;
  const to = Math.max(...rows.map((r) => r[1])) + W.DAY_MS;
  const docs = await pg<Pick<LessonDoc, "_id" | "kind" | "stage" | "attempts" | "sources"> & { mastery?: ClassReport["mastery"] }>("GET", LESSONS,
    `kind=in.(lesson,merged)&startAt=gte.${from - 14 * W.DAY_MS}&startAt=lt.${to}&stage=neq.empty&select=_id,kind,stage,attempts,sources,mastery:report->mastery&limit=20000`);
  for (const doc of docs.sort((a, b) => Number(a.kind !== "merged") - Number(b.kind !== "merged"))) {
    const state = doc.stage === "done" ? W.masteryKey({ mastery: doc.mastery ?? [] }) : doc.stage === "failed" && doc.attempts >= 3 ? "" : "p";
    if (!state) continue;
    // 合并反馈的报告算到它合并的每一节上；单节自己的报告优先（排在后面覆盖）
    for (const id of doc.kind === "merged" ? doc.sources ?? [] : [doc._id]) states.set(id, state);
  }
  return states;
}

function studentOut(ctx: Ctx, id: string, saved?: { stage?: string | null; persona?: unknown; goals?: unknown; handover?: unknown }) {
  const r = ctx.roster.get(id);
  const recent = ctx.rows.some((row) => row[3].includes(id) && row[2] >= ctx.now - RECENT_MS && !row[9]);
  // 老师只看得到自己学员的资料；同一节班课里的其他学生只给名字
  if (r && !canSeeStudent(ctx, id)) return { id, name: r.name, stage: W.stageOf(r, saved?.stage, recent) };
  const base = r ? (ctx.user.role === "teacher" ? W.forTeacher(r) : r) : { id, name: id.startsWith("n:") ? id.slice(2) : "" };
  return { ...base, stage: W.stageOf(r, saved?.stage, recent), persona: saved?.persona ?? {}, goals: saved?.goals ?? { aim: "", rows: [] }, handover: saved?.handover ?? {} };
}

async function boot(user: WbUser) {
  const months = W.windowMonths(Date.now());
  const ctx = await context(user, months);
  const send = new Set(W.sendMonths(ctx.now));
  const visible = visibleRows(ctx);
  // 只发上个月到下个月；名单里这几个月没课的学生，带上他最近的一节，列表里才有课程那一行。
  // 老师只看自己的课：这几个月没有自己的课，就带上自己给他上的最近一节（别的老师的课不算）
  const teacher = user.role === "teacher";
  const own = (r: LessonRow) => !teacher || (r[6] === user.scheduleName && W.isTeaching(r));
  const rows = visible.filter((r) => send.has(W.monthOf(r[1])));
  const covered = new Set(rows.filter(own).flatMap((r) => r[3]));
  for (const r of [...visible].reverse()) if (own(r) && r[3].some((id) => !covered.has(id)) && r[2] >= ctx.now - RECENT_MS) { if (!send.has(W.monthOf(r[1]))) rows.push(r); r[3].forEach((id) => covered.add(id)); }
  const ids = teacher
    ? [...ctx.mine]
    : [...new Set([
      ...ctx.rows.filter((r) => r[2] >= ctx.now - RECENT_MS).flatMap((r) => r[3]),
      ...[...ctx.roster.values()].filter((s) => s.status === "在读").map((s) => s.id),
    ])];
  const all = new Set([...ids, ...rows.flatMap((r) => r[3])]);
  const studentFilter = teacher ? `&student=${inList([...ctx.mine])}` : "";
  const [states, saved, config, marks, todos, grades, staff] = await Promise.all([
    lessonStates(rows),
    pg<{ _id: string; stage: string | null; persona: unknown; goals: unknown; handover: unknown }>("GET", "wb_students", "select=_id,stage,persona,goals,handover&limit=5000"),
    pg<{ key: string; value: unknown }>("GET", "wb_config", `key=eq.fields&select=key,value`),
    teacher ? [] : pg<{ month: string; student: string; course: string; field: string; value: string }>("GET", "wb_marks", // 标记和备注只给教务看
      `month=${inList([...send])}&select=month,student,course,field,value&limit=20000${studentFilter}`),
    teacher ? [] : pg("GET", "wb_todos", `or=(done.eq.false,doneAt.gt.${ctx.now - 30 * W.DAY_MS})&select=*&order=createdAt.desc&limit=2000`),
    teacher && !ctx.mine.size ? [] : pg("GET", "wb_grades", `select=_id,student,date,exam,subject,score,file,by,createdAt&order=date.desc&limit=5000${studentFilter}`),
    teacher ? [] : pg<{ name: string }>("GET", "wb_roles", "select=name"),
  ]);
  const savedMap = new Map(saved.map((s) => [s._id, s]));
  if (!teacher) for (const s of saved) { ids.push(s._id); all.add(s._id); }
  const vals: Record<string, Record<string, Record<string, string>>> = {};
  for (const m of marks) ((vals[m.month] ??= {})[`${m.student}~${m.course}`] ??= {})[m.field] = m.value;
  return json(200, {
    me: { name: user.name, role: user.role, scheduleName: user.scheduleName, viewing: user.viewing ?? null },
    now: ctx.now, months: [...send], syncedAt: ctx.syncedAt, stale: ctx.stale,
    fields: config[0]?.value ?? W.DEFAULT_FIELDS,
    lessons: W.encodeLessons(rows.sort((a, b) => a[1] - b[1]), states),
    students: Object.fromEntries([...all].map((id) => [id, studentOut(ctx, id, savedMap.get(id))])),
    list: [...new Set(ids)].filter((id) => all.has(id)),
    vals, todos, grades, staff: staff.map((s) => s.name),
    teachers: user.role === "teacher" && !user.viewing ? [] : [...new Set(ctx.rows.filter((r) => r[3].length && r[6]).map((r) => r[6]))].sort(),
  });
}

/** 月历翻到窗口外的月份：没同步过就先同步 */
async function monthLessons(user: WbUser, month: string) {
  const now = Date.now();
  await syncOne(`m:${month}`, W.staleAfter(month, now), now).catch((error) => console.error("[wb] 同步课表失败", error));
  const ctx = await context(user, [...new Set([...W.windowMonths(now), month])]);
  const rows = visibleRows(ctx).filter((r) => W.monthOf(r[1]) === month);
  const states = await lessonStates(rows);
  return json(200, {
    lessons: W.encodeLessons(rows, states),
    students: Object.fromEntries([...new Set(rows.flatMap((r) => r[3]))].map((id) => [id, studentOut(ctx, id)])),
  });
}

/** 一个学生在窗口里的全部课（含合并反馈）的学情报告 */
async function studentReports(ctx: Ctx, id: string) {
  const rows = ctx.rows.filter((r) => r[3].includes(id));
  const ids = rows.map((r) => r[0]);
  if (!ids.length) return { rows, docs: new Map<string, { report: ClassReport; text: string; url: string | null }>() };
  const from = Math.min(...rows.map((r) => r[1]));
  const select = "_id,kind,sources,report,summary,editedSummary,reportToken";
  const [own, merged] = await Promise.all([
    pg<LessonDoc>("GET", LESSONS, `_id=${inList(ids)}&stage=eq.done&select=${select}`),
    pg<LessonDoc>("GET", LESSONS, `kind=eq.merged&stage=eq.done&startAt=gte.${from}&select=${select}`),
  ]);
  const base = requireEnv("REPORT_BASE_URL");
  const docs = new Map<string, { report: ClassReport; text: string; url: string | null }>();
  for (const doc of [...merged.filter((d) => d.sources?.some((s) => ids.includes(s))), ...own]) {
    if (!doc.report || !("mastery" in doc.report)) continue;
    const value = { report: doc.report as ClassReport, text: doc.editedSummary || doc.summary || "", url: doc.reportToken ? `${base}?t=${doc.reportToken}` : null };
    for (const lessonId of doc.kind === "merged" ? doc.sources ?? [] : [doc._id]) if (ids.includes(lessonId)) docs.set(lessonId, value);
  }
  return { rows, docs };
}

async function profile(user: WbUser, id: string) {
  const ctx = await context(user, W.windowMonths(Date.now()));
  if (!canSeeStudent(ctx, id)) return fail(404, "NOT_FOUND", "没有找到这个学生，或者他不是你的学员");
  const [{ rows, docs }, monthly, miles, sugg, saved, marks] = await Promise.all([
    studentReports(ctx, id),
    pg("GET", "wb_monthly", `student=${eq(id)}&select=course,month,rep,basis,editedBy,updatedAt`),
    pg("GET", "wb_milestones", `student=${eq(id)}&select=*&order=date.desc`),
    pg("GET", "wb_suggestions", `student=${eq(id)}&status=eq.open&select=_id,key,tag,why,createdAt`),
    pg<{ suggestBasis: string | null }>("GET", "wb_students", `_id=${eq(id)}&select=suggestBasis`),
    ctx.user.role === "teacher" ? [] : pg<{ month: string; course: string; field: string; value: string }>("GET", "wb_marks", `student=${eq(id)}&select=month,course,field,value`),
  ]);
  const states = await lessonStates(rows);
  const reps = Object.fromEntries([...docs].map(([lessonId, d]) => [lessonId, { ...W.repOf(d.report), sum: d.text, url: d.url }]));
  const reportIds = [...docs.keys()];
  return json(200, {
    reps, monthly, miles, sugg, marks,
    lessons: W.encodeLessons(rows, states),
    students: Object.fromEntries([...new Set(rows.flatMap((r) => r[3]))].map((s) => [s, studentOut(ctx, s)])),
    needSuggest: reportIds.length >= 2 && W.suggestBasis(reportIds) !== (saved[0]?.suggestBasis ?? ""),
  });
}

// ---------- 学生档案的写入 ----------

function readPersona(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, { tags: string[]; text: string; src: string }> = {};
  for (const key of W.PKEYS) {
    const v = (value as Record<string, any>)[key];
    if (!v) continue;
    const tags = Array.isArray(v.tags) ? v.tags.filter((t: unknown) => typeof t === "string" && t.trim()).map((t: string) => t.trim().slice(0, 20)).slice(0, 12) : [];
    const text = cleanText(v.text, 300);
    if (tags.length || text) out[key] = { tags, text, src: cleanText(v.src, 60) };
  }
  return out;
}
function readGoals(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const v = value as { aim?: unknown; rows?: unknown };
  const rows = (Array.isArray(v.rows) ? v.rows : []).flatMap((r: any) => {
    const row = { sub: cleanText(r?.sub, 40), target: cleanText(r?.target, 20), exam: cleanText(r?.exam, 30), date: cleanText(r?.date, 20) };
    return row.sub && row.target ? [row] : [];
  }).slice(0, 12);
  return { aim: cleanText(v.aim, 80), rows };
}

async function saveStudent(user: WbUser, id: string, event: HttpEvent) {
  const body = jsonBody(event);
  if (!(await allowed(user, id))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const patch: Record<string, unknown> = { _id: id, updatedAt: Date.now(), updatedBy: user.name };
  if (body.stage !== undefined) {
    if (user.role === "teacher") return fail(403, "FORBIDDEN", "阶段由教务改");
    if (!(W.STAGES as readonly string[]).includes(body.stage)) return fail(400, "BAD_BODY", "阶段不对");
    patch.stage = body.stage;
  }
  if (body.persona !== undefined) patch.persona = readPersona(body.persona) ?? {};
  if (body.goals !== undefined) patch.goals = readGoals(body.goals) ?? { aim: "", rows: [] };
  await pg("POST", "wb_students", "on_conflict=_id", [patch], "resolution=merge-duplicates,return=minimal");
  return json(200, { ok: true });
}

/** 新建学员：基本信息写进飞书学员信息表（名单只认飞书），画像和目标存工作台 */
async function createStudent(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  const name = cleanText(body.name, 40);
  if (!name) return fail(400, "BAD_BODY", "要填姓名");
  const record = await feishu().createRecord({
    ...rosterTable(),
    fields: W.rosterFields({ name, school: cleanText(body.school, 60), grade: cleanText(body.grade, 20), system: cleanText(body.system, 10), parent: cleanText(body.parent, 80), channel: cleanText(body.channel, 40) }),
  });
  const stage = (W.STAGES as readonly string[]).includes(body.stage) ? body.stage : "咨询";
  await pg("POST", "wb_students", "on_conflict=_id", [{
    _id: record.record_id, stage, persona: readPersona(body.persona) ?? {}, goals: readGoals(body.goals) ?? { aim: "", rows: [] }, updatedAt: Date.now(), updatedBy: user.name,
  }], "resolution=merge-duplicates,return=minimal");
  await pg("PATCH", CACHE, `key=${eq(ROSTER_KEY)}`, { syncedAt: 0 }, "return=minimal"); // 下次打开就把新学员拉进快照
  return json(200, { id: record.record_id, student: { ...W.parseRoster(record), stage, persona: {}, goals: { aim: "", rows: [] } } });
}

async function saveMarks(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  if (!W.isMonth(body.month) || !Array.isArray(body.items) || body.items.length > 2000) return fail(400, "BAD_BODY", "参数不对");
  const now = Date.now();
  const items = (body.items as any[]).map((x) => ({ student: cleanText(x?.student, 40), course: cleanText(x?.course, 60), field: cleanText(x?.field, 40), value: cleanText(x?.value, 300) }))
    .filter((x) => x.student && x.course && x.field);
  const set = items.filter((x) => x.value).map((x) => ({ month: body.month, ...x, updatedAt: now, updatedBy: user.name }));
  if (set.length) await pg("POST", "wb_marks", "on_conflict=month,student,course,field", set, "resolution=merge-duplicates,return=minimal");
  for (const x of items.filter((i) => !i.value)) {
    await pg("DELETE", "wb_marks", `month=${eq(body.month)}&student=${eq(x.student)}&course=${eq(x.course)}&field=${eq(x.field)}`, undefined, "return=minimal");
  }
  return json(200, { ok: true });
}

async function saveFields(user: WbUser, event: HttpEvent) {
  const fields = jsonBody(event).fields;
  const ok = Array.isArray(fields) && fields.length <= 12 && fields.every((f: any) =>
    f && typeof f.id === "string" && /^[\w-]{1,40}$/.test(f.id) && typeof f.name === "string" && f.name.trim() && f.name.length <= 20 && ["select", "text", "date"].includes(f.type) &&
    (f.type !== "select" || (Array.isArray(f.options) && f.options.length <= 20 && f.options.every((o: any) => Array.isArray(o) && typeof o[0] === "string" && o[0].trim() && o[0].length <= 20 && ["sec", "good", "warn", "bad", "info"].includes(o[1])))));
  if (!ok) return fail(400, "BAD_BODY", "列设置不对");
  await pg("POST", "wb_config", "on_conflict=key", [{ key: "fields", value: fields, updatedAt: Date.now(), updatedBy: user.name }], "resolution=merge-duplicates,return=minimal");
  return json(200, { ok: true });
}

// ---------- 月报 ----------

async function monthInput(ctx: Ctx, student: string, course: string, month: string) {
  const { rows, docs } = await studentReports(ctx, student);
  const inMonth = rows.filter((r) => r[5] === course && W.monthOf(r[1]) === month);
  const lessons = inMonth.filter((r) => docs.has(r[0])).map((r) => ({ id: r[0], date: W.md(r[1]), report: docs.get(r[0])!.report, teacher: r[6] }));
  return { lessons, total: inMonth.filter((r) => !r[9] && r[1] < Date.now()).length, cancelled: inMonth.filter((r) => r[9]).length };
}

async function generateMonthly(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  const student = cleanText(body.student, 40), course = cleanText(body.course, 60), month = body.month;
  if (!student || !course || !W.isMonth(month)) return fail(400, "BAD_BODY", "参数不对");
  const ctx = await context(user, [...new Set([...W.windowMonths(Date.now()), month])]);
  if (!canSeeStudent(ctx, student)) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const input = await monthInput(ctx, student, course, month);
  if (!input.lessons.length) return fail(400, "NO_REPORTS", "这个月的课都没录，生成不了月报");
  const basis = W.basisOf(input.lessons.map((l) => l.id));
  const [old] = await pg<{ basis: string; editedBy: string | null }>("GET", "wb_monthly", `student=${eq(student)}&course=${eq(course)}&month=${eq(month)}&select=basis,editedBy,rep,updatedAt`);
  if (old && body.force !== true && (old.basis === basis || old.editedBy)) return json(200, old);
  const name = ctx.roster.get(student)?.name ?? student.replace(/^n:/, "");
  const prompt = W.monthPrompt({ student: name, course, month, lessons: input.lessons, total: input.total, cancelled: input.cancelled });
  const rep = W.parseMonthRep(await chat([{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], true, 800), prompt);
  const row = { student, course, month, rep, basis, editedBy: null, updatedAt: Date.now() };
  await pg("POST", "wb_monthly", "on_conflict=student,course,month", [row], "resolution=merge-duplicates,return=minimal");
  return json(200, row);
}

async function editMonthly(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  const student = cleanText(body.student, 40), course = cleanText(body.course, 60), month = body.month;
  const rep = body.rep ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 8) : []);
  const clean = { sum: cleanText(rep.sum, 400), good: list(rep.good), weak: list(rep.weak), adv: cleanText(rep.adv, 300) };
  if (!student || !course || !W.isMonth(month) || !clean.sum) return fail(400, "BAD_BODY", "月报不能为空");
  const ctx = await context(user, [...new Set([...W.windowMonths(Date.now()), month])]);
  if (!canSeeStudent(ctx, student)) return fail(404, "NOT_FOUND", "没有找到这个学生");
  if (user.role === "teacher" && !ctx.rows.some((r) => r[3].includes(student) && r[5] === course && r[6] === user.scheduleName)) return fail(403, "FORBIDDEN", "老师只能改自己那门课的月报");
  const [old] = await pg<{ basis: string }>("GET", "wb_monthly", `student=${eq(student)}&course=${eq(course)}&month=${eq(month)}&select=basis`);
  await pg("POST", "wb_monthly", "on_conflict=student,course,month", [{ student, course, month, rep: clean, basis: old?.basis ?? "", editedBy: user.name, updatedAt: Date.now() }], "resolution=merge-duplicates,return=minimal");
  return json(200, { ok: true, editedBy: user.name });
}

// ---------- 里程碑、成绩、附件、跟进 ----------

const readFile = (f: any) => (f && typeof f.key === "string" && f.key.startsWith("wb/") ? { key: f.key.slice(0, 200), name: cleanText(f.name, 80), img: Boolean(f.img) } : null);

async function addMile(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  const student = cleanText(body.student, 40), title = cleanText(body.title, 60);
  if (!student || !title || !isDate(body.date)) return fail(400, "BAD_BODY", "标题和日期要填");
  if (!(await allowed(user, student))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const files = (Array.isArray(body.files) ? body.files : []).map(readFile).filter(Boolean).slice(0, 10);
  const row = { _id: newId(), student, date: body.date, course: cleanText(body.course, 60), title, text: cleanText(body.text, 500), files, by: user.name, createdAt: Date.now() };
  await pg("POST", "wb_milestones", "", [row], "return=minimal");
  return json(200, row);
}

/** 同一场考试（日期、考试、科目）只记一次，老师和教务重复传的跳过 */
async function addGrades(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  const student = cleanText(body.student, 40);
  if (!(await allowed(user, student))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 20)
    .map((x: any) => ({ date: x?.date, exam: cleanText(x?.exam, 40), subject: cleanText(x?.subject, 60), score: cleanText(x?.score, 20) }))
    .filter((x: any) => isDate(x.date) && x.exam && x.subject && x.score);
  if (!items.length) return fail(400, "BAD_BODY", "考试和成绩要填");
  const existing = await pg<{ date: string; exam: string; subject: string }>("GET", "wb_grades", `student=${eq(student)}&select=date,exam,subject`);
  const fresh = items.filter((x: any) => !existing.some((g) => g.date === x.date && g.exam === x.exam && g.subject === x.subject));
  const file = readFile(body.file);
  const rows = fresh.map((x: any) => ({ _id: newId(), student, ...x, file, by: user.name, createdAt: Date.now() }));
  if (rows.length) await pg("POST", "wb_grades", "", rows, "return=minimal");
  return json(200, { rows, skipped: items.length - fresh.length });
}

/** 附件存 classroom 桶 wb/{学生}/{随机}/{文件名}；单个不超过 2 MB（图片在网页上先压缩） */
async function upload(user: WbUser, event: HttpEvent, query: Record<string, string>) {
  const student = cleanText(query.student, 40);
  if (!(await allowed(user, student))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const bytes = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "latin1");
  if (!bytes.length || bytes.length > FILE_MAX) return fail(400, "TOO_LARGE", "文件超过 2 MB，请压缩后再传");
  const name = (cleanText(query.name, 80) || "file").replace(/[\\/:*?"<>|#%\s]/g, "_");
  const key = `wb/${folderOf(student)}/${newId()}/${name}`;
  await putObject(key, bytes, header(event, "content-type") || "application/octet-stream");
  return json(200, { key, name });
}

async function fileUrl(user: WbUser, key: string) {
  const m = key.match(/^wb\/([\w-]+)\/[0-9a-f]{16}\/[^/]+$/);
  if (!m) return fail(400, "BAD_KEY", "文件不存在");
  if (user.role === "teacher") {
    const ctx = await context(user, W.windowMonths(Date.now()));
    if (![...ctx.mine].some((id) => folderOf(id) === m[1])) return fail(404, "NOT_FOUND", "没有权限看这个文件");
  }
  return json(200, { url: await signedUrl(key, 600) });
}

async function addTodos(user: WbUser, event: HttpEvent) {
  const items = jsonBody(event).items;
  if (!Array.isArray(items) || !items.length || items.length > 300) return fail(400, "BAD_BODY", "参数不对");
  const rows = items.map((x: any) => ({ _id: newId(), student: cleanText(x?.student, 40), text: cleanText(x?.text, 200), owner: cleanText(x?.owner, 40) || user.name, due: x?.due, done: false, by: user.name, createdAt: Date.now() }))
    .filter((x) => x.student && x.text && isDate(x.due));
  if (!rows.length) return fail(400, "BAD_BODY", "跟进内容和截止日期要填");
  await pg("POST", "wb_todos", "", rows, "return=minimal");
  return json(200, { rows });
}

async function setTodo(user: WbUser, id: string, event: HttpEvent) {
  const body = jsonBody(event);
  const done = body.done === true;
  await pg("PATCH", "wb_todos", `_id=${eq(id)}`, { done, result: done ? cleanText(body.result, 200) || "已完成" : null, doneAt: done ? Date.now() : null }, "return=minimal");
  return json(200, { ok: true });
}

// ---------- 成绩单识别 ----------

let ocrClient: CommonClient | undefined;
const ocr = () => (ocrClient ??= new CommonClient("ocr.tencentcloudapi.com", "2018-11-19", {
  credential: { secretId: requireEnv("TENCENT_SECRET_ID"), secretKey: requireEnv("TENCENT_SECRET_KEY") }, region: "ap-shanghai",
}));

/** 已上传的成绩单（图片或 PDF 第一页）→ 腾讯云通用文字识别 → 大模型整理成行；只返回给网页确认，不直接存 */
async function scanGrades(user: WbUser, event: HttpEvent) {
  const body = jsonBody(event);
  const student = cleanText(body.student, 40), key = cleanText(body.key, 200);
  if (!(await allowed(user, student)) || !key.startsWith(`wb/${folderOf(student)}/`)) return fail(404, "NOT_FOUND", "没有找到这个文件");
  const bytes = await getObject(key);
  let text = "";
  try {
    const res = await ocr().request("GeneralBasicOCR", { ImageBase64: bytes.toString("base64"), ...(/\.pdf$/i.test(key) ? { IsPdf: true, PdfPageNumber: 1 } : {}) }) as { TextDetections?: Array<{ DetectedText?: string }> };
    text = (res.TextDetections ?? []).map((t) => t.DetectedText ?? "").filter(Boolean).join("\n");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    console.error("[wb] 文字识别失败", code, (error as Error).message);
    if (code.includes("UnOpenError")) return fail(503, "OCR_OFF", "腾讯云文字识别还没开通，先手动填写；原件照样保存");
    if (code.includes("ImageNoText") || code.includes("ImageDecodeFailed")) return fail(422, "NO_TEXT", "这张图里没认出文字，先手动填写");
    return fail(502, "OCR_FAILED", "识别没成功，先手动填写；原件照样保存");
  }
  if (!text.trim()) return fail(422, "NO_TEXT", "这张图里没认出文字，先手动填写");
  const subjects = Array.isArray(body.subjects) ? body.subjects.map((x: unknown) => cleanText(x, 60)).filter(Boolean).slice(0, 20) : [];
  const prompt = W.gradePrompt(text, subjects, new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10));
  const rows = W.parseGradeRows(await chat([{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], true, 1200));
  return json(200, { rows });
}

// ---------- 交接卡 ----------

/** 换老师后，新老师确认看过交接卡（目标、画像、上一位老师最后几节的学情）；没确认前教务的跟进里有一条提醒 */
async function confirmHandover(user: WbUser, id: string, event: HttpEvent) {
  const body = jsonBody(event);
  const course = cleanText(body.course, 60);
  if (!course || !(await allowed(user, id))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  // 老师确认记自己的课表名；教务替老师确认时记那位老师
  const teacher = user.role === "teacher" ? user.scheduleName : cleanText(body.teacher, 40) || user.name;
  const [saved] = await pg<{ handover: Record<string, unknown> }>("GET", "wb_students", `_id=${eq(id)}&select=handover`);
  const handover = { ...(saved?.handover ?? {}), [course]: { teacher, by: user.name, at: Date.now() } };
  await pg("POST", "wb_students", "on_conflict=_id", [{ _id: id, handover, updatedAt: Date.now(), updatedBy: user.name }], "resolution=merge-duplicates,return=minimal");
  return json(200, { handover });
}

// ---------- 家长收集表（不用登录，凭链接里的随机 token） ----------

async function formLink(user: WbUser, id: string) {
  if (!(await allowed(user, id))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const [saved] = await pg<{ formToken: string | null }>("GET", "wb_students", `_id=${eq(id)}&select=formToken`);
  let token = saved?.formToken;
  if (!token) {
    token = randomBytes(18).toString("base64url");
    await pg("POST", "wb_students", "on_conflict=_id", [{ _id: id, formToken: token, updatedAt: Date.now(), updatedBy: user.name }], "resolution=merge-duplicates,return=minimal");
  }
  return json(200, { url: `${requireEnv("REPORT_BASE_URL").replace(/report\.html$/, "workbench/form.html")}?t=${token}` });
}

export async function formRoute(method: string, event: HttpEvent, query: Record<string, string>) {
  const token = query.t ?? "";
  if (!/^[\w-]{24}$/.test(token)) return fail(404, "NOT_FOUND", "链接不对，请向老师要一个新的");
  const [saved] = await pg<{ _id: string; persona: Record<string, any> }>("GET", "wb_students", `formToken=${eq(token)}&select=_id,persona`);
  if (!saved) return fail(404, "NOT_FOUND", "链接不对，请向老师要一个新的");
  const roster = (await readCache<RosterStudent>([ROSTER_KEY])).get(ROSTER_KEY)?.data.rows.find((s) => s.id === saved._id);
  if (method === "GET") {
    return json(200, { name: roster?.name ?? saved._id.replace(/^n:/, ""), keys: W.FORM_KEYS.map((k) => ({ key: k, ask: W.PRESET[k].ask, tags: W.PRESET[k].tags })) });
  }
  if (method !== "POST") return fail(405, "METHOD", "不支持");
  const body = jsonBody(event);
  const who = cleanText(body.who, 10) || "家长";
  const persona = W.mergeForm(saved.persona ?? {}, body.blocks, `${who}填的收集表 ${W.md(Date.now())}`);
  await pg("PATCH", "wb_students", `_id=${eq(saved._id)}`, { persona, updatedAt: Date.now(), updatedBy: `${who}（收集表）` }, "return=minimal");
  return json(200, { ok: true });
}

// ---------- 画像建议 ----------

async function suggest(user: WbUser, event: HttpEvent) {
  const student = cleanText(jsonBody(event).student, 40);
  const ctx = await context(user, W.windowMonths(Date.now()));
  if (!student || !canSeeStudent(ctx, student)) return fail(404, "NOT_FOUND", "没有找到这个学生");
  const { rows, docs } = await studentReports(ctx, student);
  const ids = [...docs.keys()];
  const [saved] = await pg<{ persona: Record<string, { tags: string[] }>; suggestBasis: string | null }>("GET", "wb_students", `_id=${eq(student)}&select=persona,suggestBasis`);
  const basis = W.suggestBasis(ids);
  const open = () => pg("GET", "wb_suggestions", `student=${eq(student)}&status=eq.open&select=_id,key,tag,why,createdAt`);
  if (ids.length < 2 || saved?.suggestBasis === basis) return json(200, { items: await open() });
  const past = await pg<{ key: string; tag: string }>("GET", "wb_suggestions", `student=${eq(student)}&or=(status.eq.open,decidedAt.gt.${Date.now() - 30 * W.DAY_MS})&select=key,tag`);
  const lessons = rows.filter((r) => docs.has(r[0])).slice(-8).map((r) => ({ date: W.md(r[1]), course: r[5], report: docs.get(r[0])!.report }));
  const input = { lessons, persona: saved?.persona ?? {}, ignored: past };
  const prompt = W.suggestPrompt(input);
  const items = W.parseSuggestions(await chat([{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], true, 600), input);
  if (items.length) await pg("POST", "wb_suggestions", "", items.map((x) => ({ _id: newId(), student, ...x, status: "open", createdAt: Date.now() })), "return=minimal");
  await pg("POST", "wb_students", "on_conflict=_id", [{ _id: student, suggestBasis: basis, updatedAt: Date.now(), updatedBy: "AI" }], "resolution=merge-duplicates,return=minimal");
  return json(200, { items: await open() });
}

async function decide(user: WbUser, id: string, event: HttpEvent) {
  const accept = jsonBody(event).action === "accept";
  const [s] = await pg<{ student: string; key: string; tag: string; status: string }>("GET", "wb_suggestions", `_id=${eq(id)}&select=student,key,tag,status`);
  if (!s || s.status !== "open") return fail(404, "NOT_FOUND", "这条建议已经处理过了");
  if (!(await allowed(user, s.student))) return fail(404, "NOT_FOUND", "没有找到这个学生");
  if (accept) {
    const [saved] = await pg<{ persona: Record<string, { tags: string[]; text: string; src: string }> }>("GET", "wb_students", `_id=${eq(s.student)}&select=persona`);
    const persona = saved?.persona ?? {};
    const v = persona[s.key] ?? { tags: [], text: "", src: "" };
    persona[s.key] = { ...v, tags: [...new Set([...v.tags, s.tag])], src: `AI 建议，${user.name}确认 ${W.md(Date.now())}` };
    await pg("POST", "wb_students", "on_conflict=_id", [{ _id: s.student, persona, updatedAt: Date.now(), updatedBy: user.name }], "resolution=merge-duplicates,return=minimal");
  }
  await pg("PATCH", "wb_suggestions", `_id=${eq(id)}`, { status: accept ? "accepted" : "ignored", decidedBy: user.name, decidedAt: Date.now() }, "return=minimal");
  return json(200, { ok: true });
}

// ---------- 教务名单（只给管理员） ----------

async function roles() {
  const [staff, app, web, tried] = await Promise.all([
    pg("GET", "wb_roles", "select=openId,name,addedBy,addedAt&order=addedAt.asc"),
    pg<{ openId: string; name: string }>("GET", "classroom_sessions", "select=openId,name&limit=5000"),
    pg<{ openId: string; name: string }>("GET", ADMIN_SESSIONS, "select=openId,name&limit=5000"),
    pg<{ openId: string; name: string }>("GET", "wb_people", "select=openId,name&order=triedAt.desc&limit=200"),
  ]);
  const people = new Map([...tried, ...web, ...app].map((p) => [p.openId, p.name]));
  return json(200, { staff, people: [...people].map(([openId, name]) => ({ openId, name })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")) });
}

async function setRole(method: string, openId: string, event: HttpEvent, user: WbUser) {
  if (method === "DELETE") {
    await pg("DELETE", "wb_roles", `openId=${eq(openId)}`, undefined, "return=minimal");
    return json(200, { ok: true });
  }
  const name = cleanText(jsonBody(event).name, 40);
  if (!name) return fail(400, "BAD_BODY", "缺少名字");
  await pg("POST", "wb_roles", "on_conflict=openId", [{ openId, name, role: "staff", addedBy: user.name, addedAt: Date.now() }], "resolution=merge-duplicates,return=minimal");
  return json(200, { ok: true });
}

// ---------- 路由 ----------

export async function workbenchRoute(method: string, path: string, event: HttpEvent, query: Record<string, string>) {
  const started = Date.now();
  const res = await route(method, path, event, query);
  // 函数里实际花的时间，看资源消耗用
  return { ...res, headers: { ...res.headers, "x-wb-ms": String(Date.now() - started) } };
}

async function route(method: string, path: string, event: HttpEvent, query: Record<string, string>) {
  const user = await authenticateWb(event);
  if (user === "RELOGIN") return fail(401, "RELOGIN", "请重新用飞书登录一次");
  if (!user) return fail(401, "UNAUTHORIZED", "登录已失效，请重新用飞书登录");
  if (method === "GET" && path === "/wb/boot") return boot(user);
  if (method === "POST" && path === "/wb/sync") return sync(event);
  if (method === "GET" && path === "/wb/lessons" && W.isMonth(query.month)) return monthLessons(user, query.month);
  if (method === "POST" && path === "/wb/monthly") return generateMonthly(user, event);
  if (method === "PUT" && path === "/wb/monthly") return editMonthly(user, event);
  if (method === "POST" && path === "/wb/miles") return addMile(user, event);
  if (method === "POST" && path === "/wb/grades") return addGrades(user, event);
  if (method === "POST" && path === "/wb/upload") return upload(user, event, query);
  if (method === "GET" && path === "/wb/file") return fileUrl(user, query.key ?? "");
  if (method === "POST" && path === "/wb/suggest") return suggest(user, event);
  let m = path.match(/^\/wb\/sugg\/([0-9a-f]{16})$/);
  if (m && method === "PATCH") return decide(user, m[1], event);
  m = path.match(/^\/wb\/students\/([^/]{1,200})$/);
  const sid = m ? safeDecode(m[1]) : "";
  if (/^(rec\w{4,30}|n:[^/]{1,40})$/.test(sid) && method === "GET") return profile(user, sid);
  if (/^(rec\w{4,30}|n:[^/]{1,40})$/.test(sid) && method === "PUT") return saveStudent(user, sid, event);
  m = path.match(/^\/wb\/students\/([^/]{1,200})\/(form|handover)$/);
  const sub = m ? safeDecode(m[1]) : "";
  if (m && method === "POST" && /^(rec\w{4,30}|n:[^/]{1,40})$/.test(sub)) return m[2] === "form" ? formLink(user, sub) : confirmHandover(user, sub, event);
  if (method === "POST" && path === "/wb/grades/scan") return scanGrades(user, event);
  // 以下只给教务和管理员
  const deny = staffOnly(user);
  if (deny) return deny;
  if (method === "POST" && path === "/wb/students") return createStudent(user, event);
  if (method === "PUT" && path === "/wb/marks") return saveMarks(user, event);
  if (method === "PUT" && path === "/wb/fields") return saveFields(user, event);
  if (method === "POST" && path === "/wb/todos") return addTodos(user, event);
  m = path.match(/^\/wb\/todos\/([0-9a-f]{16})$/);
  if (m && method === "PATCH") return setTodo(user, m[1], event);
  if (user.role !== "admin") return fail(403, "FORBIDDEN", "只有管理员可以操作");
  if (method === "GET" && path === "/wb/roles") return roles();
  m = path.match(/^\/wb\/roles\/(ou_[A-Za-z0-9_-]{8,64})$/);
  if (m && (method === "PUT" || method === "DELETE")) return setRole(method, m[1], event, user);
  return fail(404, "NOT_FOUND", "接口不存在");
}
