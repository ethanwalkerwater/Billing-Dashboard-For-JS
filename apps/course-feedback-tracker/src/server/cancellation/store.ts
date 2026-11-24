/** 取消链接与一次性取消编号的数据库存取（CloudBase PostgreSQL，云函数用 service_role 访问）。 */
import type { CancelIntent, CancelLink, CancellationDeps, IntentOutcome } from "../../cancellation/service";
import type { PostgrestLike } from "../../shared/rdb";

export const CANCEL_LINKS_TABLE = "cancel_links";
export const CANCEL_INTENTS_TABLE = "cancel_intents";

interface LinkRow {
  token: string;
  student_key: string;
  student_name: string;
  active: boolean;
}

interface IntentRow {
  intent_id: string;
  token: string;
  student_key: string;
  student_name: string;
  schedule_record_id: string;
  created_at: string;
  expires_at: string;
  status: CancelIntent["status"];
}

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}失败：${error?.message ?? "未知错误"}`);
}

export function createCancellationStore(db: PostgrestLike): Pick<CancellationDeps, "links" | "intents"> {
  return {
    links: {
      async find(token: string): Promise<CancelLink | null> {
        const result = await db.from(CANCEL_LINKS_TABLE).select<LinkRow>("token,student_key,student_name,active").eq("token", token).limit(1);
        if (result.error) fail("读取取消链接", result.error);
        const row = result.data?.[0];
        return row ? { token: row.token, studentKey: row.student_key, studentName: row.student_name, active: row.active } : null;
      },
    },
    intents: {
      async create(intent: CancelIntent): Promise<void> {
        const result = await db.from(CANCEL_INTENTS_TABLE).insert([{
          intent_id: intent.intentId,
          token: intent.token,
          student_key: intent.studentKey,
          student_name: intent.studentName,
          schedule_record_id: intent.scheduleRecordId,
          lesson_label: intent.lessonLabel ?? null,
          teacher_name: intent.teacherName ?? null,
          lesson_start_at: intent.lessonStartMs == null ? null : new Date(intent.lessonStartMs).toISOString(),
          created_at: new Date(intent.createdMs).toISOString(),
          expires_at: new Date(intent.expiresMs).toISOString(),
          status: intent.status,
        }]);
        if (result.error) fail("保存取消编号", result.error);
      },
      async get(intentId: string): Promise<CancelIntent | null> {
        const result = await db.from(CANCEL_INTENTS_TABLE).select<IntentRow>("*").eq("intent_id", intentId).limit(1);
        if (result.error) fail("读取取消编号", result.error);
        const row = result.data?.[0];
        if (!row) return null;
        return {
          intentId: row.intent_id,
          token: row.token,
          studentKey: row.student_key,
          studentName: row.student_name,
          scheduleRecordId: row.schedule_record_id,
          createdMs: Date.parse(row.created_at),
          expiresMs: Date.parse(row.expires_at),
          status: row.status,
        };
      },
      async finish(intentId: string, outcome: IntentOutcome): Promise<boolean> {
        // 条件更新：只有 pending 的编号会被改，保证并发或重复事件下只生效一次
        const result = await db
          .from(CANCEL_INTENTS_TABLE)
          .update({
            status: outcome.status,
            request_record_id: outcome.requestRecordId,
            tier: outcome.tier ?? null,
            reason: outcome.reason ?? null,
            message: outcome.message,
            processed_at: new Date(outcome.processedMs).toISOString(),
          })
          .eq("intent_id", intentId)
          .eq("status", "pending");
        if (result.error) fail("更新取消编号", result.error);
        return (result.data?.length ?? 0) > 0;
      },
    },
  };
}
