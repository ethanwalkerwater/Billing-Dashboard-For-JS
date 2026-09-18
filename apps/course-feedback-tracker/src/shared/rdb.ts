import { rowToTask, taskToRow } from "./rows";
import type { FeedbackTaskRow } from "./rows";
import type { FeedbackTaskRepository } from "../server/tasks/repository";
import type { ManualBinding, NameAlias, ResponseOutcome, StoredFeedbackTask, TaskSyncPlan } from "../server/tasks/types";

/**
 * CloudBase PostgreSQL 暴露的是 PostgREST 接口（`app.rdb()`，浏览器和云函数同一套 API）。
 * SDK 没有随包发布该子模块的类型定义，这里只声明本项目实际用到的调用形状。
 */
export interface PostgrestResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}

interface PostgrestFilter<T> extends PromiseLike<PostgrestResult<T>> {
  eq(column: string, value: unknown): PostgrestFilter<T>;
  in(column: string, values: readonly unknown[]): PostgrestFilter<T>;
  order(column: string, options?: { ascending?: boolean }): PostgrestFilter<T>;
  limit(count: number): PostgrestFilter<T>;
}

export interface PostgrestLike {
  from(table: string): {
    select<T = FeedbackTaskRow>(columns?: string): PostgrestFilter<T>;
    insert(rows: Record<string, unknown>[]): PromiseLike<PostgrestResult<unknown>>;
    upsert(
      rows: Record<string, unknown>[],
      options?: { onConflict?: string },
    ): PromiseLike<PostgrestResult<unknown>>;
    update(values: Record<string, unknown>): PostgrestFilter<unknown>;
  };
}

export const TASKS_TABLE = "feedback_tasks";
export const RESPONSES_TABLE = "feedback_responses";
export const ALIASES_TABLE = "feedback_name_aliases";

function unwrap<T>(result: PostgrestResult<T>, context: string): T[] {
  if (result.error) throw new Error(`${context}失败：${result.error.message}`);
  return result.data ?? [];
}

export class RdbFeedbackTaskRepository implements FeedbackTaskRepository {
  constructor(private readonly db: PostgrestLike) {}

  async listByCollectionMonth(collectionMonth: string): Promise<StoredFeedbackTask[]> {
    const result = await this.db
      .from(TASKS_TABLE)
      .select("*")
      .eq("collection_month", collectionMonth)
      .order("teacher_canonical_name", { ascending: true });
    return unwrap(result, "读取月度任务").map(rowToTask);
  }

  async findByTaskIds(taskIds: string[]): Promise<StoredFeedbackTask[]> {
    if (taskIds.length === 0) return [];
    const result = await this.db.from(TASKS_TABLE).select("*").in("task_id", taskIds);
    return unwrap(result, "按任务 ID 读取任务").map(rowToTask);
  }

  async findByPublicToken(publicToken: string): Promise<StoredFeedbackTask | null> {
    const result = await this.db
      .from(TASKS_TABLE)
      .select("*")
      .eq("public_token", publicToken)
      .limit(1);
    return unwrap(result, "按短链接读取任务").map(rowToTask)[0] ?? null;
  }

  async applySyncPlan(plan: TaskSyncPlan): Promise<void> {
    const rows = [...plan.create, ...plan.update].map(taskToRow) as unknown as Record<string, unknown>[];
    if (rows.length === 0) return;
    // task_id 唯一，upsert 保证重复同步幂等；状态字段由 buildTaskSyncPlan 保留教务的手动修改。
    for (const chunk of chunked(rows, 200)) {
      const result = await this.db.from(TASKS_TABLE).upsert(chunk, { onConflict: "task_id" });
      if (result.error) throw new Error(`写入月度任务失败：${result.error.message}`);
    }
  }

  async listAliases(): Promise<NameAlias[]> {
    const result = await this.db.from(ALIASES_TABLE).select<NameAlias>("kind,alias,canonical");
    return unwrap(result, "读取姓名别名");
  }

  async listManualBindings(collectionMonth: string): Promise<ManualBinding[]> {
    const result = await this.db
      .from(RESPONSES_TABLE)
      .select<{ response_record_id: string; task_id: string | null }>("response_record_id,task_id")
      .eq("collection_month", collectionMonth)
      .eq("bound_by", "manual");
    return unwrap(result, "读取手动绑定")
      .filter((row) => row.task_id)
      .map((row) => ({ responseRecordId: row.response_record_id, taskId: row.task_id! }));
  }

  async applyResponseOutcomes(outcomes: ResponseOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    const now = new Date().toISOString();
    for (const chunk of chunked(outcomes, 200)) {
      const result = await this.db.from(RESPONSES_TABLE).upsert(
        chunk.map((outcome) => ({
          response_record_id: outcome.responseRecordId,
          task_id: outcome.taskId,
          submitted_at: outcome.submittedAt,
          collection_month: outcome.collectionMonth,
          student_name: outcome.studentName,
          teacher_name: outcome.teacherName,
          identity: outcome.identity,
          bound_by: outcome.boundBy ?? null,
          sync_status: outcome.syncStatus,
          exception_code: outcome.exceptionCode ?? null,
          updated_at: now,
        })),
        { onConflict: "response_record_id" },
      );
      if (result.error) throw new Error(`写入答卷引用失败：${result.error.message}`);
    }

    // 绑定成功的答卷占任务的学生/家长位置；任一位置有答卷，任务即为"已填写"。
    // 每个任务最多写一次，把该任务本轮所有需要落位的答卷合并进同一个 PATCH。
    const patches = new Map<string, Record<string, unknown>>();
    for (const outcome of outcomes) {
      if (!outcome.taskId || !outcome.taskNeedsUpdate) continue;
      const patch = patches.get(outcome.taskId) ?? { status: "completed", updated_at: now };
      patch[outcome.identity === "parent" ? "parent_response_id" : "student_response_id"] = outcome.responseRecordId;
      patch.bound_by = outcome.boundBy ?? null;
      // submitted_at 取最早那份
      const existing = patch.submitted_at as string | undefined;
      if (!existing || outcome.submittedAt < existing) patch.submitted_at = outcome.submittedAt;
      patches.set(outcome.taskId, patch);
    }
    for (const [taskId, patch] of patches) {
      const result = await this.db.from(TASKS_TABLE).update(patch).eq("task_id", taskId);
      if (result.error) throw new Error(`更新任务状态失败：${result.error.message}`);
    }
  }
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}
