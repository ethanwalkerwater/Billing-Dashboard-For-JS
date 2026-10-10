/**
 * cancel-api —— 学生自助取消课程的云函数（HTTP 访问服务路径 /cancel-api）。
 *
 *   GET  /lessons?t=<token>      选课页：该学生正在上和接下来 14 天的课 + 实时收费提示
 *   POST /intent  {t, recordId}  生成一次性取消编号，返回预填好的飞书问卷链接
 *   POST /webhooks/feishu        「取消申请」表新增记录事件 → 核验、写课表、通知
 *
 * 教务工作台 callFunction：ensure-links（为新学生生成链接，需管理员登录）。
 *
 * 用独立的飞书应用（机器人「课表分析」），密钥只经 cancel.env 注入函数环境变量。
 */
import { randomBytes } from "node:crypto";

import cloudbase from "@cloudbase/node-sdk";

import { formatLessonTime } from "../../src/cancellation/messages";
import { tierLabel } from "../../src/cancellation/service";
import {
  CancellationError,
  createIntent,
  listLessonsForLink,
  processRequest,
} from "../../src/cancellation/service";
import type { CancellationDeps } from "../../src/cancellation/service";
import { createFeishuCancellationAdapters } from "../../src/server/cancellation/feishu";
import { ensureLinks, listStudents } from "../../src/server/cancellation/links";
import { createCancellationStore } from "../../src/server/cancellation/store";
import { FeishuClient } from "../../src/server/feishu/client";
import { verifyFeishuEvent } from "../feedback-api/feishu-event";
import type { FeishuEventEnvelope } from "../feedback-api/feishu-event";
import { createServiceDb } from "../feedback-api/service-db";

