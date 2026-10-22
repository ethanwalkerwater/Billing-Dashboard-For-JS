/**
 * feedback-api —— 月度课程反馈问卷跟踪系统唯一的云函数。
 *
 * 两种入口：
 *  1. 教务前端 `app.callFunction({ name: 'feedback-api', data: { action } })`，带 CloudBase 登录身份；
 *  2. HTTP 触发：`GET /t/:token` 学生扫码跳转、`POST /webhooks/feishu` 答卷事件。
 *
 * 答卷怎么进库：飞书答卷表有变化时推事件（Webhook），只处理受影响的那几轮；每天凌晨定时对账一次兜底
 * （漏掉的事件、到期定稿）；工作台「刷新反馈」手动补一次。打开工作台只读库，不再每次去飞书拉。
 *
 * 任务列表、筛选、改状态和导出都由前端经 PostgREST + RLS 直接读写 feedback_tasks，
 * 不走这个函数——函数只负责需要飞书密钥或公开访问的那几件事。
 */
import cloudbase from "@cloudbase/node-sdk";

import { collectionMonthToCourseMonth, courseMonthToCollectionMonth, shiftMonth } from "../../src/domain/month";
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
import { verifyFeishuEvent } from "./feishu-event";
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

interface CallEvent {
  action?: string;
/** CloudBase 定时触发器的事件：{ Type: "Timer", TriggerName, Time } */
interface TimerEvent {
  Type?: string;
  TriggerName?: string;
}

  collectionMonth?: string;
  /** recompute-scores：手动重算的课程月份 */
  courseMonth?: string;
  dryRun?: boolean;
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
};

async function computeScores(request: ScoreRequest): Promise<ScoreResponse> {
  const response = await app.callFunction({ name: "feedback-score", data: request as never });
  frozenLessons: async (collectionMonth) =>
    (await repository().listByCollectionMonth(collectionMonth))
      .filter(isFrozen)
      .map((task) => ({ studentName: task.studentName, teacherName: task.teacherCanonicalName, lessons: task.lessons ?? [] })),
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

function repository() {
  return new RdbFeedbackTaskRepository(db());
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
  });
  return { statusCode: 302, headers: { location: target, "cache-control": "no-store" }, body: "" };
}

    courseMonth: task.courseMonth,
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

/** 上海时区的当前月份，Webhook 和未指定月份的刷新用它当默认收集月份。 */
function currentShanghaiMonth(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export async function main(event: HttpEvent & CallEvent & TimerEvent) {
  const isHttp = typeof event.httpMethod === "string";
  try {
    // ---- HTTP 入口 ----
    // CloudBase HTTP 访问服务会把注册的服务路径（/t、/webhooks）从 event.path 里剥掉，
    // 且 requestContext 里没有原始路径，所以这里按「方法 + 剩余路径形状」区分两个公开端点。
    if (isHttp) {
      const path = (event.path ?? "").replace(/^\/(t|webhooks)(?=\/)/, "");
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
    if (message === "UNAUTHORIZED") return jsonResponse(401, { ok: false, error: "请先登录" });
    if (message === "FORBIDDEN") return jsonResponse(403, { ok: false, error: "当前账号不在管理员白名单" });
    console.error("[feedback-api]", message);
    // 不把飞书原始报文或密钥回传给调用方。
    // HTTP 入口必须回 { statusCode, body }，否则网关会把它当成函数崩溃返回 500。
    // ---- 每日定时对账（cloudbaserc.json 的 timer 触发器）----
    if (event.Type === "Timer") {
      const { results, scores } = await syncRounds(openRounds());
      const summary = { ok: true, rounds: results.map(summarize), scores };
      console.log("[feedback-api] 定时对账", JSON.stringify(summary));
      return summary;
    }

    if (isHttp) return jsonResponse(500, { ok: false, error: "INTERNAL_ERROR" });
    return { ok: false, error: message };
  }
}
