/**
 * ielts-api —— 雅思正向率唯一的云函数。
 * 前端 `callFunction({ name: 'ielts-api', data: { action: 'sync' } })`，另有每天 07:00 定时触发。
 * 读飞书「雅思成绩」表全量 + 课表里课程类型含「雅思」的记录（服务端过滤，约 1700 行 / 20 秒），
 * 压成一行 JSON 快照整行写入 ielts_snapshots。飞书没读全就抛错，旧快照原样保留。
 */
import cloudbase from "@cloudbase/node-sdk";

import { parseLesson, parseScoreRecord } from "../../src/domain/progress";
import type { FeishuSnapshot, Lesson } from "../../src/domain/progress";
import { FeishuClient } from "../../src/server/feishu/client";
import { SNAPSHOTS_TABLE } from "../../src/shared/postgrest";
import type { PostgrestLike } from "../../src/shared/postgrest";
import { createServiceDb } from "./service-db";

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

const SCORE_FIELDS = ["编号", "学生", "成绩类型", "考试日期", "听力", "阅读", "写作", "口语", "成绩单", "已核验", "提交人"];
const LESSON_FIELDS = ["学生", "课程类型", "老师", "上课时间", "临时取消"];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少服务端配置 ${name}`);
  return value;
}

let serviceDb: PostgrestLike | undefined;
function db(): PostgrestLike {
  serviceDb ??= createServiceDb({ envId: requireEnv("CLOUDBASE_ENV_ID"), apiKey: requireEnv("CLOUDBASE_API_KEY") });
  return serviceDb;
}

/** 只放行已登录且在 feedback_admins 白名单里的教务（和反馈追踪系统同一份名单）。 */
async function assertAdmin(): Promise<void> {
  let uid: string | undefined;
  try {
    const user = app.auth().getUserInfo();
    uid = user?.isAnonymous ? undefined : user?.uid;
  } catch {
    uid = undefined;
  }
  if (!uid) throw new Error("请先登录");
  const result = await db().from("feedback_admins").select("user_id").eq("user_id", uid).eq("active", true);
  if (!result.data?.length) throw new Error("当前账号不在管理员白名单");
}

async function sync() {
  const client = new FeishuClient({ appId: requireEnv("FEISHU_APP_ID"), appSecret: requireEnv("FEISHU_APP_SECRET") });
  const appToken = requireEnv("FEISHU_SCHEDULE_APP_TOKEN");
  const scoreTable = requireEnv("FEISHU_IELTS_TABLE_ID");

  // 字段被改名时 records 接口只会少返回那一列，不报错；先查字段表，缺了就停，不覆盖旧快照。
  const fieldNames = new Set((await client.listAllFields({ appToken, tableId: scoreTable })).map((field) => field.field_name));
  const missing = SCORE_FIELDS.filter((name) => !fieldNames.has(name));
  if (missing.length > 0) throw new Error(`飞书「雅思成绩」表缺少字段：${missing.join("、")}。请改回原名后重新同步`);

  const [scoreRecords, scheduleRecords] = await Promise.all([
    client.listAllRecords({ appToken, tableId: scoreTable, fieldNames: SCORE_FIELDS }),
    client.listAllRecords({
      appToken,
      tableId: requireEnv("FEISHU_SCHEDULE_TABLE_ID"),
      filter: 'CurrentValue.[课程类型].contains("雅思")',
      fieldNames: LESSON_FIELDS,
    }),
  ]);

  const lessons: Lesson[] = [];
  const unknownTypes: Record<string, number> = {};
  for (const record of scheduleRecords) {
    const parsed = parseLesson(record.fields);
    if (!parsed) continue;
    if ("unknownType" in parsed) unknownTypes[parsed.unknownType] = (unknownTypes[parsed.unknownType] ?? 0) + 1;
    else lessons.push(parsed);
  }

  const syncedAt = new Date().toISOString();
  const snapshot: FeishuSnapshot = {
    scores: scoreRecords.map((record) => parseScoreRecord(record.record_id, record.fields)),
    lessons,
    unknownTypes,
    syncedAt,
  };
  const written = await db()
    .from(SNAPSHOTS_TABLE)
    .upsert([{ key: "feishu", data: snapshot, updated_at: syncedAt }], { onConflict: "key" });
  if (written.error) throw new Error(`写入快照失败：${written.error.message}`);
  return { scores: snapshot.scores.length, scheduleRows: scheduleRecords.length, lessons: lessons.length, syncedAt };
}

export async function main(event: { action?: string; Type?: string }) {
  try {
    // 定时触发没有登录用户。伪造这个字段最多换来一次同步，读不到任何数据。
    if (event.Type === "Timer") {
      await sync();
      return { ok: true };
    }
    await assertAdmin();
    if (event.action === "sync") return { ok: true, ...(await sync()) };
    return { ok: false, error: `未知操作：${event.action ?? "(空)"}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ielts-api]", message);
    return { ok: false, error: message };
  }
}