interface HttpEvent {
  path?: string;
  httpMethod?: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

let cachedDb: ReturnType<typeof createServiceDb> | undefined;
function db() {
  cachedDb ??= createServiceDb({ envId: requireEnv("CLOUDBASE_ENV_ID"), apiKey: requireEnv("CLOUDBASE_API_KEY") });
  return cachedDb;
}

let cachedClient: FeishuClient | undefined;
function feishuClient() {
  cachedClient ??= new FeishuClient({ appId: requireEnv("FEISHU_APP_ID"), appSecret: requireEnv("FEISHU_APP_SECRET") });
  return cachedClient;
}

/** 与 feedback-api 相同：登录用户必须在 feedback_admins 白名单里 */
async function assertAdmin(): Promise<void> {
  let uid: string | undefined;
  try {
    const user = app.auth().getUserInfo();
    uid = user?.isAnonymous ? undefined : user?.uid;
  } catch {
    uid = undefined;
  }
  if (!uid) throw new Error("UNAUTHORIZED");
  const result = await db().from("feedback_admins").select<{ user_id: string }>("user_id").eq("user_id", uid).eq("active", true);
  if (!result.data?.length) throw new Error("FORBIDDEN");
}

let cachedDeps: CancellationDeps | undefined;
function deps(): CancellationDeps {
  if (cachedDeps) return cachedDeps;
  const client = feishuClient();
  const feishu = createFeishuCancellationAdapters(client, {
    scheduleAppToken: requireEnv("CANCEL_SCHEDULE_APP_TOKEN"),
    scheduleTableId: requireEnv("CANCEL_SCHEDULE_TABLE_ID"),
    requestAppToken: requireEnv("CANCEL_REQUEST_APP_TOKEN"),
    requestTableId: requireEnv("CANCEL_REQUEST_TABLE_ID"),
  });
  const groupChatId = requireEnv("CANCEL_GROUP_CHAT_ID");
  cachedDeps = {
    now: () => Date.now(),
    randomId: () => randomBytes(12).toString("base64url"),
    formUrl: requireEnv("CANCEL_FORM_URL"),
    ...createCancellationStore(db()),
    ...feishu,
    notify: {
      user: (openId, card) => client.sendMessage({ receiveIdType: "open_id", receiveId: openId, msgType: "interactive", content: card }),
      group: (card) => client.sendMessage({ receiveIdType: "chat_id", receiveId: groupChatId, msgType: "interactive", content: card }),
    },
  };
  return cachedDeps;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function decodeBody(event: HttpEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

async function handleLessons(token: string) {
  const { studentName, lessons, nowMs } = await listLessonsForLink(deps(), token);
  return jsonResponse(200, {
    ok: true,
    studentName,
    nowMs,
    lessons: lessons.map(({ lesson, status, preview }) => ({
      recordId: lesson.recordId,
      courseName: lesson.courseName,
      teacherName: lesson.teacherName,
      timeLabel: formatLessonTime(lesson),
      startMs: lesson.startMs,
      endMs: lesson.endMs,
      status,
      cancellation: lesson.cancellation,
      previewTier: preview.tier,
      previewText: tierLabel(preview.tier),
    })),
  });
}

async function handleIntent(event: HttpEvent) {
  let input: { t?: string; recordId?: string };
  try {
    input = JSON.parse(decodeBody(event) || "{}");
  } catch {
    return jsonResponse(400, { ok: false, error: "BAD_JSON" });
  }
  if (!input.t || !input.recordId) return jsonResponse(400, { ok: false, error: "缺少参数" });
  const result = await createIntent(deps(), input.t, input.recordId);
  return jsonResponse(200, { ok: true, ...result });
}

function extractRecordIds(payload: FeishuEventEnvelope | undefined, tableId: string): string[] {
  const event = payload?.event as { table_id?: string; action_list?: Array<{ record_id?: string; action?: string }> } | undefined;
  if (event?.table_id && event.table_id !== tableId) return [];
  return [
    ...new Set(
      (event?.action_list ?? [])
        .filter((action) => action.action === "record_added")
        .map((action) => action.record_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

async function handleWebhook(event: HttpEvent) {
  const verified = verifyFeishuEvent({
    body: decodeBody(event),
    headers: event.headers ?? {},
    encryptKey: process.env.FEISHU_EVENT_ENCRYPT_KEY,
    verificationToken: process.env.FEISHU_EVENT_VERIFICATION_TOKEN,
  });
  if (!verified.ok) return jsonResponse(401, { ok: false, error: verified.reason });
  if (verified.challenge) return jsonResponse(200, { challenge: verified.challenge });
  const results = [];
  for (const recordId of extractRecordIds(verified.payload, requireEnv("CANCEL_REQUEST_TABLE_ID"))) {
    results.push({ recordId, ...(await processRequest(deps(), recordId)) });
  }
  return jsonResponse(200, { ok: true, results });
}

export async function main(event: HttpEvent & { action?: string; recordId?: string }) {
  try {
    if (typeof event.httpMethod !== "string") {
      // 运维补处理：tcb fn invoke cancel-api --params '{"action":"process","recordId":"rec..."}'
      if (event.action === "process" && event.recordId) return await processRequest(deps(), event.recordId);
      if (event.action === "ensure-links") {
        await assertAdmin();
        const students = await listStudents(feishuClient(), {
          appToken: requireEnv("CANCEL_SCHEDULE_APP_TOKEN"),
          studentTableId: requireEnv("CANCEL_STUDENT_TABLE_ID"),
        });
        const result = await ensureLinks(db(), students);
        return { ok: true, created: result.created.length, existing: result.existing, names: result.created.map((row) => row.studentName) };
      }
      return { ok: false, error: "UNKNOWN_ACTION" };
    }
    // HTTP 访问服务会剥掉注册路径 /cancel-api
    const path = (event.path ?? "").replace(/^\/cancel-api(?=\/|$)/, "").replace(/\/$/, "") || "/";
    if (event.httpMethod === "GET" && path === "/lessons") return await handleLessons(event.queryStringParameters?.t ?? "");
    if (event.httpMethod === "POST" && path === "/intent") return await handleIntent(event);
    if (path === "/webhooks/feishu") {
      if (event.httpMethod === "POST") return await handleWebhook(event);
      return jsonResponse(200, { ok: true, endpoint: "cancel-webhook", hint: "这个地址只接受飞书事件的 POST 请求。" });
    }
    return jsonResponse(404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    if (typeof event.httpMethod !== "string") return { ok: false, error: error instanceof Error ? error.message : String(error) };
    if (error instanceof CancellationError) {
      return jsonResponse(error.code === "INVALID_LINK" ? 403 : 409, { ok: false, error: error.code, message: error.message });
    }
    console.error(error);
    return jsonResponse(500, { ok: false, error: "INTERNAL", message: "服务暂时不可用，请稍后重试或联系教务" });
  }
}
