/**
 * income-api —— 教师薪资预警唯一的云函数。
 * 前端 `callFunction({ name: 'income-api', data: { action: 'sync', month } })`：
 * 全量拉飞书课表（约 8700 行、70 秒，「上课时间」不支持服务端过滤），按老师汇总当月课时费，写入 income_teacher_months。
 * 基础薪水、单价、备注、系数由前端经 PostgREST + RLS 直接读写，不经过这里。
 */
import cloudbase from "@cloudbase/node-sdk";

import { aggregateSchedule, parseScheduleRow } from "../../src/domain/income";
import { FeishuClient } from "../../src/server/feishu/client";
import { MONTHS_TABLE } from "../../src/shared/postgrest";
import type { PostgrestLike } from "../../src/shared/postgrest";
import { createServiceDb } from "./service-db";

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });

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

async function syncMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`月份格式无效：${month}`);
  const client = new FeishuClient({ appId: requireEnv("FEISHU_APP_ID"), appSecret: requireEnv("FEISHU_APP_SECRET") });
  const records = await client.listAllRecords({
    appToken: requireEnv("FEISHU_SCHEDULE_APP_TOKEN"),
    tableId: requireEnv("FEISHU_SCHEDULE_TABLE_ID"),
  });
  const teachers = aggregateSchedule(records.map((record) => parseScheduleRow(record.fields)), month);
  const syncedAt = new Date().toISOString();

  // 先删这个月的旧汇总再写：老师当月课全被删掉时，不该还留着上次的数字。
  const removed = await db().from(MONTHS_TABLE).delete().eq("month", month);
  if (removed.error) throw new Error(`清理旧数据失败：${removed.error.message}`);
  if (teachers.length > 0) {
    const written = await db()
      .from(MONTHS_TABLE)
      .upsert(
        teachers.map((item) => ({
          month,
          teacher: item.teacher,
          lesson_fee: item.lessonFee,
          lessons: item.lessons,
          hours: item.hours,
          students: item.students,
          unit_price_auto: item.unitPriceAuto,
          synced_at: syncedAt,
        })),
        { onConflict: "month,teacher" },
      );
    if (written.error) throw new Error(`写入汇总失败：${written.error.message}`);
  }
  return { month, scheduleRows: records.length, teachers: teachers.length, syncedAt };
}

export async function main(event: { action?: string; month?: string }) {
  try {
    await assertAdmin();
    if (event.action === "sync") {
      if (!event.month) throw new Error("缺少 month");
      return { ok: true, ...(await syncMonth(event.month)) };
    }
    return { ok: false, error: `未知操作：${event.action ?? "(空)"}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[income-api]", message);
    return { ok: false, error: message };
  }
}
