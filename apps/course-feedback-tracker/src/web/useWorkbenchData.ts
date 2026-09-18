import { useCallback, useEffect, useMemo, useState } from "react";

import { assertTaskStatusTransition } from "@/domain";
import type { TaskStatus } from "@/domain";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { ALIASES_TABLE, RESPONSES_TABLE, TASKS_TABLE } from "@/shared/rdb";
import { db, taskRepository } from "./cloudbase";

/** 对不上任务的答卷，顶部横幅和手动绑定都用它。 */
export interface UnlinkedResponse {
  responseRecordId: string;
  studentName: string;
  teacherName: string;
  identity: "student" | "parent";
  submittedAt: string;
}

export interface Alias {
  kind: "teacher" | "student";
  alias: string;
  canonical: string;
}

export interface MonthSummary {
  /** 飞书答卷表里这个收集月份的答卷总数 */
  total: number;
  matched: number;
  duplicate: number;
  unlinked: number;
}

export type SortKey = "student" | "teacher" | "status" | "activity";

export interface Filters {
  status: TaskStatus | "all";
  /** 空数组 = 全部；多选 */
  teachers: string[];
  students: string[];
  /** 谁评了：全部 / 学生已评 / 学生未评 / 家长已评 / 家长未评 / 双方已评 */
  respondent: "all" | "student-yes" | "student-no" | "parent-yes" | "parent-no" | "both";
  query: string;
}

export const EMPTY_FILTERS: Filters = { status: "all", teachers: [], students: [], respondent: "all", query: "" };

