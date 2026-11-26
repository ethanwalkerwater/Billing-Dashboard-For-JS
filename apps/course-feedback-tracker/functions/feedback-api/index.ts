/**
 * feedback-api —— 月度课程反馈问卷跟踪系统唯一的云函数。
 *
 * 两种入口：
 *  1. 教务前端 `app.callFunction({ name: 'feedback-api', data: { action } })`，带 CloudBase 登录身份；
 *  2. HTTP 触发：`GET /t/:token` 学生扫码跳转、`POST /webhooks/feishu` 答卷事件、
 *     `GET /auth/feishu/start|callback` 教务网站的飞书登录，`POST /auth/monthly-feedback` 学生反馈、
 *     `GET /site/teachers/stats` 官网服务器取老师累计评分和课堂体验（带 x-site-key）。
 *
 * 答卷怎么进库：飞书答卷表有变化时推事件（Webhook），只处理受影响的那几轮；每天凌晨定时对账一次兜底
 * （漏掉的事件、到期定稿）；工作台「刷新反馈」手动补一次。打开工作台只读库，不再每次去飞书拉。
 *
 * 任务列表、筛选、改状态和导出都由前端经 PostgREST + RLS 直接读写 feedback_tasks，
 * 不走这个函数——函数只负责需要飞书密钥或公开访问的那几件事。
 */
import cloudbase from "@cloudbase/node-sdk";

import { collectionMonthToCourseMonth, courseMonthToCollectionMonth, isMonth, shiftMonth } from "../../src/domain/month";
import { customUserId, loginPage, loginRedirect, parseOrigins, safeNext, seal, unseal } from "../../src/server/feishu-login";
import { buildPrefilledFormUrl, FEEDBACK_MONTH_FIELD } from "../../src/domain/form-url";
import { monthlyTaskKey, PARENT_IDENTITY, STUDENT_IDENTITY } from "../../src/domain/monthly-feedback";
import { isMonthlyStudentId, monthlyFeedback, monthlyLinkScope, monthlyLinkToken, readMonthlyFeishuAnswer } from "../../src/server/monthly-feedback";
import { answerFields, formDrift } from "../../src/server/monthly-answer";
import { submitThanks, thanksOptions } from "../../src/server/feedback-thanks";
import type { ThanksRequest } from "../../src/server/feedback-thanks";
import type { MonthlyTaskRow } from "../../src/server/monthly-feedback";
import { buildFeedbackCsv, buildScheduleCsv } from "../../src/server/export/csv";
import { FeishuClient } from "../../src/server/feishu/client";
import { FeishuApiError } from "../../src/server/feishu/errors";
import { loadFeishuConfig } from "../../src/server/feishu/config";
import type { FeishuConfig } from "../../src/server/feishu/config";
import { parseStudentRecord } from "../../src/server/feishu/parsers";
import { generateMonthlyTasks } from "../../src/server/sync/generate-tasks";
import { collectionMonthOf, listResponseRecords, reconcileResponses } from "../../src/server/sync/reconcile-responses";
import { parseFeedbackResponse } from "../../src/server/feishu/parsers";
import { isFrozen } from "../../src/server/tasks/reconcile";
import type { FeishuField, FeishuRecord } from "../../src/server/feishu/types";
import { LIVE_SCORES_FROM, recomputeMonth } from "../../src/server/scores/recompute";
import type { ScoreHistoryMonth, ScoreRequest, ScoreResponse, ScoreStore, StoredResult } from "../../src/server/scores/recompute";
import { EXCLUDED_STUDENTS_TABLE } from "../../src/shared/rdb";
import { RdbFeedbackTaskRepository, SCORE_RESULTS_TABLE, SNAPSHOTS_TABLE, TASKS_TABLE } from "../../src/shared/rdb";
import { ADMIN_ACTIONS, canViewDetail } from "../../src/shared/roles";
import type { Role } from "../../src/shared/roles";
import { buildTeacherStats } from "../../src/server/site/teacher-stats";
import type { ScoreResultRow } from "../../src/server/site/teacher-stats";
import { headerValue, safeEqual, verifyFeishuEvent } from "./feishu-event";
import { createServiceDb } from "./service-db";
import type { FeishuEventEnvelope } from "./feishu-event";

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

