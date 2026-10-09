/**
 * birthday-api —— 老师生日祝福（HTTP 访问服务路径 /birthday-api，定时触发 daily-9am）。
 *   定时触发（每天 09:00）                 runDaily
 *   tcb fn invoke {"action":"daily","today":"2026-10-12"}   手动补跑 / 模拟某天（会真的发送并写年份）
 *   tcb fn invoke {"action":"rehearse","teacher":"汤朔","step":"all"}   演练
 *   GET /birthday-api/page?t=<token>       网页数据
 */
import { FeishuClient } from "../../../course-feedback-tracker/src/server/feishu/client";
import { ymdToMs } from "../../src/domain/dates";
import { SCHEDULE_STAT_FIELDS, scheduleFilter } from "../../src/domain/stats";
import { WISH_FIELDS } from "../../src/domain/records";
import { createGenerate } from "../../src/server/ai";
import { pageData, rehearse, runDaily } from "../../src/server/service";
import type { BirthdayDeps } from "../../src/server/service";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

let cached: BirthdayDeps | undefined;
function deps(): BirthdayDeps {
  if (cached) return cached;
  const client = new FeishuClient({ appId: requireEnv("FEISHU_APP_ID"), appSecret: requireEnv("FEISHU_APP_SECRET") });
  const config = {
    teacherAppToken: requireEnv("TEACHER_APP_TOKEN"),
    teacherTableId: requireEnv("TEACHER_TABLE_ID"),
    wishTableId: requireEnv("WISH_TABLE_ID"),
    wishFormUrl: requireEnv("WISH_FORM_URL"),
    scheduleAppToken: requireEnv("SCHEDULE_APP_TOKEN"),
    scheduleTableId: requireEnv("SCHEDULE_TABLE_ID"),
    academicOpenIds: requireEnv("BIRTHDAY_ACADEMIC_OPEN_IDS").split(",").map((s) => s.trim()).filter(Boolean),
    groupChatId: requireEnv("BIRTHDAY_GROUP_CHAT_ID"),
    pageBaseUrl: requireEnv("PAGE_BASE_URL"),
    pepper: requireEnv("PAGE_TOKEN_PEPPER"),
  };
  const teacherTable = { appToken: config.teacherAppToken, tableId: config.teacherTableId };
  cached = {
    config,
    now: () => Date.now(),
    generate: createGenerate({ baseUrl: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_MODEL }),
    feishu: {
      listTeachers: () => client.listAllRecords(teacherTable),
      getTeacher: (recordId) => client.getRecord({ ...teacherTable, recordId }),
      updateTeacher: async (recordId, fields) => { await client.updateRecord({ ...teacherTable, recordId, fields }); },
      listWishes: (teacherName, year) =>
        client.searchRecords({
          appToken: config.teacherAppToken,
          tableId: config.wishTableId,
          fieldNames: Object.values(WISH_FIELDS),
          filter: { conjunction: "and", conditions: [
            { field_name: WISH_FIELDS.teacher, operator: "is", value: [teacherName] },
            { field_name: WISH_FIELDS.year, operator: "is", value: [String(year)] },
          ] },
        }),
      listLessons: (scheduleName, todayMs) =>
        client.searchRecords({ appToken: config.scheduleAppToken, tableId: config.scheduleTableId, fieldNames: SCHEDULE_STAT_FIELDS, filter: scheduleFilter(scheduleName, todayMs) }),
      tmpUrls: (tokens) => client.tmpDownloadUrls(tokens),
      send: (to, card) => {
        const [type, id] = to.split(":") as ["open_id" | "chat_id", string];
        return client.sendMessage({ receiveIdType: type, receiveId: id, msgType: "interactive", content: card });
      },
    },
  };
  return cached;
}

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
  isBase64Encoded: false,
});

interface Event {
  httpMethod?: string; path?: string; queryStringParameters?: Record<string, string>;
  Type?: string; TriggerName?: string; action?: string; today?: string; teacher?: string; step?: "ask" | "celebrate" | "all";
}

export async function main(event: Event) {
  if (typeof event.httpMethod !== "string") {
    if (event.Type === "Timer" || event.TriggerName) return { ok: true, results: await runDaily(deps()) };
    if (event.action === "daily") {
      const [y, m, d] = (event.today ?? "").split("-").map(Number);
      const todayMs = y && m && d ? ymdToMs({ y, m, d }) + 9 * 3600_000 : undefined;
      return { ok: true, results: await runDaily(deps(), todayMs) };
    }
    if (event.action === "rehearse" && event.teacher) return { ok: true, ...(await rehearse(deps(), event.teacher, event.step ?? "all")) };
    return { ok: false, error: "UNKNOWN_ACTION" };
  }
  try {
    const path = (event.path ?? "").replace(/^\/birthday-api(?=\/|$)/, "").replace(/\/$/, "") || "/";
    if (event.httpMethod === "GET" && path === "/page") {
      const data = await pageData(deps(), event.queryStringParameters?.t ?? "");
      return data ? json(200, { ok: true, data }) : json(403, { ok: false, error: "INVALID_LINK" });
    }
    return json(404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    console.error(error);
    return json(500, { ok: false, error: "INTERNAL" });
  }
}
