/**
 * feedback-api —— 月度课程反馈问卷跟踪系统唯一的云函数。
 *
 * 两种入口：
 *  1. 教务前端 `app.callFunction({ name: 'feedback-api', data: { action } })`，带 CloudBase 登录身份；
 *  2. HTTP 触发：`GET /t/:token` 学生扫码跳转、`POST /webhooks/feishu` 答卷事件、
 *     `GET /auth/feishu/start|callback` 教务网站的飞书登录（反馈工作台、取消课程、雅思正向率共用）、
 *     `GET /site/teachers/stats` 官网服务器取老师累计评分和课堂体验（带 x-site-key）。
 *
 * 答卷怎么进库：飞书答卷表有变化时推事件（Webhook），只处理受影响的那几轮；每天凌晨定时对账一次兜底
 * （漏掉的事件、到期定稿）；工作台「刷新反馈」手动补一次。打开工作台只读库，不再每次去飞书拉。
 *
 * 任务列表、筛选、改状态和导出都由前端经 PostgREST + RLS 直接读写 feedback_tasks，
 * 不走这个函数——函数只负责需要飞书密钥或公开访问的那几件事。
 */
import cloudbase from "@cloudbase/node-sdk";

import { collectionMonthToCourseMonth, courseMonthToCollectionMonth, shiftMonth } from "../../src/domain/month";
import { customUserId, loginPage, loginRedirect, parseOrigins, safeNext, seal, unseal } from "../../src/server/feishu-login";
import { buildPrefilledFormUrl } from "../../src/domain/form-url";
import { buildFeedbackCsv, buildScheduleCsv } from "../../src/server/export/csv";
import { FeishuClient } from "../../src/server/feishu/client";
import { loadFeishuConfig } from "../../src/server/feishu/config";
import { parseStudentRecord } from "../../src/server/feishu/parsers";
import { generateMonthlyTasks } from "../../src/server/sync/generate-tasks";
import { collectionMonthOf, listResponseRecords, reconcileResponses } from "../../src/server/sync/reconcile-responses";
import { parseFeedbackResponse } from "../../src/server/feishu/parsers";
import { isFrozen } from "../../src/server/tasks/reconcile";
import type { FeishuRecord } from "../../src/server/feishu/types";
import { LIVE_SCORES_FROM, recomputeMonth } from "../../src/server/scores/recompute";
import type { PriorDetailRow, ScoreRequest, ScoreResponse, ScoreStore, StoredResult } from "../../src/server/scores/recompute";
import { RdbFeedbackTaskRepository, SCORE_RESULTS_TABLE, SNAPSHOTS_TABLE, TASKS_TABLE } from "../../src/shared/rdb";
import type { PostgrestLike } from "../../src/shared/rdb";
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
  /** recompute-scores：手动重算的课程月份 */
  courseMonth?: string;
  dryRun?: boolean;
  /** bind-feishu：飞书登录回跳时带回的签名凭证，证明这个 CloudBase 会话属于哪个飞书账号 */
  bindToken?: string;
}

let serviceDb: PostgrestLike | undefined;
function db(): PostgrestLike {
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
  detail: async (courseMonth) => (await selectRows<{ detail: PriorDetailRow[] }>(SCORE_RESULTS_TABLE, "detail", { course_month: courseMonth }))[0]?.detail,
  // 评分脚本会把老师名去空格、去「老师」后缀；用课表写法还原显示名（Valentina Lin、数学杨老师）。
  teacherNames: async () => [...new Set((await selectRows<{ teacher_canonical_name: string }>(TASKS_TABLE, "teacher_canonical_name")).map((row) => row.teacher_canonical_name))],
  frozenLessons: async (collectionMonth) =>
    (await repository().listByCollectionMonth(collectionMonth))
      .filter(isFrozen)
      .map((task) => ({ studentName: task.studentName, teacherName: task.teacherCanonicalName, lessons: task.lessons ?? [] })),
};

async function computeScores(request: ScoreRequest): Promise<ScoreResponse> {
  const response = await app.callFunction({ name: "feedback-score", data: request as never });
  return response.result as ScoreResponse;
}

