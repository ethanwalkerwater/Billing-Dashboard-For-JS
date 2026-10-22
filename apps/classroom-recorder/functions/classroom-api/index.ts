/**
 * classroom-api —— 菁仕课堂云端（HTTP 访问服务路径 /classroom-api，定时触发 every-minute 推进处理流水线）。
 * 接口与数据结构见 docs/design.md；纯逻辑在 src/server/logic.ts。
 *
 *   定时触发（每分钟）                             runPipeline
 *   tcb fn invoke {"action":"tick"}                 手动推进一次
 *   tcb fn invoke {"action":"tick","lessonId":"rec…"} 只推进某节课
 */
import { createHash, randomBytes } from "node:crypto";

import { asr } from "tencentcloud-sdk-nodejs-asr";

import { FeishuClient } from "../../../course-feedback-tracker/src/server/feishu/client";
import { parseTeacher, TEACHER_FIELDS } from "../../../teacher-birthday/src/domain/records";
import * as L from "../../src/server/logic";
import type { LessonDoc, Stage } from "../../src/server/logic";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const AUTH = "classroom_auth";
const SESSIONS = "classroom_sessions";
const LESSONS = "classroom_lessons";
const SEGMENTS = "classroom_segments";
const PROMPTS = "classroom_prompts";
const ADMIN_SESSIONS = "classroom_admin_sessions";

/**
 * CloudBase PostgreSQL（PostgREST）。环境没开文档型数据库；表结构见 migrations/。
 * 用环境 API Key（service_role）直连，同 course-feedback-tracker/functions/feedback-api/service-db.ts 的做法；
 * 这里需要 lt / 条件更新 / 条件删除，直接拼查询串比扩那个只支持 eq/in 的客户端省事。
 */