interface HttpEvent {
  path?: string;
  httpMethod?: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

/** CloudBase 定时触发器的事件：{ Type: "Timer", TriggerName, Time } */
interface TimerEvent {
  Type?: string;
  TriggerName?: string;
}

interface CallEvent {
  action?: string;
  collectionMonth?: string;
  /** recompute-scores / publish-scores：课程月份 */
  courseMonth?: string;
  dryRun?: boolean;
  /** bind-feishu：飞书登录回跳时带回的签名凭证，证明这个 CloudBase 会话属于哪个飞书账号 */
  bindToken?: string;
  studentIds?: unknown;
}

let serviceDb: ReturnType<typeof createServiceDb> | undefined;
function db() {
  serviceDb ??= createServiceDb({
    envId: requireEnv("CLOUDBASE_ENV_ID"),
    apiKey: requireEnv("CLOUDBASE_API_KEY"),
  });
  return serviceDb;
}

async function selectAll<T>(table: string, columns: string): Promise<T[]> {
  const result = await db().from(table).select<T>(columns);
  if (result.error) throw new Error(`读取 ${table} 失败：${result.error.message}`);
  return result.data ?? [];
}

async function selectRows<T>(table: string, columns: string, filters: Record<string, string> = {}): Promise<T[]> {
  let query = db().from(table).select<T>(columns);
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const result = await query;
  if (result.error) throw new Error(`读取 ${table} 失败：${result.error.message}`);
  return result.data ?? [];
}

/** 评分结果的存取都走服务端身份；计算交给 Python 云函数 feedback-score。 */
const scoreStore: ScoreStore = {
  snapshot: async (kind, month) =>
    (await selectRows<{ csv: string }>(SNAPSHOTS_TABLE, "csv", { kind, month }))[0]?.csv,
  result: async (courseMonth) =>
    (await selectRows<Pick<StoredResult, "status" | "source" | "inputs_hash">>(SCORE_RESULTS_TABLE, "status,source,inputs_hash", { course_month: courseMonth }))[0],
  saveResult: async (row) => {
    const result = await db().from(SCORE_RESULTS_TABLE).upsert([row as unknown as Record<string, unknown>], { onConflict: "course_month" });
    if (result.error) throw new Error(`保存评分结果失败：${result.error.message}`);
  },
  aliases: () => repository().listAliases(),
  courseTypeOverrides: () => repository().listCourseTypeOverrides(),
  history: async (beforeMonth) => {
    const result = await db().from(SCORE_RESULTS_TABLE).select<ScoreHistoryMonth>("course_month,detail").lt("course_month", beforeMonth).order("course_month");
    if (result.error) throw new Error(`读取评分历史失败：${result.error.message}`);
    return result.data ?? [];
  },
  // 评分脚本会把老师名去空格、去「老师」后缀；用课表写法还原显示名（Valentina Lin、数学杨老师）。
  teacherNames: async () => [...new Set((await selectRows<{ teacher_canonical_name: string }>(TASKS_TABLE, "teacher_canonical_name")).map((row) => row.teacher_canonical_name))],
  frozenLessons: async (collectionMonth) =>
    (await repository().listByCollectionMonth(collectionMonth))
      .filter(isFrozen)
      .map((task) => ({ studentName: task.studentName, teacherName: task.teacherCanonicalName, lessons: task.lessons ?? [] })),
  excludedStudents: async () =>
    (await selectRows<{ student_name: string }>(EXCLUDED_STUDENTS_TABLE, "student_name")).map((row) => row.student_name),
};

async function computeScores(request: ScoreRequest): Promise<ScoreResponse> {
  const response = await app.callFunction({ name: "feedback-score", data: request as never });
  return response.result as ScoreResponse;
}

function recompute(courseMonth: string, options: { force?: boolean; publish?: boolean } = {}) {
  return recomputeMonth({ store: scoreStore, compute: computeScores, courseMonth, currentMonth: currentShanghaiMonth(), ...options });
}

/** 对账后重算这几轮对应的课程月份（输入没变就跳过，不调评分函数）。 */
async function recomputeRounds(collectionMonths: Iterable<string>) {
  const scores: Record<string, string> = {};
  for (const collectionMonth of collectionMonths) {
    const courseMonth = collectionMonthToCourseMonth(collectionMonth);
    scores[courseMonth] = await recompute(courseMonth);
  }
  return scores;
}

/** 还在收集的两轮：本月课程（月中就能提前评）和上月课程（晚交的）。 */
function openRounds(): string[] {
  const current = currentShanghaiMonth();
  return [current, shiftMonth(current, 1)];
}

/**
 * 定稿一个课程月份。名单可能是 M 月中提前生成的，课表快照还是当时的计划，所以定稿前重新生成一次名单：
 * 没人评的任务跟上实际课表、课表快照换成实际上过的课（老师总课时用它）；评过的任务课时已定稿，不动。
 * 定稿后通知官网马上重取老师数据。
 */
async function finalizeMonth(courseMonth: string, records: FeishuRecord[], snapshotStartedAt: string, publish = false) {
  const { client, config } = feishu();
  const collectionMonth = courseMonthToCollectionMonth(courseMonth);
  await generateMonthlyTasks({ client, config, repository: repository(), collectionMonth, publicTokenPepper: requireEnv("PUBLIC_TOKEN_PEPPER") });
  await reconcileResponses({ client, config, repository: repository(), collectionMonth, records, snapshotStartedAt });
  const outcome = await recompute(courseMonth, { publish });
  const final = (await scoreStore.result(courseMonth))?.status === "final";
  return { outcome, final, siteRefreshed: final ? await refreshSite() : false };
}

/** 课程月份 M 在 M+2 月初自动定稿（M+1 月过完，晚交的也收齐了），每月只发生一次；提前发布过的跳过。 */
async function finalizeClosingMonth(records: FeishuRecord[], snapshotStartedAt: string) {
  const closing = shiftMonth(currentShanghaiMonth(), -2);
  if (closing < LIVE_SCORES_FROM) return {};
  const stored = await scoreStore.result(closing);
  if (stored?.status === "final" || !(await scoreStore.snapshot("schedule", closing))) return {};
  return { [closing]: (await finalizeMonth(closing, records, snapshotStartedAt)).outcome };
}

/**
 * 工作台「发布定稿」：课程月份过完、还在收集晚交反馈时提前定稿（反馈早就收齐的月份不用等到 M+2 月初）。
 * 发布后新交的反馈不再计入评分；记下谁在什么时候发布的。
 */
async function publishMonth(courseMonth: string, uid: string) {
  if (!isMonth(courseMonth)) throw new Error("课程月份格式不对");
  if (courseMonth < LIVE_SCORES_FROM) throw new Error(`${courseMonth} 是导入的历史分数，已经公布过`);
  if (courseMonth >= currentShanghaiMonth()) throw new Error("这个月的课还没上完，下个月才能发布");
  const stored = await publishState(courseMonth);
  if (!stored || stored.error) throw new Error(`这个月还算不出分数${stored?.error ? `：${stored.error}` : ""}`);
  if (stored.status === "final") throw new Error("这个月已经定稿了");

  const { client, config } = feishu();
  const snapshotStartedAt = new Date().toISOString();
  const result = await finalizeMonth(courseMonth, await listResponseRecords(client, config), snapshotStartedAt, true);
  const after = await publishState(courseMonth);
  if (after?.error) {
    // 评分没算出来就不定稿，免得官网拿到一个空月份
    await db().from(SCORE_RESULTS_TABLE).update({ status: "draft" }).eq("course_month", courseMonth);
    throw new Error(`评分计算失败，没有发布：${after.error}`);
  }
  if (!result.final) throw new Error("缺少课表或答卷，没能定稿；先刷新反馈再试");
  const admin = (await selectRows<{ display_name: string | null }>("feedback_admins", "display_name", { user_id: uid }))[0];
  const saved = await db()
    .from(SCORE_RESULTS_TABLE)
    .update({ published_at: new Date().toISOString(), published_by: admin?.display_name || uid })
    .eq("course_month", courseMonth);
  if (saved.error) throw new Error(`记录发布人失败：${saved.error.message}`);
  return result;
}

async function publishState(courseMonth: string) {
  return (await selectRows<{ status: string; error: string | null }>(SCORE_RESULTS_TABLE, "status,error", { course_month: courseMonth }))[0];
}

/** 通知官网（jsjy.asia）重取老师数据。失败不影响定稿：官网每天也会自己取一次。 */
async function refreshSite(): Promise<boolean> {
  const url = process.env.SITE_REVALIDATE_URL;
  const key = process.env.SITE_API_KEY;
  if (!url || !key) return false;
  try {
    const response = await fetch(url, { method: "POST", headers: { "x-site-key": key }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.error("[feedback-api] 通知官网更新失败", error instanceof Error ? error.message : error);
    return false;
  }
}

/** 全量对账这几轮（整张答卷表读一次），重算分数，顺带检查要不要定稿。工作台「刷新反馈」和每日定时任务用。 */
async function syncRounds(collectionMonths: string[]) {
  const { client, config } = feishu();
  const snapshotStartedAt = new Date().toISOString();
  const records = await listResponseRecords(client, config);
  const results = [];
  for (const collectionMonth of collectionMonths) {
    results.push(await reconcileResponses({ client, config, repository: repository(), collectionMonth, records, snapshotStartedAt }));
  }
  const scores = { ...(await recomputeRounds(collectionMonths)), ...(await finalizeClosingMonth(records, snapshotStartedAt)) };
  return { results, scores };
}

function repository() {
  return new RdbFeedbackTaskRepository(db());
}

function feishu() {
  const config = loadFeishuConfig();
  return { config, client: new FeishuClient({ appId: config.appId, appSecret: config.appSecret }) };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少服务端配置 ${name}`);
  return value;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

/**
 * 只放行已登录且在 feedback_admins 里启用的账号，返回 uid 和权限。
 * teacher 只能用问卷跟踪；看得到评分内容（谁给了几分）的操作要 admin / super，见 ADMIN_ACTIONS。
 */
async function assertMember(): Promise<{ uid: string; role: Role }> {
  let uid: string | undefined;
  try {
    const user = app.auth().getUserInfo();
    uid = user?.isAnonymous ? undefined : user?.uid;
  } catch {
    uid = undefined;
  }
  if (!uid) throw new Error("UNAUTHORIZED");
  const row = (await selectRows<{ role: Role; active: boolean }>("feedback_admins", "role,active", { user_id: uid }))[0];
  if (!row?.active) throw new Error("FORBIDDEN");
  return { uid, role: row.role };
}

function decodeBody(event: HttpEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

/** 学生扫码：只做短链接校验和 302，不向浏览器返回任何任务信息。 */
async function handlePublicRedirect(token: string) {
  const task = token ? await repository().findByPublicToken(token) : null;
  if (!task) {
    // 无效 token 和不存在的 token 返回同样的页面，不暴露任务是否存在。
    return {
      statusCode: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<!doctype html><meta charset=utf-8><title>链接无效</title><p>这个问卷链接无效或已过期，请向教务老师重新获取。",
    };
  }
  const target = buildPrefilledFormUrl({
    baseUrl: feishu().config.formUrl,
    teacherName: task.teacherCanonicalName,
    studentName: task.studentName,
    courseMonth: task.courseMonth,
  });
  return { statusCode: 302, headers: { location: target, "cache-control": "no-store" }, body: "" };
}

function monthlyResponse(status: number, body: unknown) {
  const result = jsonResponse(status, body);
  return { ...result, headers: { ...result.headers, "cache-control": "no-store", "referrer-policy": "no-referrer" } };
}

async function handleMonthlyFeedback(event: HttpEvent) {
  // The capability is in the POST body so it stays out of HTTP access paths and Referer headers.
  const raw = decodeBody(event);
  if (raw.length > 20_000) return monthlyResponse(413, { error: "答卷太长，请缩短建议后重试。" });
  let input: ThanksRequest & { token?: unknown; includeThanks?: unknown; studentDone?: unknown; parentDone?: unknown; action?: unknown;
    identity?: unknown; answers?: unknown };
  try {
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  } catch {
    return monthlyResponse(400, { error: "请求格式有误，请重新打开链接。" });
  }
  const pepper = requireEnv("PUBLIC_TOKEN_PEPPER");
  const scope = monthlyLinkScope(input.token, pepper);
  if (!scope) return monthlyResponse(404, { error: "这个月度反馈链接无效，请联系教务。" });
  if (input.action === "thanks") {
    const { status, body } = await submitThanks(db(), scope, input);
    return monthlyResponse(status, body);
  }
  const rows = await selectRows<MonthlyTaskRow>("feedback_monthly_link_tasks",
    "task_id,course_month,collection_month,student_name,teacher_canonical_name,course_names,student_response_id,parent_response_id,closed",
    { course_month: scope.courseMonth, student_record_id: scope.studentId });
  rows.sort((left, right) => left.teacher_canonical_name.localeCompare(right.teacher_canonical_name, "zh-CN"));
  if (rows.length === 0) return monthlyResponse(404, { error: "本月暂无需要评价的老师。如有疑问，请联系教务。" });
  const feedback = monthlyFeedback(rows, new Date());
  if (input.taskId === undefined) return monthlyResponse(200, feedback);
  if (input.action !== "confirm" && input.action !== "submit") return monthlyResponse(409, { error: "请刷新页面后重试。" });
  const task = rows.find((row) => row.task_id === input.taskId);
  if (!task) return monthlyResponse(409, { error: "老师名单已更新，请重新打开链接。" });
  const teacher = feedback.teachers.find((entry) => entry.id === task.task_id)!;
  async function confirmedResponse() {
    if (input.includeThanks === true && !feedback.closed) {
      try {
        return monthlyResponse(200, { ...feedback, thanks: await thanksOptions(db(), teacher.id) });
      } catch {
        // A catalog outage must not block confirmation of an already submitted evaluation.
        console.error("[feedback-api] thanks catalog unavailable");
      }
    }
    return monthlyResponse(200, feedback);
  }
  if (input.action === "submit") {
    const student = input.identity === STUDENT_IDENTITY;
    // A retry after a lost response finds the answer already bound and succeeds without writing twice.
    if (student ? teacher.studentDone : input.identity === PARENT_IDENTITY && teacher.parentDone) return confirmedResponse();
    if (feedback.closed) return monthlyResponse(409, { error: "本月反馈已结束。" });
    const built = answerFields(task, input.identity, input.answers);
    if ("error" in built) return monthlyResponse(400, built);
    const { client, config } = feishu();
    const live = await liveResponseFields(client, config);
    // Feishu rejects unknown field names, so those are dropped; an unknown option would be silently created, which the drift alert reports.
    const fields = Object.fromEntries(Object.entries(built.fields).filter(([name]) => live.some((field) => field.field_name === name)));
    const record = await client.createRecord({ appToken: config.feedbackAppToken, tableId: config.responseTableId, fields });
    const confirmation = await db().rpc<{ student_done: boolean; parent_done: boolean }>("confirm_monthly_feedback", {
      p_task_id: task.task_id, p_record_id: record.record_id,
      p_identity: student ? "student" : "parent", p_submitted_at: new Date().toISOString(),
    });
    if (confirmation.error || !confirmation.data?.[0]) throw new Error("确认月度答卷失败");
    teacher.studentDone = confirmation.data[0].student_done;
    teacher.parentDone = confirmation.data[0].parent_done;
    return confirmedResponse();
  }
  if ((teacher.studentDone && input.studentDone !== true) || (teacher.parentDone && input.parentDone !== true)
    || (teacher.studentDone && teacher.parentDone)) return confirmedResponse();
  if (feedback.closed) return monthlyResponse(409, { error: "本月反馈已结束。" });
  const { client, config } = feishu();
  const fields = { 学生姓名: task.student_name, 老师姓名: task.teacher_canonical_name, [FEEDBACK_MONTH_FIELD]: task.course_month };
  const records = await client.searchRecords({ appToken: config.feedbackAppToken, tableId: config.responseTableId,
    fieldNames: [...Object.keys(fields), "身份", "提交时间"], filter: {
      conjunction: "and", conditions: Object.entries(fields).map(([field_name, value]) => ({ field_name, operator: "is", value: [value] })),
    } });
  const answers = records.map((record) => readMonthlyFeishuAnswer(task, record)).filter((answer) => answer !== null)
    .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt));
  let confirmed = false;
  for (const answer of answers) {
    const student = answer.identity === STUDENT_IDENTITY;
    if (student ? teacher.studentDone : teacher.parentDone) continue;
    const confirmation = await db().rpc<{ student_done: boolean; parent_done: boolean }>("confirm_monthly_feedback", {
      p_task_id: task.task_id, p_record_id: answer.recordId,
      p_identity: student ? "student" : "parent", p_submitted_at: answer.submittedAt,
    });
    if (confirmation.error || !confirmation.data?.[0]) throw new Error("确认月度答卷失败");
    teacher.studentDone = confirmation.data[0].student_done;
    teacher.parentDone = confirmation.data[0].parent_done;
    confirmed = true;
  }
  if (confirmed) return confirmedResponse();
  return monthlyResponse(409, { error: "暂未查到新答卷。请先在飞书点「提交」，再回来确认。" });
}

// shortcut: per warm instance cache and alert dedupe; a cold start may resend the same alert, fine while drift is rare.
let fieldCache: { at: number; fields: FeishuField[] } | undefined;
const alerted = new Set<string>();

/** 读答卷表字段（10 分钟缓存），顺带比对写死的题目；对不上时私信 FORM_ALERT_OPEN_IDS（开发徐翰超）。 */
async function liveResponseFields(client: FeishuClient, config: FeishuConfig): Promise<FeishuField[]> {
  if (fieldCache && Date.now() - fieldCache.at < 600_000) return fieldCache.fields;
  const fields = await client.listAllFields({ appToken: config.feedbackAppToken, tableId: config.responseTableId });
  fieldCache = { at: Date.now(), fields };
  const drift = formDrift(fields);
  const signature = drift.join("\n");
  if (drift.length && !alerted.has(signature)) {
    alerted.add(signature);
    console.error("[feedback-api] 问卷和飞书答卷表对不上", signature);
    const text = `【月度反馈】菁仕问卷页面和飞书答卷表对不上，答卷仍照常写入：\n${drift.slice(0, 20).map((line) => "· " + line).join("\n")}`
      + `${drift.length > 20 ? `\n……共 ${drift.length} 处` : ""}\n请改 src/domain/monthly-questions.ts，跑 npm run check:questions，再部署 feedback-api 和学生页。`;
    for (const openId of (process.env.FORM_ALERT_OPEN_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean)) {
      await client.sendMessage({ receiveIdType: "open_id", receiveId: openId, msgType: "text", content: { text } })
        .catch((error) => console.error("[feedback-api] 问卷告警发送失败", error instanceof FeishuApiError ? error.code : error));
    }
  }
  return fields;
}

async function handleFeishuWebhook(event: HttpEvent) {
  const raw = decodeBody(event);
  const verified = verifyFeishuEvent({
    body: raw,
    headers: event.headers ?? {},
    encryptKey: process.env.FEISHU_EVENT_ENCRYPT_KEY,
    verificationToken: process.env.FEISHU_EVENT_VERIFICATION_TOKEN,
  });
  if (!verified.ok) return jsonResponse(401, { ok: false, error: verified.reason });
  if (verified.challenge) return jsonResponse(200, { challenge: verified.challenge });

  const { client, config } = feishu();
  // 订阅的是整个多维表格，其他表（统计表、学员信息…）的改动直接忽略。
  const tableId = verified.payload?.event?.table_id;
  const recordIds = extractRecordIds(verified.payload);
  if ((tableId && tableId !== config.responseTableId) || recordIds.length === 0) return jsonResponse(200, { ok: true, ignored: true });

  // 事件里的业务字段不可信，只拿 record id，回读整张答卷表后按轮次全量对账（幂等，飞书重推也没关系）。
  // 受影响的轮次 = 这些答卷现在属于的那轮 + 库里原来记的那轮（删掉的、改了月份的要回原来那轮腾位置）。
  const snapshotStartedAt = new Date().toISOString();
  const records = await listResponseRecords(client, config);
  const ids = new Set(recordIds);
  const rounds = new Set(await repository().listResponseMonths(recordIds));
  for (const record of records) {
    if (!ids.has(record.record_id)) continue;
    try {
      rounds.add(collectionMonthOf(parseFeedbackResponse(record)));
    } catch {
      // 字段坏了的答卷在全量对账里会标 exception，这里不用管它属于哪轮。
    }
  }
  const results = [];
  for (const collectionMonth of rounds) {
    results.push(summarize(await reconcileResponses({ client, config, repository: repository(), collectionMonth, records, snapshotStartedAt })));
  }
  // 不在这里定稿：定稿要重读整张课表（约 40 秒），飞书要求 3 秒内回 200，交给每日定时任务。
  const scores = await recomputeRounds(rounds);
  return jsonResponse(200, { ok: true, rounds: results, scores });
}

function extractRecordIds(payload: FeishuEventEnvelope | undefined): string[] {
  const list = payload?.event?.action_list ?? [];
  return [
    ...new Set(
      list
        .map((action) => action.record_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

function summarize(result: {
  collectionMonth: string;
  monthTotal: number;
  tasksCovered: number;
  matched: number;
  duplicate: number;
  unlinked: number;
  exception: number;
  removed: number;
}) {
  return {
    responseMonth: result.collectionMonth,
    monthTotal: result.monthTotal,
    matched: result.matched,
    duplicate: result.duplicate,
    unlinked: result.unlinked,
    exception: result.exception,
    tasksCovered: result.tasksCovered,
    removed: result.removed,
  };
}

// ---------- 官网老师数据（jsjy.asia/teachers 服务器每天取一次；有月份定稿时 refreshSite 通知它马上取） ----------

/** 只认带 SITE_API_KEY 的请求（官网服务器端），返回已定稿月份的累计评分和课堂体验，不含学生信息。 */
async function handleSiteTeachers(event: HttpEvent) {
  const key = process.env.SITE_API_KEY ?? "";
  if (key.length < 32 || !safeEqual(headerValue(event.headers ?? {}, "x-site-key"), key)) return jsonResponse(401, { ok: false, error: "UNAUTHORIZED" });
  const rows = await selectRows<ScoreResultRow>(SCORE_RESULTS_TABLE, "course_month,status,source,teachers,preferences", { status: "final" });
  return jsonResponse(200, { ok: true, generatedAt: new Date().toISOString(), ...buildTeacherStats(rows) });
}

// ---------- 飞书登录（教务网站共用，详见 src/server/feishu-login.ts） ----------

type AdminRow = { user_id: string; feishu_open_id: string | null; display_name: string | null; active: boolean };

const loginSecret = () => requireEnv("PUBLIC_TOKEN_PEPPER");
const loginCallbackUrl = () => `${requireEnv("FEISHU_LOGIN_BASE_URL").replace(/\/$/, "")}/feishu/callback`;

/** 签自定义登录 ticket 要用控制台下载的「自定义登录私钥」，和业务用的 app 分开初始化。 */
let ticketApp: ReturnType<typeof cloudbase.init> | undefined;
function createTicket(openId: string): string {
  // 部署脚本把私钥 JSON 转成 base64 放进环境变量
  const credentials = JSON.parse(Buffer.from(requireEnv("CLOUDBASE_LOGIN_KEY"), "base64").toString("utf8"));
  ticketApp ??= cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV, credentials });
  return ticketApp.auth().createTicket(customUserId(openId));
}

async function adminByOpenId(openId: string): Promise<AdminRow | undefined> {
  const result = await db().from("feedback_admins").select<AdminRow>("user_id,feishu_open_id,display_name,active").eq("feishu_open_id", openId).eq("active", true).limit(1);
  if (result.error) throw new Error(`读取管理员白名单失败：${result.error.message}`);
  return result.data?.[0];
}

function handleLoginStart(event: HttpEvent) {
  const next = safeNext(event.queryStringParameters?.next, parseOrigins(process.env.LOGIN_ALLOWED_ORIGINS));
  if (!next) return loginPage(400, "登录地址不正确", "请从教务网站的登录页点「用飞书登录」。");
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.searchParams.set("client_id", requireEnv("FEISHU_APP_ID"));
  url.searchParams.set("redirect_uri", loginCallbackUrl());
  url.searchParams.set("state", seal({ next }, loginSecret()));
  return { statusCode: 302, headers: { location: url.href, "cache-control": "no-store" }, body: "" };
}

async function feishuUser(code: string): Promise<{ openId: string; name: string }> {
  const tokenResponse = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: requireEnv("FEISHU_APP_ID"),
      client_secret: requireEnv("FEISHU_APP_SECRET"),
      code,
      redirect_uri: loginCallbackUrl(),
    }),
  });
  const token = (await tokenResponse.json()) as { code?: number; access_token?: string; error_description?: string; msg?: string };
  if (token.code !== 0 || !token.access_token) throw new Error(`飞书换取用户凭证失败：${token.error_description ?? token.msg ?? token.code}`);
  const infoResponse = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { authorization: `Bearer ${token.access_token}` } });
  const info = (await infoResponse.json()) as { code?: number; msg?: string; data?: { open_id?: string; name?: string } };
  if (info.code !== 0 || !info.data?.open_id) throw new Error(`飞书用户信息获取失败：${info.msg ?? info.code}`);
  return { openId: info.data.open_id, name: info.data.name ?? "" };
}

async function handleLoginCallback(event: HttpEvent) {
  const query = event.queryStringParameters ?? {};
  const state = unseal<{ next: string }>(query.state ?? "", loginSecret());
  if (!state?.next) return loginPage(400, "登录链接已过期", "请回到教务网站，重新点「用飞书登录」。");
  if (!query.code) return loginPage(400, "没有完成授权", "需要同意飞书授权才能登录。", state.next);
  const user = await feishuUser(query.code);
  if (!(await adminByOpenId(user.openId))) await grantAccess(user);
  const bindToken = seal({ openId: user.openId }, loginSecret());
  return { statusCode: 302, headers: { location: loginRedirect(state.next, createTicket(user.openId), bindToken), "cache-control": "no-store" }, body: "" };
}

/**
 * 飞书应用「排课机器人」的可用范围是全员，能走完飞书授权的就是本企业成员，直接开通（用户 2026-10-19 决定）。
 * 新账号的 role 走表默认值 teacher（只能看问卷跟踪）；upsert 不带 role，已有账号的权限不会被改掉。
 * 要挡住某人：在飞书开发者后台把他移出可用范围；这里的 active=false 会在他下次登录时被改回 true。
 */
async function grantAccess(user: { openId: string; name: string }) {
  const result = await db()
    .from("feedback_admins")
    .upsert([{ user_id: customUserId(user.openId), feishu_open_id: user.openId, display_name: user.name, active: true }], { onConflict: "feishu_open_id" });
  if (result.error) throw new Error(`开通账号失败：${result.error.message}`);
}

/**
 * 网页用 ticket 登录 CloudBase 后立刻调用：把当前 CloudBase 用户 ID 写进这个飞书账号的白名单行。
 * 只认回调签发的 bindToken（10 分钟有效），所以别人拿不到别的管理员的权限。
 */
async function bindFeishu(bindToken: string | undefined) {
  const claim = unseal<{ openId: string }>(bindToken ?? "", loginSecret());
  if (!claim?.openId) throw new Error("登录已过期，请重新用飞书登录");
  let uid: string | undefined;
  try {
    const user = app.auth().getUserInfo();
    uid = user?.isAnonymous ? undefined : user?.uid;
  } catch {
    uid = undefined;
  }
  if (!uid) throw new Error("UNAUTHORIZED");
  const admin = await adminByOpenId(claim.openId);
  if (!admin) throw new Error("FORBIDDEN");
  if (admin.user_id !== uid) {
    const result = await db().from("feedback_admins").update({ user_id: uid }).eq("feishu_open_id", claim.openId);
    if (result.error) throw new Error(`绑定管理员失败：${result.error.message}`);
  }
  return { ok: true };
}

/** 上海时区的当前月份，Webhook 和未指定月份的刷新用它当默认收集月份。 */
function currentShanghaiMonth(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export async function main(event: HttpEvent & CallEvent & TimerEvent) {
  const isHttp = typeof event.httpMethod === "string";
  try {
    // ---- 每日定时对账（cloudbaserc.json 的 timer 触发器）----
    if (event.Type === "Timer") {
      const { results, scores } = await syncRounds(openRounds());
      const summary = { ok: true, rounds: results.map(summarize), scores };
      console.log("[feedback-api] 定时对账", JSON.stringify(summary));
      return summary;
    }

    // ---- HTTP 入口 ----
    // CloudBase HTTP 访问服务会把注册的服务路径（/t、/webhooks、/auth、/site）从 event.path 里剥掉，
    // 且 requestContext 里没有原始路径，所以这里按「方法 + 剩余路径形状」区分公开端点。
    // 登录用两段路径（/feishu/start），不会和单段的扫码 token 撞上。
    if (isHttp) {
      const path = (event.path ?? "").replace(/^\/(t|webhooks|auth|site)(?=\/)/, "");
      if (event.httpMethod === "POST" && path === "/monthly-feedback") {
        try {
          return await handleMonthlyFeedback(event);
        } catch (error) {
          console.error("[feedback-api] monthly feedback failure", error instanceof FeishuApiError ? error.code : undefined);
          return monthlyResponse(500, { error: "暂时无法确认，请重试。" });
        }
      }
      if (event.httpMethod === "GET" && path === "/teachers/stats") return await handleSiteTeachers(event);
      if (event.httpMethod === "GET" && path === "/feishu/start") return handleLoginStart(event);
      if (event.httpMethod === "GET" && path === "/feishu/callback") {
        try {
          return await handleLoginCallback(event);
        } catch (error) {
          console.error("[feedback-api] 飞书登录", error instanceof Error ? error.message : error);
          return loginPage(500, "登录失败", "飞书暂时没有响应，请回到教务网站重试。");
        }
      }
      if (event.httpMethod === "POST") {
        if (path === "/feishu" || path === "/") return handleFeishuWebhook(event);
        return jsonResponse(404, { ok: false, error: "NOT_FOUND" });
      }
      if (event.httpMethod === "GET") {
        // 在浏览器里打开 /webhooks/feishu 是常见的"看看通没通"，别把它当成扫码 token，
        // 否则会显示"问卷链接无效"，看起来像回调配错了。
        if (path === "/feishu") {
          return jsonResponse(200, {
            ok: true,
            endpoint: "feishu-webhook",
            hint: "这个地址只接受飞书事件的 POST 请求，直接用浏览器打开看到这段说明就说明它是通的。",
          });
        }
        const token = /^\/([^/?]+)\/?$/.exec(path)?.[1];
        if (token) return handlePublicRedirect(decodeURIComponent(token));
        return jsonResponse(404, { ok: false, error: "NOT_FOUND" });
      }
      return jsonResponse(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    }

    // ---- 教务前端 callFunction ----
    // 刚用飞书登录时 user_id 还没绑定，assertAdmin 必然失败，所以绑定放在它前面。
    if (event.action === "bind-feishu") return await bindFeishu(event.bindToken);
    const { uid, role } = await assertMember();
    if (ADMIN_ACTIONS.has(event.action ?? "") && !canViewDetail(role)) throw new Error("FORBIDDEN_ROLE");
    switch (event.action) {
      case "monthly-feedback-links": {
        const month = event.courseMonth;
        const ids = event.studentIds;
        if (!month || !isMonth(month) || !Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every(isMonthlyStudentId)) {
          throw new Error("学生或月份参数有误");
        }
        const tasks = await db().from(TASKS_TABLE).select<{ student_record_id: string }>("student_record_id")
          .eq("course_month", month).in("student_record_id", [...new Set(ids)]);
        if (tasks.error) throw new Error("读取学生月度任务失败");
        const pepper = requireEnv("PUBLIC_TOKEN_PEPPER");
        return { ok: true, tokens: Object.fromEntries([...new Set((tasks.data ?? []).map((task) => task.student_record_id))].map((studentRecordId) => [
          monthlyTaskKey({ courseMonth: month, studentRecordId }), monthlyLinkToken(month, studentRecordId, pepper),
        ])) };
      }
      case "sync-tasks": {
        if (!event.collectionMonth) throw new Error("缺少 collectionMonth");
        const { client, config } = feishu();
        const result = await generateMonthlyTasks({
          client,
          config,
          repository: repository(),
          collectionMonth: event.collectionMonth,
          publicTokenPepper: requireEnv("PUBLIC_TOKEN_PEPPER"),
          dryRun: event.dryRun,
        });
        const { plan: _plan, ...summary } = result;
        const scores = event.dryRun ? {} : { [result.courseMonth]: await recompute(result.courseMonth) };
        return { ok: true, actorId: uid, ...summary, scores };
      }
      case "sync-responses": {
        // 工作台传当前查看的那一轮；老师评分页不传，对账所有还在收集的轮次。
        const { results, scores } = await syncRounds(event.collectionMonth ? [event.collectionMonth] : openRounds());
        const [result] = results;
        return { ok: true, actorId: uid, ...summarize(result), outcomes: result.outcomes, scores };
      }
      case "recompute-scores": {
        // 改了别名等口径后手动重算某月（已定稿的月份也会重算）。
        if (!event.courseMonth) throw new Error("缺少 courseMonth");
        return { ok: true, scores: { [event.courseMonth]: await recompute(event.courseMonth, { force: true }) } };
      }
      case "publish-scores": {
        if (!event.courseMonth) throw new Error("缺少 courseMonth");
        const { outcome, siteRefreshed } = await publishMonth(event.courseMonth, uid);
        return { ok: true, scores: { [event.courseMonth]: outcome }, siteRefreshed };
      }
      case "export-schedule-csv": {
        if (!event.collectionMonth) throw new Error("缺少 collectionMonth");
        const courseMonth = collectionMonthToCourseMonth(event.collectionMonth);
        const { client, config } = feishu();
        const [records, students] = await Promise.all([
          client.listAllRecords({ appToken: config.scheduleAppToken, tableId: config.scheduleTableId }),
          client.listAllRecords({ appToken: config.scheduleAppToken, tableId: config.studentTableId }),
        ]);
        const studentNamesByRecordId = new Map<string, string>();
        for (const record of students) {
          try {
            const student = parseStudentRecord(record);
            studentNamesByRecordId.set(student.recordId, student.name);
          } catch {
            // 姓名缺失的学生在导出里留空，由老师反馈系统的缺字段统计接手。
          }
        }
        return {
          ok: true,
          fileName: `课表-${courseMonth}.csv`,
          csv: buildScheduleCsv({ records, courseMonth, studentNamesByRecordId }),
        };
      }
      case "export-feedback-csv": {
        if (!event.collectionMonth) throw new Error("缺少 collectionMonth");
        const { client, config } = feishu();
        const records = await client.listAllRecords({
          appToken: config.feedbackAppToken,
          tableId: config.responseTableId,
        });
        return {
          ok: true,
          fileName: `反馈-${event.collectionMonth}.csv`,
          csv: buildFeedbackCsv({ records, collectionMonth: event.collectionMonth }),
        };
      }
      default:
        return { ok: false, error: `未知操作：${event.action ?? "(空)"}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // callFunction 必须回 { ok: false }：回 HTTP 形状的 { statusCode, body } 前端会当成功，显示「新增 undefined」。
    const denied =
      message === "UNAUTHORIZED"
        ? "请先登录"
        : message === "FORBIDDEN"
          ? "当前账号没有开通，请用飞书重新登录"
          : message === "FORBIDDEN_ROLE"
            ? "没有权限，请联系超级管理员开通"
            : null;
    if (denied) return isHttp ? jsonResponse(message === "UNAUTHORIZED" ? 401 : 403, { ok: false, error: denied }) : { ok: false, error: denied };
    console.error("[feedback-api]", message);
    // 不把飞书原始报文或密钥回传给调用方。
    // HTTP 入口必须回 { statusCode, body }，否则网关会把它当成函数崩溃返回 500。
    if (isHttp) return jsonResponse(500, { ok: false, error: "INTERNAL_ERROR" });
    return { ok: false, error: message };
  }
}