function recompute(courseMonth: string, force = false) {
  return recomputeMonth({ store: scoreStore, compute: computeScores, courseMonth, currentMonth: currentShanghaiMonth(), force });
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
 * 课程月份 M 在 M+2 月初定稿（M+1 月过完，晚交的也收齐了），每月只发生一次。
 * 名单可能是 M 月中提前生成的，课表快照还是当时的计划，所以定稿前重新生成一次名单：
 * 没人评的任务跟上实际课表、课表快照换成实际上过的课（老师总课时用它）；评过的任务课时已定稿，不动。
 */
async function finalizeClosingMonth(records: FeishuRecord[]) {
  const closing = shiftMonth(currentShanghaiMonth(), -2);
  if (closing < LIVE_SCORES_FROM) return {};
  const stored = await scoreStore.result(closing);
  if (stored?.status === "final" || !(await scoreStore.snapshot("schedule", closing))) return {};
  const { client, config } = feishu();
  const collectionMonth = courseMonthToCollectionMonth(closing);
  await generateMonthlyTasks({ client, config, repository: repository(), collectionMonth, publicTokenPepper: requireEnv("PUBLIC_TOKEN_PEPPER") });
  await reconcileResponses({ client, config, repository: repository(), collectionMonth, records });
  return { [closing]: await recompute(closing) };
}

/** 全量对账这几轮（整张答卷表读一次），重算分数，顺带检查要不要定稿。工作台「刷新反馈」和每日定时任务用。 */
async function syncRounds(collectionMonths: string[]) {
  const { client, config } = feishu();
  const records = await listResponseRecords(client, config);
  const results = [];
  for (const collectionMonth of collectionMonths) {
    results.push(await reconcileResponses({ client, config, repository: repository(), collectionMonth, records }));
  }
  const scores = { ...(await recomputeRounds(collectionMonths)), ...(await finalizeClosingMonth(records)) };
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

/** 只放行已登录且在 feedback_admins 白名单里的教务。 */
async function assertAdmin(): Promise<string> {
  let uid: string | undefined;
  try {
    const user = app.auth().getUserInfo();
    uid = user?.isAnonymous ? undefined : user?.uid;
  } catch {
    uid = undefined;
  }
  if (!uid) throw new Error("UNAUTHORIZED");

  const result = await (
    db() as unknown as {
      from: (table: string) => {
        select: (columns: string) => {
          eq: (column: string, value: unknown) => {
            eq: (column: string, value: unknown) => PromiseLike<{ data: unknown[] | null }>;
          };
        };
      };
    }
  )
    .from("feedback_admins")
    .select("user_id")
    .eq("user_id", uid)
    .eq("active", true);
  if (!result.data || result.data.length === 0) throw new Error("FORBIDDEN");
  return uid;
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
    results.push(summarize(await reconcileResponses({ client, config, repository: repository(), collectionMonth, records })));
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

// ---------- 官网老师数据（jsjy.asia/teachers 服务器每小时取一次） ----------

/** 只认带 SITE_API_KEY 的请求（官网服务器端），返回已定稿月份的累计评分和课堂体验，不含学生信息。 */
async function handleSiteTeachers(event: HttpEvent) {
  const key = process.env.SITE_API_KEY ?? "";
  if (key.length < 32 || !safeEqual(headerValue(event.headers ?? {}, "x-site-key"), key)) return jsonResponse(401, { ok: false, error: "UNAUTHORIZED" });
  const rows = await selectRows<ScoreResultRow>(SCORE_RESULTS_TABLE, "course_month,status,source,teachers,preferences", { status: "final" });
  return jsonResponse(200, { ok: true, generatedAt: new Date().toISOString(), ...buildTeacherStats(rows) });
}

// ---------- 飞书登录（教务网站共用，详见 src/server/feishu-login.ts） ----------

type AdminRow = { user_id: string; feishu_open_id: string | null; active: boolean };

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
  const result = await db().from("feedback_admins").select<AdminRow>("user_id,feishu_open_id,active").eq("feishu_open_id", openId).eq("active", true).limit(1);
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
    const uid = await assertAdmin();
    switch (event.action) {
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
        return { ok: true, scores: { [event.courseMonth]: await recompute(event.courseMonth, true) } };
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
    const denied = message === "UNAUTHORIZED" ? "请先登录" : message === "FORBIDDEN" ? "当前账号不在管理员白名单，请用飞书重新登录" : null;
    if (denied) return isHttp ? jsonResponse(message === "UNAUTHORIZED" ? 401 : 403, { ok: false, error: denied }) : { ok: false, error: denied };
    console.error("[feedback-api]", message);
    // 不把飞书原始报文或密钥回传给调用方。
    // HTTP 入口必须回 { statusCode, body }，否则网关会把它当成函数崩溃返回 500。
    if (isHttp) return jsonResponse(500, { ok: false, error: "INTERNAL_ERROR" });
    return { ok: false, error: message };
  }
}