async function pg<T = any>(method: string, table: string, query = "", body?: unknown, prefer = "return=representation"): Promise<T[]> {
  const response = await fetch(`https://${requireEnv("CLOUDBASE_ENV_ID")}.api.tcloudbasegateway.com/v1/rdb/rest/${table}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      authorization: `Bearer ${requireEnv("CLOUDBASE_API_KEY")}`, "content-type": "application/json", accept: "application/json",
      "accept-profile": "public", "content-profile": "public", prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`数据库 ${method} ${table} 失败：${response.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T[]) : [];
}
/**
 * 录音存 PostgreSQL 环境的 Storage 桶 `classroom`（node-sdk 的 uploadFile 在 PG 环境报 STORAGE_NOT_SUPPORTED），
 * 接口同 tcb CLI 的 `storage objects`：/v1/storages/object/…，同样用 API Key 鉴权。对象名 = `{lessonId}/{文件}`。
 */
const STORAGE = () => `https://${requireEnv("CLOUDBASE_ENV_ID")}.api.tcloudbasegateway.com/v1/storages`;
const BUCKET = "classroom";
const storageAuth = () => ({ authorization: `Bearer ${requireEnv("CLOUDBASE_API_KEY")}` });
async function putObject(name: string, bytes: Buffer, contentType = "audio/mpeg"): Promise<string> {
  const response = await fetch(`${STORAGE()}/object/${BUCKET}/${name}`, { method: "PUT", headers: { ...storageAuth(), "content-type": contentType }, body: new Uint8Array(bytes) });
  if (!response.ok) throw new Error(`存储录音失败：${response.status} ${(await response.text()).slice(0, 200)}`);
  return name;
}
async function getObject(name: string): Promise<Buffer> {
  const response = await fetch(`${STORAGE()}/object/authenticated/${BUCKET}/${name}`, { headers: storageAuth() });
  if (!response.ok) throw new Error(`下载分段失败：${name} ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
/** 批量删除对象（接口每次最多 20 个）；删不掉只是多占存储，不影响流程 */
async function removeObjects(names: string[]) {
  const batches = Array.from({ length: Math.ceil(names.length / 20) }, (_, i) => names.slice(i * 20, i * 20 + 20));
  await Promise.all(batches.map(async (prefixes) => {
    const response = await fetch(`${STORAGE()}/object/${BUCKET}`, { method: "DELETE", headers: { ...storageAuth(), "content-type": "application/json" }, body: JSON.stringify({ prefixes }) });
    if (!response.ok) console.error("删除录音失败", response.status, (await response.text()).slice(0, 200));
  }));
}
async function signedUrl(name: string, expiresIn: number): Promise<string> {
  const response = await fetch(`${STORAGE()}/object/sign/${BUCKET}/${name}`, { method: "POST", headers: { ...storageAuth(), "content-type": "application/json" }, body: JSON.stringify({ expiresIn }) });
  const body = (await response.json().catch(() => ({}))) as { fullSignedURL?: string }; // signedURL 是带 /v1/storages 的相对路径
  if (!response.ok || !body.fullSignedURL) throw new Error(`获取合并录音临时链接失败：${response.status}`);
  return body.fullSignedURL;
}

const eq = (value: string | number) => `eq.${encodeURIComponent(String(value))}`;
const inList = (values: string[]) => `in.(${values.map((v) => encodeURIComponent(`"${v}"`)).join(",")})`;

let feishuClient: FeishuClient | undefined;
const feishu = () => (feishuClient ??= new FeishuClient({ appId: requireEnv("FEISHU_APP_ID"), appSecret: requireEnv("FEISHU_APP_SECRET") }));
const schedule = () => ({ appToken: requireEnv("SCHEDULE_APP_TOKEN"), tableId: requireEnv("SCHEDULE_TABLE_ID") });

let asrClient: InstanceType<typeof asr.v20190614.Client> | undefined;
const asrApi = () =>
  (asrClient ??= new asr.v20190614.Client({
    credential: { secretId: requireEnv("TENCENT_SECRET_ID"), secretKey: requireEnv("TENCENT_SECRET_KEY") },
    region: "ap-shanghai",
    profile: { httpProfile: { endpoint: "asr.tencentcloudapi.com" } },
  }));

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const LEASE_MS = 6 * 60_000; // > 函数超时 300 s，进程被杀后 6 分钟自动释放

// ---------- HTTP helpers ----------

interface HttpEvent {
  httpMethod?: string; path?: string; headers?: Record<string, string>; queryStringParameters?: Record<string, string>;
  body?: string; isBase64Encoded?: boolean; Type?: string; TriggerName?: string; action?: string; lessonId?: string;
}
type Session = { _id: string; openId: string; name: string; scheduleName: string };

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
  isBase64Encoded: false,
});
const fail = (statusCode: number, error: string, message: string) => json(statusCode, { error, message });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (statusCode: number, title: string, message: string) => ({
  statusCode,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  isBase64Encoded: false,
  body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · 菁仕课堂</title><style>
:root{--bg:#f6f7f9;--paper:#fff;--text:#16181d;--muted:#5d6573;--line:#e3e6eb}@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--paper:#171a20;--text:#eceef2;--muted:#a3aab6;--line:#2a2f38}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(420px,calc(100% - 32px));padding:36px 32px;background:var(--paper);border:1px solid var(--line);border-radius:16px}.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px}.mark{display:grid;place-items:center;width:30px;height:30px;background:#2f6bff;color:#fff;border-radius:8px}h1{font-size:24px;margin:28px 0 8px}p{margin:0;color:var(--muted)}
</style></head><body><main><div class="brand"><span class="mark">菁</span>菁仕课堂</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
});

function header(event: HttpEvent, name: string): string {
  for (const [key, value] of Object.entries(event.headers ?? {})) if (key.toLowerCase() === name) return String(value);
  return "";
}
function jsonBody(event: HttpEvent): Record<string, any> {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
  } catch {
    return {};
  }
}

const getRow = async <T>(table: string, id: string): Promise<T | undefined> => (await pg<T>("GET", table, `_id=${eq(id)}&limit=1`))[0];
/** 课程行 + 分段表拼成 LessonDoc */
async function getLesson(id: string): Promise<LessonDoc | undefined> {
  const row = await getRow<Omit<LessonDoc, "segments">>(LESSONS, id);
  if (!row) return undefined;
  const segments = await pg<{ seq: number; sha256: string; bytes: number; fileId: string }>("GET", SEGMENTS, `lessonId=${eq(id)}&select=seq,sha256,bytes,fileId`);
  return { ...row, segments: Object.fromEntries(segments.map(({ seq, ...rest }) => [String(seq), rest])) };
}
const updateLesson = (id: string, patch: Record<string, unknown>) => pg("PATCH", LESSONS, `_id=${eq(id)}`, { ...patch, updatedAt: Date.now() }, "return=minimal");

async function authenticate(event: HttpEvent): Promise<Session | undefined> {
  const token = header(event, "authorization").replace(/^Bearer\s+/i, "").trim();
  return token ? getRow<Session>(SESSIONS, sha256(token)) : undefined;
}

// ---------- 飞书登录 ----------

const redirectUri = () => `${requireEnv("API_BASE_URL").replace(/\/$/, "")}/auth/callback`;

/** 老师 App（kind 为空）和后台网页（kind = admin）共用同一个飞书回调地址，靠 state 行区分 */
async function authorizeUrl(kind?: "admin") {
  const state = randomBytes(16).toString("base64url");
  await pg("POST", AUTH, "", [{ _id: state, status: "pending", expiresAt: Date.now() + 10 * 60_000, ...(kind ? { kind } : {}) }], "return=minimal");
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.searchParams.set("client_id", requireEnv("FEISHU_APP_ID"));
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  return { state, url: url.href };
}

const authStart = async () => json(200, await authorizeUrl());

async function feishuUser(code: string): Promise<{ openId: string; name: string }> {
  const tokenResponse = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: requireEnv("FEISHU_APP_ID"), client_secret: requireEnv("FEISHU_APP_SECRET"), code, redirect_uri: redirectUri() }),
  });
  const token = (await tokenResponse.json()) as { code?: number; access_token?: string; error_description?: string; msg?: string };
  if (token.code !== 0 || !token.access_token) throw new Error(`飞书换取用户凭证失败：${token.error_description ?? token.msg ?? token.code}`);
  const infoResponse = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { authorization: `Bearer ${token.access_token}` } });
  const info = (await infoResponse.json()) as { code?: number; msg?: string; data?: { open_id?: string; name?: string } };
  if (info.code !== 0 || !info.data?.open_id) throw new Error(`飞书用户信息获取失败：${info.msg ?? info.code}`);
  return { openId: info.data.open_id, name: info.data.name ?? "" };
}

async function authCallback(query: Record<string, string>) {
  const state = query.state ?? "";
  const auth = state ? await getRow<{ status: string; expiresAt: number; kind?: string }>(AUTH, state) : undefined;
  if (!auth || auth.expiresAt < Date.now() || auth.status !== "pending") return page(400, "登录链接已过期", "请回到菁仕课堂，重新点「飞书登录」。");
  if (!query.code) return page(400, "没有完成授权", "请回到菁仕课堂，重新点「飞书登录」并同意授权。");
  try {
    if (auth.kind === "admin") return await adminCallback(state, query.code);
    const { openId, name } = await feishuUser(query.code);
    const teacherTable = { appToken: requireEnv("TEACHER_APP_TOKEN"), tableId: requireEnv("TEACHER_TABLE_ID") };
    const match = L.matchTeacher((await feishu().listAllRecords(teacherTable)).map(parseTeacher), openId, name);
    if (!match) {
      await pg("PATCH", AUTH, `_id=${eq(state)}`, { status: "not_teacher" }, "return=minimal");
      await notifyAdmins(`${name || "有人"} 想登录菁仕课堂，但「老师信息」表里没有对得上的档案。请在老师信息表新增一行（姓名和飞书里一致），并选上他的「飞书账号」。`);
      return page(403, "老师档案里还没有你", `${name || "你"}，「老师信息」表里没有找到你的姓名，已通知教务添加。添加好后回到菁仕课堂再点一次「飞书登录」。`);
    }
    const { teacher } = match;
    // 第一次登录、档案还没选飞书账号：按姓名认上后写回，以后都按飞书账号认
    if (match.bind) await feishu().updateRecord({ ...teacherTable, recordId: teacher.recordId, fields: { [TEACHER_FIELDS.feishu]: [{ id: openId }] } });
    await pg("PATCH", AUTH, `_id=${eq(state)}`, { status: "done", openId, name: teacher.name, scheduleName: teacher.scheduleName }, "return=minimal");
    return page(200, "登录成功", `${match.bind ? `${teacher.name}，已自动关联你在「老师信息」里的档案。` : ""}可以回到菁仕课堂了，这个页面可以关闭。`);
  } catch (error) {
    console.error(error);
    return page(500, "登录失败", "飞书暂时没有响应，请回到菁仕课堂重试。");
  }
}

async function authPoll(state: string) {
  const auth = state ? await getRow<{ status: string; expiresAt: number; openId: string; name: string; scheduleName: string }>(AUTH, state) : undefined;
  if (!auth || auth.expiresAt < Date.now()) return fail(410, "EXPIRED", "登录已过期，请重新登录");
  if (auth.status === "pending") return json(202, { pending: true });
  if (auth.status === "not_teacher") return fail(403, "NOT_A_TEACHER", "「老师信息」表里还没有你，已通知教务添加，添加好后再登录");
  // 原子领取：同一个 state 只发一次 token；数据库只存 token 的 sha256
  const claimed = await pg("DELETE", AUTH, `_id=${eq(state)}&status=eq.done`);
  if (!claimed.length) return fail(410, "EXPIRED", "登录已过期，请重新登录");
  const token = randomBytes(32).toString("base64url");
  await pg("POST", SESSIONS, "", [{ _id: sha256(token), openId: auth.openId, name: auth.name, scheduleName: auth.scheduleName, createdAt: Date.now() }], "return=minimal");
  return json(200, { token, teacher: { name: auth.name } });
}

// ---------- 课程 ----------

async function listLessons(session: Session) {
  const now = Date.now();
  const { from, to } = L.lessonWindow(now);
  const records = await feishu().searchRecords({ ...schedule(), fieldNames: L.SCHEDULE_FIELDS, filter: L.scheduleFilter(session.scheduleName, from, to) });
  const lessons = records
    .map(L.parseScheduleRecord)
    // 没有学生的是会议 / 例会 / 「空出」占位，不当课录（「空出」常是 00:00–23:00，否则会整天自动录）
    .filter((lesson): lesson is L.ScheduleLesson => lesson !== null && Boolean(lesson.student) && lesson.startAt >= from && lesson.startAt < to)
    .sort((a, b) => a.startAt - b.startAt);
  const ids = lessons.map((lesson) => lesson.id);
  const docs = ids.length
    ? await pg<LessonDoc>("GET", LESSONS, `_id=${inList(ids)}&teacherOpenId=${eq(session.openId)}&select=_id,stage,copied,summary,editedSummary,reportToken,report`)
    : [];
  const byId = new Map(docs.map((doc) => [doc._id, doc]));
  const adhoc = await pg<LessonDoc>("GET", LESSONS,
    `teacherOpenId=${eq(session.openId)}&kind=in.(adhoc,meeting)&startAt=gte.${from}&startAt=lt.${to}&select=_id,course,kind,startAt,endAt,stage,copied,summary,editedSummary,reportToken`);
  const base = requireEnv("REPORT_BASE_URL");
  return json(200, { lessons: [...lessons.map((lesson) => L.toLesson(lesson, byId.get(lesson.id), base)), ...adhoc.map((doc) => L.adhocLesson(doc, base))] });
}

/** 第一次碰到某节课时回查课表，确认是这位老师的课再建档；之后只比对 teacherOpenId */
async function ownLesson(id: string, session: Session, device = ""): Promise<LessonDoc | string> {
  const existing = await getLesson(id);
  if (existing) return existing.teacherOpenId !== session.openId ? "NOT_YOUR_LESSON" : await claimDevice(existing, device);
  const now = Date.now();
  // 随时录制：不在课表里，第一次上传就按这位老师建档；主题、类型、真实起止时间等 finish 时再填
  const lesson = L.isAdhocId(id)
    ? { student: "", course: "随时录制", location: "", startAt: now, endAt: now + L.ADHOC_MAX_MS, kind: "adhoc" as const }
    : await scheduledLesson(id, session);
  if (typeof lesson === "string") return lesson;
  const { segments, ...row }: LessonDoc = {
    _id: id, teacherOpenId: session.openId, teacherName: session.name, kind: "lesson", ...lesson,
    stage: "recording", attempts: 0, lockedUntil: 0, segments: {}, copied: false, createdAt: now, updatedAt: now,
  };
  // 并发上传同时建档：冲突时忽略，以已建好的那行为准
  await pg("POST", LESSONS, "on_conflict=_id", [row], "resolution=ignore-duplicates,return=minimal");
  const created = await getLesson(id);
  if (!created) return "LESSON_NOT_FOUND";
  return created.teacherOpenId === session.openId ? await claimDevice(created, device) : "NOT_YOUR_LESSON";
}

async function scheduledLesson(id: string, session: Session) {
  const record = await feishu().getRecord({ ...schedule(), recordId: id });
  const lesson = record ? L.parseScheduleRecord(record) : null;
  if (!lesson) return "LESSON_NOT_FOUND";
  if (lesson.teacher !== session.scheduleName) return "NOT_YOUR_LESSON";
  return { student: lesson.student, course: lesson.course, location: lesson.location, startAt: lesson.startAt, endAt: lesson.endAt };
}

/** 同一节课只收第一台上传的电脑：老师两台电脑都开着时，两边都会自动录，分段序号相同会互相覆盖 */
async function claimDevice(lesson: LessonDoc, device: string): Promise<LessonDoc | string> {
  if (!device || lesson.device === device) return lesson;
  if (lesson.device) return "OTHER_DEVICE";
  const claimed = await pg("PATCH", LESSONS, `_id=${eq(lesson._id)}&device=is.null`, { device });
  return claimed.length ? { ...lesson, device } : claimDevice((await getLesson(lesson._id))!, device);
}

const ownFail = (code: string) =>
  code === "OTHER_DEVICE" ? fail(409, code, "这节课已经在另一台电脑上录制") : fail(code === "NOT_YOUR_LESSON" ? 403 : 404, code, "这节课不在你的课表里");

async function uploadSegment(event: HttpEvent, session: Session, id: string, seq: number) {
  const bytes = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "latin1");
  if (!bytes.length || bytes.length > 2_000_000) return fail(400, "BAD_BODY", "分段为空或超过 2 MB");
  const hash = sha256(bytes);
  if (hash !== header(event, "x-sha256").toLowerCase()) return fail(400, "BAD_SHA256", "分段校验失败，请重传");
  const lesson = await ownLesson(id, session, header(event, "x-device"));
  if (typeof lesson === "string") return ownFail(lesson);
  const fileID = await putObject(`${id}/${String(seq).padStart(5, "0")}.mp3`, bytes);
  await pg("POST", SEGMENTS, "on_conflict=lessonId,seq", [{ lessonId: id, seq, sha256: hash, bytes: bytes.length, fileId: fileID }], "resolution=merge-duplicates,return=minimal");
  await updateLesson(id, {}); // 记下最近一次收到分段的时间，没发 finish 的课据此判断 App 是否还在补传
  return json(200, { ok: true });
}

async function finishLesson(event: HttpEvent, session: Session, id: string) {
  const body = jsonBody(event);
  const segments = Array.isArray(body.segments) ? body.segments : null;
  const valid =
    segments?.every((s: any) => Number.isInteger(s?.seq) && s.seq >= 0 && /^[0-9a-f]{64}$/.test(String(s.sha256))) &&
    Number.isFinite(Date.parse(body.startedAt)) && Number.isFinite(Date.parse(body.endedAt));
  if (!segments || !valid) return fail(400, "BAD_BODY", "需要 startedAt、endedAt 和 segments[{seq, sha256, bytes}]");
  const lesson = await ownLesson(id, session, header(event, "x-device"));
  if (typeof lesson === "string") return ownFail(lesson);
  const finish = {
    startedAt: String(body.startedAt), endedAt: String(body.endedAt),
    segments: segments.map((s: any) => ({ seq: s.seq, sha256: String(s.sha256), bytes: Number(s.bytes) || 0 })),
  };
  const missing = L.missingSeqs(finish.segments, lesson.segments);
  if (lesson.stage === "recording" || lesson.stage === "queued") {
    // 随时录制：老师结束时填的主题和类型，起止时间以 App 实际录制为准
    const adhoc = L.isAdhocId(id)
      ? { course: String(body.topic ?? "").trim().slice(0, 30) || "随时录制", kind: body.kind === "meeting" ? "meeting" : "adhoc", startAt: Date.parse(finish.startedAt), endAt: Date.parse(finish.endedAt) }
      : {};
    await updateLesson(id, { finish, stage: "queued", ...adhoc });
    if (!missing.length) await processLesson(id, Date.now() + 20_000); // 齐了立刻合并提交转写，失败交给定时器重试
  }
  return json(200, { missing });
}

async function ownedPatch(id: string, session: Session, patch: Record<string, unknown>) {
  const lesson = await getRow<LessonDoc>(LESSONS, id);
  if (!lesson || lesson.teacherOpenId !== session.openId) return fail(404, "LESSON_NOT_FOUND", "没有找到这节课的录音");
  await updateLesson(id, patch);
  return json(200, { ok: true });
}

async function getReport(token: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return fail(404, "NOT_FOUND", "未找到这份课堂报告");
  const [doc] = await pg<LessonDoc>("GET", LESSONS, `reportToken=${eq(token)}&stage=eq.done&limit=1&select=student,course,kind,teacherName,startAt,endAt,finish,report,gapMinutes`);
  return doc ? json(200, L.reportData(doc)) : fail(404, "NOT_FOUND", "未找到这份课堂报告");
}

// ---------- 处理流水线 ----------

const download = getObject;

async function chat(messages: Array<{ role: string; content: string }>, jsonMode = false, maxTokens = 4000): Promise<string> {
  const response = await fetch(`${requireEnv("AI_BASE_URL").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${requireEnv("AI_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: requireEnv("AI_MODEL"), messages, temperature: 0.3, max_tokens: maxTokens, ...(jsonMode ? { response_format: { type: "json_object" } } : {}) }),
    // 分段摘要 + 总结 + 纠错重试加起来可能超过函数的 300 s 硬上限：被硬杀不会记失败次数、会反复付费重跑，所以按剩余时间截止
    signal: AbortSignal.timeout(Math.max(1_000, Math.min(150_000, hardStop - Date.now()))),
  });
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!response.ok || !content) throw new Error(`大模型调用失败：${response.status} ${body.error?.message ?? ""}`);
  return content;
}

/** 让大模型判断哪个「说话人N」是老师，改成「老师 / 学生」；判断失败就保持原样，不影响出总结 */
async function withRoles(transcript: string): Promise<string> {
  if (L.speakerStats(transcript).size < 2) return transcript;
  try {
    return L.labelSpeakers(transcript, L.parseTeacher(await chat([{ role: "user", content: L.teacherPrompt(transcript) }], true), transcript));
  } catch (error) {
    console.error("判断老师失败", error);
    return transcript;
  }
}

/** 转写 → 家长总结 + 学情报告；流水线和后台预览共用 */
async function generate(meta: L.PromptMeta, transcript: string, prompts: L.Prompts) {
  if (!transcript.trim()) throw new Error("转写为空：录音里没有识别到有效语音");
  const chunks = L.chunkTranscript(transcript);
  const material = chunks.length === 1
    ? transcript
    : (await Promise.all(chunks.map((chunk, index) => chat([{ role: "user", content: L.chunkPrompt(chunk, index, chunks.length, prompts.rules) }]))))
        .map((notes, index) => `【第 ${index + 1} 段】\n${notes}`)
        .join("\n\n");
  const messages = L.summaryMessages(meta, material, chunks.length > 1, prompts);
  const headings = L.promptHeadings(prompts);
  const raw = await chat(messages, true);
  try {
    return L.parseSummary(raw, headings);
  } catch (error) {
    const retry = await chat([...messages, { role: "assistant", content: raw }, { role: "user", content: `上面的输出不符合要求：${(error as Error).message}。请重新只输出符合结构的 JSON。` }], true);
    return L.parseSummary(retry, headings);
  }
}

/** 转写 → 结构化会议纪要 + 纯文本；分段规则同 generate */
async function meetingMinutes(meta: { topic: string; monthDay: string }, transcript: string, prompt: string) {
  if (!transcript.trim()) throw new Error("转写为空：录音里没有识别到有效语音");
  const chunks = L.chunkTranscript(transcript);
  const material = chunks.length === 1
    ? transcript
    : (await Promise.all(chunks.map((chunk, index) => chat([{ role: "user", content: L.meetingChunkPrompt(chunk, index, chunks.length) }]))))
        .map((notes, index) => `【第 ${index + 1} 段】\n${notes}`)
        .join("\n\n");
  const messages = L.meetingMessages(meta, material, chunks.length > 1, prompt);
  const speakers = L.meetingSpeakers(transcript);
  const raw = await chat(messages, true, 8000); // 长会的议题多，4000 token 会把 JSON 截断
  let report: L.MeetingReport;
  try {
    report = L.parseMeetingReport(raw, speakers);
  } catch (error) {
    report = L.parseMeetingReport(await chat([...messages, { role: "assistant", content: raw }, { role: "user", content: `上面的输出不符合要求：${(error as Error).message}。请重新只输出符合结构的 JSON。` }], true, 8000), speakers);
  }
  return { report, text: L.meetingText(report, meta.monthDay) };
}

type PromptRow = L.Prompts & { version: number; createdAt: number; createdBy: string };
/** 线上提示词 = 版本号最大的一行；还没在后台保存过时用代码里的默认（版本 0） */
async function livePrompts(): Promise<PromptRow> {
  const [row] = await pg<PromptRow>("GET", PROMPTS, "order=version.desc&limit=1");
  return row ? withMeeting(row) : { ...L.DEFAULT_PROMPTS, version: 0, createdAt: 0, createdBy: "默认" };
}

/** 加「会议纪要」之前保存的版本没有 meeting，用默认补上 */
function withMeeting(row: PromptRow): PromptRow {
  return { ...row, meeting: row.meeting || L.DEFAULT_PROMPTS.meeting };
}

/** 执行一步，返回要写回的字段；null = 外部还没好（转写进行中），本轮结束 */
async function runStep(doc: LessonDoc, step: L.Step): Promise<Partial<LessonDoc> | null> {
  if (step.action === "retry") return { stage: step.stage };
  if (step.action === "merge") {
    if (!step.seqs.length) throw new Error("没有收到任何录音分段");
    const parts: Buffer[] = [];
    for (let i = 0; i < step.seqs.length; i += 10) {
      parts.push(...(await Promise.all(step.seqs.slice(i, i + 10).map((seq) => download(doc.segments[String(seq)].fileId)))));
    }
    // MP3 帧可直接按字节拼接，不需要 ffmpeg
    const fileID = await putObject(`${doc._id}/merged.mp3`, Buffer.concat(parts));
    const url = await signedUrl(fileID, 6 * 3600);
    const task = await asrApi().CreateRecTask({
      EngineModelType: process.env.ASR_ENGINE?.trim() || "16k_zh_en_2.0", ChannelNum: 1, SourceType: 0, Url: url,
      SpeakerDiarization: 1, SpeakerNumber: 0, ResTextFormat: 2, ConvertNumMode: 1,
    });
    if (!task.Data?.TaskId) throw new Error("腾讯云录音识别任务提交失败");
    return { stage: "transcribing", mergedFileId: fileID, asrTaskId: task.Data.TaskId, gapMinutes: step.gapMinutes };
  }
  if (step.action === "poll") {
    if (!doc.asrTaskId) return { stage: "queued" };
    const status = await asrApi().DescribeTaskStatus({ TaskId: doc.asrTaskId });
    const data = status.Data;
    if (data?.Status === 3) {
      doc.stage = "queued"; // 识别失败要重新提交，让重试回到合并这一步
      throw new Error(`腾讯云录音识别失败：${data.ErrorMsg ?? ""}`);
    }
    if (data?.Status !== 2) return null;
    const transcript = L.formatTranscript(data.ResultDetail, data.Result ?? "");
    return { stage: "summarizing", transcript: doc.kind === "meeting" ? transcript : await withRoles(transcript) };
  }
  if (step.action === "summarize" && doc.kind === "meeting") {
    const prompts = await livePrompts();
    const { report, text } = await meetingMinutes({ topic: doc.course, monthDay: L.shMonthDay(doc.startAt) }, doc.transcript ?? "", prompts.meeting);
    return { stage: "done", summary: text, report, reportToken: randomBytes(24).toString("base64url"), promptVersion: prompts.version, error: "" };
  }
  if (step.action === "summarize") {
    const prompts = await livePrompts();
    const meta = { student: doc.student, course: doc.course, teacher: doc.teacherName, monthDay: L.shMonthDay(doc.startAt) };
    const { parentSummary, report } = await generate(meta, doc.transcript ?? "", prompts);
    return {
      stage: "done", summary: parentSummary, report: { ...report, gapMinutes: doc.gapMinutes ?? 0 }, reportToken: randomBytes(24).toString("base64url"),
      promptVersion: prompts.version, error: "",
    };
  }
  return null;
}

async function notifyTeacher(doc: LessonDoc, text: string) {
  try {
    await feishu().sendMessage({ receiveIdType: "open_id", receiveId: doc.teacherOpenId, msgType: "text", content: { text } });
  } catch (error) {
    console.error("飞书通知失败", doc._id, error);
  }
}

async function processLesson(id: string, deadline: number) {
  const leased = await pg("PATCH", LESSONS, `_id=${eq(id)}&lockedUntil=lt.${Date.now()}`, { lockedUntil: Date.now() + LEASE_MS });
  if (!leased.length) return; // 另一个实例正在处理
  let doc = (await getLesson(id))!;
  try {
    while (Date.now() < deadline) {
      const step = L.nextStep(doc, Date.now());
      if (step.action === "none" || step.action === "wait") break;
      const patch = await runStep(doc, step);
      if (!patch) break;
      await updateLesson(id, patch);
      // 转写已入库：分段只在重新合并时有用，删掉，云端只留 merged.mp3（失败重试从 summarizing 起步，不再需要分段）
      if (patch.transcript !== undefined) await removeObjects(Object.values(doc.segments).map((s) => s.fileId));
      doc = { ...doc, ...patch };
      if (doc.stage === "done") {
        const title = doc.kind === "meeting" ? `${doc.course}的会议纪要好了` : doc.student ? `${doc.student}今天的课堂总结好了` : `${doc.course}的课堂总结好了`;
        await notifyTeacher(doc, `${title}\n\n${doc.summary}${doc.reportToken ? `\n\n完整报告：${requireEnv("REPORT_BASE_URL")}?t=${doc.reportToken}` : ""}`);
        break;
      }
    }
  } catch (error) {
    console.error("处理失败", id, error);
    const attempts = (doc.attempts ?? 0) + 1;
    await updateLesson(id, { stage: "failed", failedStage: doc.stage as Stage, attempts, error: (error as Error).message?.slice(0, 500) ?? String(error) });
    if (attempts >= L.MAX_ATTEMPTS) {
      await notifyTeacher(doc, `${[doc.course, doc.student].filter(Boolean).join(" · ")}（${L.shMonthDay(doc.startAt)}）的录音处理失败：${(error as Error).message}。请联系教务。`);
    }
  } finally {
    await pg("PATCH", LESSONS, `_id=${eq(id)}`, { lockedUntil: 0 }, "return=minimal");
  }
}

/** 录音保留 30 天：删分段和 merged.mp3，转写、总结、报告保留。每分钟最多处理 20 节，远大于每天新增的课数 */
async function expireAudio() {
  const rows = await pg<{ _id: string; mergedFileId: string | null }>("GET", LESSONS,
    `audioDeletedAt=is.null&startAt=lt.${Date.now() - L.AUDIO_KEEP_MS}&stage=neq.recording&select=_id,mergedFileId&order=startAt.asc&limit=20`);
  for (const row of rows) {
    const segments = await pg<{ fileId: string }>("GET", SEGMENTS, `lessonId=${eq(row._id)}&select=fileId`);
    await removeObjects([...segments.map((s) => s.fileId), ...(row.mergedFileId ? [row.mergedFileId] : [])]);
    await updateLesson(row._id, { mergedFileId: null, audioDeletedAt: Date.now() });
  }
}

async function runPipeline(lessonId?: string) {
  const deadline = Date.now() + 170_000; // 函数超时 300 s，留出总结所需时间
  if (lessonId) return processLesson(lessonId, deadline);
  await expireAudio().catch((error) => console.error("清理过期录音失败", error));
  const rows = await pg<{ _id: string }>("GET", LESSONS,
    // 还在上课 / 补传宽限期内的 recording 行什么都不用做，不查出来，免得同时上课的人多了把要处理的课挤出前 50
    `stage=in.(recording,queued,transcribing,summarizing,failed)&attempts=lt.${L.MAX_ATTEMPTS}&lockedUntil=lt.${Date.now()}` +
      `&or=(stage.neq.recording,endAt.lt.${Date.now() - L.MISSING_GRACE_MS})&select=_id&order=updatedAt.asc&limit=50`);
  for (const { _id } of rows) {
    if (Date.now() > deadline) break;
    await processLesson(_id, deadline);
  }
}

// ---------- 后台（/classroom/admin.html）：管理员 = 环境变量 ADMIN_OPEN_IDS 里的飞书 open_id ----------

type AdminSession = { _id: string; openId: string; name: string; expiresAt: number };
const ADMIN_TTL_MS = 30 * L.DAY;
const adminUrl = () => requireEnv("REPORT_BASE_URL").replace(/report\.html$/, "admin.html");
const adminOpenIds = () => (process.env.ADMIN_OPEN_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const isAdmin = (openId: string) => adminOpenIds().includes(openId);

/** 私信后台管理员；发不出去只记日志，不影响主流程 */
async function notifyAdmins(text: string) {
  for (const receiveId of adminOpenIds()) {
    await feishu()
      .sendMessage({ receiveIdType: "open_id", receiveId, msgType: "text", content: { text } })
      .catch((error: unknown) => console.error("[classroom-api] 通知管理员失败", error instanceof Error ? error.message : error));
  }
}
const redirect = (location: string) => ({ statusCode: 302, headers: { location, "cache-control": "no-store" }, body: "", isBase64Encoded: false });

async function adminCallback(state: string, code: string) {
  const claimed = await pg("DELETE", AUTH, `_id=${eq(state)}&status=eq.pending`);
  if (!claimed.length) return page(400, "登录链接已过期", "请回到后台重新登录。");
  const user = await feishuUser(code);
  if (!isAdmin(user.openId)) return page(403, "没有后台权限", `请把这串 ID 发给管理员开通：${user.openId}`);
  const token = randomBytes(32).toString("base64url");
  await pg("POST", ADMIN_SESSIONS, "", [{ _id: sha256(token), openId: user.openId, name: user.name || "管理员", expiresAt: Date.now() + ADMIN_TTL_MS }], "return=minimal");
  return redirect(`${adminUrl()}#token=${token}`); // 放在 # 后面，不进服务器日志；网页读出后立刻从地址栏清掉
}

async function authenticateAdmin(event: HttpEvent): Promise<AdminSession | undefined> {
  const token = header(event, "authorization").replace(/^Bearer\s+/i, "").trim();
  const session = token ? await getRow<AdminSession>(ADMIN_SESSIONS, sha256(token)) : undefined;
  return session && session.expiresAt > Date.now() ? session : undefined;
}

const STAGE_FILTER: Record<string, string> = { done: "eq.done", recording: "eq.recording", failed: "eq.failed", processing: "in.(queued,transcribing,summarizing)" };

async function adminLessons(query: Record<string, string>) {
  const filters = ["select=_id,student,course,kind,teacherName,startAt,endAt,stage,attempts,promptVersion", "order=startAt.desc", "limit=50"];
  if (STAGE_FILTER[query.stage]) filters.push(`stage=${STAGE_FILTER[query.stage]}`);
  if (/^\d+$/.test(query.before ?? "")) filters.push(`startAt=lt.${query.before}`);
  // 只留文字和数字：PostgREST 的 or=(…) 里逗号、括号、星号都有含义
  const q = (query.q ?? "").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 20);
  if (q) filters.push(`or=(${["student", "course", "teacherName"].map((column) => `${column}.ilike.*${encodeURIComponent(q)}*`).join(",")})`);
  return json(200, { lessons: await pg("GET", LESSONS, filters.join("&")) });
}

async function adminLesson(id: string) {
  const [doc] = await pg<LessonDoc>("GET", LESSONS,
    `_id=${eq(id)}&select=_id,student,course,kind,teacherName,startAt,endAt,stage,attempts,error,finish,mergedFileId,audioDeletedAt,transcript,summary,editedSummary,reportToken,promptVersion,gapMinutes`);
  if (!doc) return fail(404, "LESSON_NOT_FOUND", "没有找到这节课");
  const { finish, mergedFileId, ...rest } = doc;
  return json(200, {
    ...rest,
    mins: L.reportData(doc).mins,
    fileName: [doc.student, doc.course, L.shDate(doc.startAt)].filter(Boolean).join("_").replace(/[\\/:*?"<>|\s]/g, ""),
    audioUrl: mergedFileId ? await signedUrl(mergedFileId, 6 * 3600) : null, // 存储同 Supabase：链接后加 &download=文件名 即按附件下载
    reportUrl: doc.reportToken ? `${requireEnv("REPORT_BASE_URL")}?t=${doc.reportToken}` : null,
  });
}

function readPrompts(value: any): L.Prompts | null {
  const keys = ["rules", "parent", "report", "meeting"] as const;
  if (!value || keys.some((key) => typeof value[key] !== "string" || !value[key].trim() || value[key].length > 20_000)) return null;
  return { rules: value.rules.trim(), parent: value.parent.trim(), report: value.report.trim(), meeting: value.meeting.trim() };
}

async function savePrompts(event: HttpEvent, admin: AdminSession) {
  const body = jsonBody(event);
  const prompts = readPrompts(body.prompts);
  if (!prompts) return fail(400, "BAD_BODY", "四段提示词都不能为空，且每段不超过 20000 字");
  const live = await livePrompts();
  if (Number(body.base) !== live.version) return fail(409, "STALE", "提示词刚被别人更新过，请刷新后再改");
  const version = live.version + 1;
  try {
    await pg("POST", PROMPTS, "", [{ version, ...prompts, createdAt: Date.now(), createdBy: admin.name }], "return=minimal");
  } catch {
    return fail(409, "STALE", "提示词刚被别人更新过，请刷新后再改"); // 两人同时保存：主键冲突
  }
  return json(200, { version });
}

/** 用给定提示词试生成，不写库；素材 = 已有课程的转写，或直接给的转写文本 */
async function previewPrompts(event: HttpEvent, admin: AdminSession) {
  const body = jsonBody(event);
  const prompts = readPrompts(body.prompts);
  if (!prompts) return fail(400, "BAD_BODY", "四段提示词都不能为空，且每段不超过 20000 字");
  let transcript: string;
  let base: Omit<ReturnType<typeof L.reportData>, "report">;
  let startAt = Date.now();
  if (typeof body.lessonId === "string") {
    const doc = await getRow<LessonDoc>(LESSONS, body.lessonId);
    if (!doc) return fail(404, "LESSON_NOT_FOUND", "没有找到这节课");
    transcript = doc.transcript ?? "";
    const { report: _report, ...rest } = L.reportData(doc);
    base = rest;
    startAt = doc.startAt;
  } else {
    transcript = String(body.transcript ?? "");
    const last = [...transcript.matchAll(/-(\d+):(\d{2})\]/g)].at(-1);
    base = { student: "", course: "", kind: "lesson", teacher: admin.name, date: L.shDate(startAt), time: "", mins: last ? Math.round(Number(last[1]) + Number(last[2]) / 60) : 0, gapMinutes: 0 };
  }
  if (!transcript.trim()) return fail(400, "NO_TRANSCRIPT", "这节课还没有转写内容");
  if (transcript.length > 200_000) return fail(400, "TOO_LONG", "转写超过 20 万字");
  try {
    if (body.kind === "meeting") {
      const out = await meetingMinutes({ topic: base.course || "会议", monthDay: L.shMonthDay(startAt) }, transcript, prompts.meeting);
      return json(200, { parentSummary: out.text, reportData: { ...base, kind: "meeting", report: out.report } });
    }
    const out = await generate({ student: base.student, course: base.course, teacher: base.teacher, monthDay: L.shMonthDay(startAt) }, transcript, prompts);
    return json(200, { parentSummary: out.parentSummary, reportData: { ...base, kind: "lesson", report: out.report } });
  } catch (error) {
    return fail(422, "GENERATE_FAILED", `生成失败：${(error as Error).message}`);
  }
}

/** 测试音频分块上传（每块 ≤ 2 MB，HTTP 访问层 body 有大小限制），finish 时按序拼回原文件再提交腾讯云识别 */
async function uploadPart(event: HttpEvent, uid: string, n: number) {
  const bytes = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "latin1");
  if (!bytes.length || bytes.length > 2_000_000) return fail(400, "BAD_BODY", "分块为空或超过 2 MB");
  await putObject(`preview/${uid}/${n}`, bytes, "application/octet-stream");
  return json(200, { ok: true });
}

async function finishUpload(event: HttpEvent, uid: string) {
  const parts = Number(jsonBody(event).parts);
  if (!Number.isInteger(parts) || parts < 1 || parts > 100) return fail(400, "BAD_BODY", "parts 应为 1–100");
  const buffers: Buffer[] = [];
  for (let i = 0; i < parts; i += 10) {
    buffers.push(...(await Promise.all(Array.from({ length: Math.min(10, parts - i) }, (_, k) => getObject(`preview/${uid}/${i + k}`)))));
  }
  const name = await putObject(`preview/${uid}/audio`, Buffer.concat(buffers), "application/octet-stream");
  await removeObjects(Array.from({ length: parts }, (_, i) => `preview/${uid}/${i}`));
  const task = await asrApi().CreateRecTask({
    EngineModelType: process.env.ASR_ENGINE?.trim() || "16k_zh_en_2.0", ChannelNum: 1, SourceType: 0, Url: await signedUrl(name, 6 * 3600),
    SpeakerDiarization: 1, SpeakerNumber: 0, ResTextFormat: 2, ConvertNumMode: 1,
  });
  if (!task.Data?.TaskId) return fail(502, "ASR_FAILED", "腾讯云录音识别任务提交失败");
  return json(200, { taskId: task.Data.TaskId });
}

async function asrStatus(taskId: number) {
  const data = (await asrApi().DescribeTaskStatus({ TaskId: taskId })).Data;
  if (data?.Status === 3) return json(200, { status: "failed", message: `识别失败：${data.ErrorMsg ?? ""}` });
  if (data?.Status !== 2) return json(200, { status: "pending" });
  return json(200, { status: "done", transcript: await withRoles(L.formatTranscript(data.ResultDetail, data.Result ?? "")) });
}

async function adminRoute(method: string, path: string, event: HttpEvent, query: Record<string, string>, admin: AdminSession) {
  if (method === "GET" && path === "/admin/me") return json(200, { name: admin.name });
  if (method === "GET" && path === "/admin/lessons") return adminLessons(query);
  if (method === "GET" && path === "/admin/prompts") {
    const rows = await pg<PromptRow>("GET", PROMPTS, "order=version.desc&limit=30");
    return json(200, { versions: rows.length ? rows.map(withMeeting) : [await livePrompts()] });
  }
  if (method === "POST" && path === "/admin/prompts") return savePrompts(event, admin);
  if (method === "POST" && path === "/admin/preview") return previewPrompts(event, admin);
  let m = path.match(/^\/admin\/lessons\/(rec[A-Za-z0-9]+|adhoc-[0-9a-f]{16})(\/retry)?$/);
  if (m && method === "GET" && !m[2]) return adminLesson(m[1]);
  if (m && method === "POST" && m[2]) {
    await pg("PATCH", LESSONS, `_id=${eq(m[1])}&stage=eq.failed`, { attempts: 0 }, "return=minimal"); // 定时器下一分钟从失败的那一步重跑
    return json(200, { ok: true });
  }
  m = path.match(/^\/admin\/uploads\/([A-Za-z0-9_-]{8,40})\/(\d{1,2}|finish)$/);
  if (m && method === "POST") return m[2] === "finish" ? finishUpload(event, m[1]) : uploadPart(event, m[1], Number(m[2]));
  m = path.match(/^\/admin\/asr\/(\d{1,20})$/);
  if (m && method === "GET") return asrStatus(Number(m[1]));
  return fail(404, "NOT_FOUND", "接口不存在");
}

// ---------- 入口 ----------

/** 本次调用必须结束的时间（函数超时 300 s，留 20 s 写失败状态） */
let hardStop = Date.now() + 280_000;

export async function main(event: HttpEvent) {
  hardStop = Date.now() + 280_000;
  if (typeof event.httpMethod !== "string") {
    if (event.Type === "Timer" || event.TriggerName || event.action === "tick") {
      await runPipeline(event.lessonId);
      return { ok: true };
    }
    return { ok: false, error: "UNKNOWN_ACTION" };
  }
  try {
    const method = event.httpMethod.toUpperCase();
    const path = (event.path ?? "").replace(/^\/classroom-api(?=\/|$)/, "").replace(/\/$/, "") || "/";
    const query = event.queryStringParameters ?? {};
    if (method === "GET" && path === "/auth/start") return await authStart();
    if (method === "GET" && path === "/auth/callback") return await authCallback(query);
    if (method === "GET" && path === "/auth/poll") return await authPoll(query.state ?? "");
    if (method === "GET" && path === "/report") return await getReport(query.t ?? "");
    if (method === "GET" && path === "/admin/login") return redirect((await authorizeUrl("admin")).url);
    if (path.startsWith("/admin/")) {
      const admin = await authenticateAdmin(event);
      if (!admin) return fail(401, "UNAUTHORIZED", "登录已失效，请重新用飞书登录");
      return await adminRoute(method, path, event, query, admin);
    }

    const session = await authenticate(event);
    if (!session) return fail(401, "UNAUTHORIZED", "登录已失效，请重新使用飞书登录");
    if (method === "GET" && path === "/me") return json(200, { teacher: { name: session.name } });
    if (method === "GET" && path === "/lessons") return await listLessons(session);

    const match = path.match(/^\/lessons\/(rec[A-Za-z0-9]+|adhoc-[0-9a-f]{16})\/(segments\/(\d{1,5})|finish|summary|copied)$/);
    if (match) {
      const [, id, action, seq] = match;
      if (method === "POST" && seq !== undefined) return await uploadSegment(event, session, id, Number(seq));
      if (method === "POST" && action === "finish") return await finishLesson(event, session, id);
      if (method === "PUT" && action === "summary") {
        const text = jsonBody(event).text;
        if (typeof text !== "string" || !text.trim() || text.length > 5000) return fail(400, "BAD_BODY", "总结不能为空，且不超过 5000 字");
        return await ownedPatch(id, session, { editedSummary: text });
      }
      if (method === "POST" && action === "copied") return await ownedPatch(id, session, { copied: true });
    }
    return fail(404, "NOT_FOUND", "接口不存在");
  } catch (error) {
    console.error(error);
    return fail(500, "INTERNAL", "服务暂时不可用，请稍后重试");
  }
}
