/**
 * feedback-api —— 月度课程反馈问卷跟踪系统唯一的云函数。
 *
 * 两种入口：
 *  1. 教务前端 `app.callFunction({ name: 'feedback-api', data: { action } })`，带 CloudBase 登录身份；
 *  2. HTTP 触发：`GET /t/:token` 学生扫码跳转、`POST /webhooks/feishu` 答卷事件、定时对账。
 *
 * 任务列表、筛选、改状态和导出都由前端经 PostgREST + RLS 直接读写 feedback_tasks，
 * 不走这个函数——函数只负责需要飞书密钥或公开访问的那几件事。
 */
import cloudbase from "@cloudbase/node-sdk";

import { collectionMonthToCourseMonth } from "../../src/domain/month";
import { buildPrefilledFormUrl } from "../../src/domain/form-url";
import { buildFeedbackCsv, buildScheduleCsv } from "../../src/server/export/csv";
import { FeishuClient } from "../../src/server/feishu/client";
import { loadFeishuConfig } from "../../src/server/feishu/config";
import { parseStudentRecord } from "../../src/server/feishu/parsers";
import { generateMonthlyTasks } from "../../src/server/sync/generate-tasks";
import { reconcileResponses } from "../../src/server/sync/reconcile-responses";
import { RdbFeedbackTaskRepository } from "../../src/shared/rdb";
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
  collectionMonth?: string;
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

  const recordIds = extractRecordIds(verified.payload);
  const { client, config } = feishu();
  // 事件里的业务字段不可信，只拿 record id 回读飞书原始记录。
  const result = await reconcileResponses({
    client,
    config,
    repository: repository(),
    // 事件推的是刚提交的答卷，按提交时间归到当前收集月份。
    collectionMonth: currentShanghaiMonth(),
    onlyRecordIds: recordIds.length > 0 ? recordIds : undefined,
  });
  return jsonResponse(200, { ok: true, ...summarize(result) });
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
}) {
  return {
    responseMonth: result.collectionMonth,
    monthTotal: result.monthTotal,
    matched: result.matched,
    duplicate: result.duplicate,
    unlinked: result.unlinked,
    exception: result.exception,
    tasksCovered: result.tasksCovered,
  };
}

/** 上海时区的当前月份，定时对账用它当默认收集月份。 */
function currentShanghaiMonth(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

export async function main(event: HttpEvent & CallEvent) {
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

    // ---- 定时触发：每 5 分钟补偿对账 ----
    if ((event as { Type?: string }).Type === "Timer" || event.action === "sync-responses-timer") {
      const { client, config } = feishu();
      const result = await reconcileResponses({
        client,
        config,
        repository: repository(),
        collectionMonth: currentShanghaiMonth(),
      });
      return { ok: true, ...summarize(result) };
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
        return { ok: true, actorId: uid, ...summary };
      }
      case "sync-responses": {
        const { client, config } = feishu();
        const result = await reconcileResponses({
          client,
          config,
          repository: repository(),
          collectionMonth: event.collectionMonth ?? currentShanghaiMonth(),
        });
        return { ok: true, actorId: uid, ...summarize(result), outcomes: result.outcomes };
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
    if (isHttp) return jsonResponse(500, { ok: false, error: "INTERNAL_ERROR" });
    return { ok: false, error: message };
  }
}