export function useWorkbenchData(collectionMonth: string) {
  const [tasks, setTasks] = useState<StoredFeedbackTask[]>([]);
  const [unlinked, setUnlinked] = useState<UnlinkedResponse[]>([]);
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [taskRows, responseRows] = await Promise.all([
        taskRepository.listByCollectionMonth(collectionMonth),
        db
          .from(RESPONSES_TABLE)
          .select<{
            response_record_id: string;
            student_name: string | null;
            teacher_name: string | null;
            identity: string | null;
            submitted_at: string;
            sync_status: string;
          }>("response_record_id,student_name,teacher_name,identity,submitted_at,sync_status")
          .eq("collection_month", collectionMonth),
      ]);
      if (responseRows.error) throw new Error(responseRows.error.message);

      const responses = responseRows.data ?? [];
      setTasks(taskRows);
      setUnlinked(
        responses
          .filter((row) => row.sync_status === "unlinked")
          .map((row) => ({
            responseRecordId: row.response_record_id,
            studentName: row.student_name ?? "",
            teacherName: row.teacher_name ?? "",
            identity: (row.identity === "parent" ? "parent" : "student") as "student" | "parent",
            submittedAt: row.submitted_at,
          }))
          .sort((a, b) => a.teacherName.localeCompare(b.teacherName, "zh-CN")),
      );
      setSummary({
        total: responses.length,
        matched: responses.filter((row) => row.sync_status === "matched").length,
        duplicate: responses.filter((row) => row.sync_status === "duplicate").length,
        unlinked: responses.filter((row) => row.sync_status === "unlinked").length,
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [collectionMonth]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 批量改状态。有答卷的任务不允许退回未完成，跳过而不是整批报错。 */
  const updateStatus = useCallback(
    async (taskIds: Iterable<string>, nextStatus: TaskStatus) => {
      const wanted = new Set(taskIds);
      const eligible = tasks.filter((task) => {
        if (!wanted.has(task.taskId)) return false;
        try {
          assertTaskStatusTransition({
            current: task.status,
            next: nextStatus,
            source: "manual",
            hasResponse: Boolean(task.studentResponseId || task.parentResponseId),
          });
          return true;
        } catch {
          return false;
        }
      });
      if (eligible.length === 0) return { updated: 0, skipped: wanted.size };

      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status: nextStatus, updated_at: now };
      if (nextStatus === "sent") patch.sent_at = now;
      const result = await db
        .from(TASKS_TABLE)
        .update(patch)
        .in(
          "task_id",
          eligible.map((task) => task.taskId),
        );
      if (result.error) throw new Error(`更新状态失败：${result.error.message}`);
      await reload();
      return { updated: eligible.length, skipped: wanted.size - eligible.length };
    },
    [reload, tasks],
  );

  /** 加别名。下次同步时这批写法就能自动对上，不用每月手动绑。 */
  const addAlias = useCallback(
    async (alias: Alias) => {
      const result = await db.from(ALIASES_TABLE).upsert([{ ...alias, created_by: "workbench" }], {
        onConflict: "kind,alias",
      });
      if (result.error) throw new Error(`保存别名失败：${result.error.message}`);
      await reload();
    },
    [reload],
  );

  /**
   * 手动把一份答卷绑到任务。标 bound_by='manual'，重新同步时保留，不会被姓名匹配覆盖。
   * 任务侧同时占位并推进到"已填写"，不用等下一次同步。
   */
  const bindResponse = useCallback(
    async (input: { responseRecordId: string; taskId: string; identity: "student" | "parent"; submittedAt: string }) => {
      const now = new Date().toISOString();
      const linkResult = await db
        .from(RESPONSES_TABLE)
        .update({ task_id: input.taskId, bound_by: "manual", sync_status: "matched", updated_at: now })
        .eq("response_record_id", input.responseRecordId);
      if (linkResult.error) throw new Error(`绑定答卷失败：${linkResult.error.message}`);

      const taskResult = await db
        .from(TASKS_TABLE)
        .update({
          status: "completed",
          bound_by: "manual",
          submitted_at: input.submittedAt,
          [input.identity === "parent" ? "parent_response_id" : "student_response_id"]: input.responseRecordId,
          updated_at: now,
        })
        .eq("task_id", input.taskId);
      if (taskResult.error) throw new Error(`更新任务失败：${taskResult.error.message}`);
      await reload();
    },
    [reload],
  );

  return { tasks, unlinked, summary, loading, error, reload, updateStatus, addAlias, bindResponse };
}

/** 一行任务的显示状态：有答卷即"已评"，与数据库 status 保持一致但更直白。 */
export function respondedBy(task: StoredFeedbackTask): { student: boolean; parent: boolean } {
  return { student: Boolean(task.studentResponseId), parent: Boolean(task.parentResponseId) };
}

export function lastActivityAt(task: StoredFeedbackTask): string | undefined {
  return task.submittedAt ?? task.sentAt;
}

export function filterTasks(tasks: StoredFeedbackTask[], filters: Filters): StoredFeedbackTask[] {
  const needle = filters.query.trim().toLocaleLowerCase();
  const teachers = new Set(filters.teachers);
  const students = new Set(filters.students);
  return tasks.filter((task) => {
    if (filters.status !== "all" && task.status !== filters.status) return false;
    if (teachers.size > 0 && !teachers.has(task.teacherCanonicalName)) return false;
    if (students.size > 0 && !students.has(task.studentName)) return false;
    const { student, parent } = respondedBy(task);
    if (filters.respondent === "student-yes" && !student) return false;
    if (filters.respondent === "student-no" && student) return false;
    if (filters.respondent === "parent-yes" && !parent) return false;
    if (filters.respondent === "parent-no" && parent) return false;
    if (filters.respondent === "both" && !(student && parent)) return false;
    if (!needle) return true;
    return [task.studentName, task.teacherCanonicalName, ...task.courseNames]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

const STATUS_ORDER: Record<TaskStatus, number> = { unsent: 0, sent: 1, completed: 2, declined: 3 };

export function sortTasks(tasks: StoredFeedbackTask[], key: SortKey, asc: boolean): StoredFeedbackTask[] {
  const direction = asc ? 1 : -1;
  const compare = (left: StoredFeedbackTask, right: StoredFeedbackTask): number => {
    switch (key) {
      case "student":
        return left.studentName.localeCompare(right.studentName, "zh-CN");
      case "teacher":
        return left.teacherCanonicalName.localeCompare(right.teacherCanonicalName, "zh-CN");
      case "status":
        return STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
      case "activity":
        return (lastActivityAt(left) ?? "").localeCompare(lastActivityAt(right) ?? "");
    }
  };
  return [...tasks].sort((left, right) => {
    const primary = compare(left, right) * direction;
    // 同值时按学生+老师稳定排序，翻页和重渲染顺序不跳。
    return primary || left.studentName.localeCompare(right.studentName, "zh-CN") ||
      left.teacherCanonicalName.localeCompare(right.teacherCanonicalName, "zh-CN");
  });
}

export function useTaskCounts(tasks: StoredFeedbackTask[]) {
  return useMemo(() => {
    const counts: Record<TaskStatus, number> = { unsent: 0, sent: 0, completed: 0, declined: 0 };
    let studentDone = 0;
    let parentDone = 0;
    for (const task of tasks) {
      counts[task.status] += 1;
      if (task.studentResponseId) studentDone += 1;
      if (task.parentResponseId) parentDone += 1;
    }
    const total = tasks.length;
    return {
      counts,
      total,
      studentDone,
      parentDone,
      completionRate: total === 0 ? 0 : Math.round((counts.completed / total) * 100),
    };
  }, [tasks]);
}
