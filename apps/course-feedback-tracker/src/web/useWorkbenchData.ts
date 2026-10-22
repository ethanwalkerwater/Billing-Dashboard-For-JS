import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { assertTaskStatusTransition, nameMatchKey, ownerResolver } from "@/domain";
import type { OwnerAssignment, TaskStatus } from "@/domain";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { ALIASES_TABLE, EXCLUDED_TEACHERS_TABLE, OWNER_ASSIGNMENTS_TABLE, RESPONSES_TABLE, TASKS_TABLE } from "@/shared/rdb";
import { db, taskRepository } from "./cloudbase";

/** 对不上任务的答卷，顶部横幅和手动绑定都用它。 */
export interface UnlinkedResponse {
  responseRecordId: string;
  studentName: string;
  teacherName: string;
  identity: "student" | "parent";
  submittedAt: string;
}

/** 同一学生对同一老师、同一身份的第二份及以后：只算第一份，这里列出来提醒教务。 */
export interface DuplicateResponse extends UnlinkedResponse {
  /** 被计入的那一份的提交时间 */
  countedAt?: string;
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

interface ResponseRow {
  response_record_id: string;
  task_id: string | null;
  student_name: string | null;
  teacher_name: string | null;
  identity: string | null;
  submitted_at: string;
  sync_status: string;
}

interface OwnerRow {
  student_record_id: string;
  teacher_canonical_name: string;
  from_month: string;
  owner: string;
}

export function useWorkbenchData(collectionMonth: string) {
  const [storedTasks, setAllTasks] = useState<StoredFeedbackTask[]>([]);
  const [owners, setOwners] = useState<OwnerAssignment[]>([]);
  // 切了月份后，上个月还在路上的读取（或刷新反馈完成后的重读）回来了也不能覆盖当前月份
  const currentMonth = useRef(collectionMonth);
  currentMonth.current = collectionMonth;
  const [responses, setResponses] = useState<ResponseRow[]>([]);
  /** 不参与统计的老师（课表规范名），所有月份通用 */
  const [excludedTeachers, setExcludedTeachersState] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [taskRows, responseRows, excludedRows, ownerRows] = await Promise.all([
        taskRepository.listByCollectionMonth(collectionMonth),
        db
          .from(RESPONSES_TABLE)
          .select<ResponseRow>("response_record_id,task_id,student_name,teacher_name,identity,submitted_at,sync_status")
          .eq("collection_month", collectionMonth),
        db.from(EXCLUDED_TEACHERS_TABLE).select<{ teacher_name: string }>("teacher_name"),
        // ponytail: 负责人设定整表读（只存手动设的那次，几百行）；上万行再按学生过滤
        db.from(OWNER_ASSIGNMENTS_TABLE).select<OwnerRow>("student_record_id,teacher_canonical_name,from_month,owner"),
      ]);
      if (responseRows.error) throw new Error(responseRows.error.message);
      if (excludedRows.error) throw new Error(excludedRows.error.message);
      if (ownerRows.error) throw new Error(ownerRows.error.message);
      if (currentMonth.current !== collectionMonth) return;

      setAllTasks(taskRows);
      setOwners(
        (ownerRows.data ?? []).map((row) => ({
          studentRecordId: row.student_record_id,
          teacherCanonicalName: row.teacher_canonical_name,
          fromMonth: row.from_month,
          owner: row.owner,
        })),
      );
      setResponses(responseRows.data ?? []);
      setExcludedTeachersState((excludedRows.data ?? []).map((row) => row.teacher_name));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [collectionMonth]);

  // reload 只随月份变：换月份先清空，别在新月份的标题下显示上个月的名单
  useEffect(() => {
    setAllTasks([]);
    setResponses([]);
    void reload();
  }, [reload]);

  // 负责人不存在任务上：按「从某月起生效」的设定实时解析，改了 9 月，没单独设过的 10、11 月立刻跟着变。
  const allTasks = useMemo(() => {
    const resolve = ownerResolver(owners);
    return storedTasks.map((task) => {
      const hit = resolve(task);
      return { ...task, owner: hit?.owner, ownerFromMonth: hit?.fromMonth };
    });
  }, [storedTasks, owners]);

  // 不参与统计的老师：任务、答卷都从工作台视图里拿掉，应发、完成率、对不上横幅都不算他们。
  const { tasks, unlinked, duplicates, summary } = useMemo(() => {
    const excludedKeys = new Set(excludedTeachers.map(nameMatchKey));
    const isExcluded = (task: StoredFeedbackTask) => excludedKeys.has(nameMatchKey(task.teacherCanonicalName));
    const tasks = allTasks.filter((task) => !isExcluded(task));
    const hiddenTaskIds = new Set(allTasks.filter(isExcluded).map((task) => task.taskId));
    const visible = responses.filter((row) =>
      row.task_id ? !hiddenTaskIds.has(row.task_id) : !excludedKeys.has(nameMatchKey(row.teacher_name ?? "")),
    );
    const unlinked: UnlinkedResponse[] = visible
      .filter((row) => row.sync_status === "unlinked")
      .map((row): UnlinkedResponse => ({
        responseRecordId: row.response_record_id,
        studentName: row.student_name ?? "",
        teacherName: row.teacher_name ?? "",
        identity: row.identity === "parent" ? "parent" : "student",
        submittedAt: row.submitted_at,
      }))
      .sort((a, b) => a.teacherName.localeCompare(b.teacherName, "zh-CN"));
    const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
    const submittedById = new Map(responses.map((row) => [row.response_record_id, row.submitted_at]));
    const duplicates: DuplicateResponse[] = visible
      .filter((row) => row.sync_status === "duplicate")
      .map((row): DuplicateResponse => {
        const identity = row.identity === "parent" ? "parent" : "student";
        const task = row.task_id ? tasksById.get(row.task_id) : undefined;
        const countedId = identity === "parent" ? task?.parentResponseId : task?.studentResponseId;
        return {
          responseRecordId: row.response_record_id,
          studentName: task?.studentName ?? row.student_name ?? "",
          teacherName: task?.teacherCanonicalName ?? row.teacher_name ?? "",
          identity,
          submittedAt: row.submitted_at,
          countedAt: countedId ? submittedById.get(countedId) : undefined,
        };
      })
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    const summary: MonthSummary = {
      total: visible.length,
      matched: visible.filter((row) => row.sync_status === "matched").length,
      duplicate: visible.filter((row) => row.sync_status === "duplicate").length,
      unlinked: unlinked.length,
    };
    return { tasks, unlinked, duplicates, summary: loading && allTasks.length === 0 ? null : summary };
  }, [allTasks, responses, excludedTeachers, loading]);

  /** 改「不参与统计的老师」名单：多选框给出完整新名单，这里算出增删。 */
  const setExcludedTeachers = useCallback(
    async (next: string[]) => {
      const current = new Set(excludedTeachers);
      const wanted = new Set(next);
      const added = next.filter((name) => !current.has(name));
      const removed = excludedTeachers.filter((name) => !wanted.has(name));
      if (added.length > 0) {
        const result = await db
          .from(EXCLUDED_TEACHERS_TABLE)
          .upsert(added.map((teacher_name) => ({ teacher_name, created_by: "workbench" })), { onConflict: "teacher_name" });
        if (result.error) throw new Error(`保存不统计老师失败：${result.error.message}`);
      }
      if (removed.length > 0) {
        const result = await db.from(EXCLUDED_TEACHERS_TABLE).delete().in("teacher_name", removed);
        if (result.error) throw new Error(`恢复统计老师失败：${result.error.message}`);
      }
      setExcludedTeachersState(next);
    },
    [excludedTeachers],
  );

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

  /** 设负责人（单行下拉或批量）：从这个课程月份起生效，之后的月份没单独设过就沿用。 */
  const updateOwner = useCallback(
    async (taskIds: Iterable<string>, owner: string) => {
      const ids = new Set(taskIds);
      const rows = storedTasks
        .filter((task) => ids.has(task.taskId))
        .map((task) => ({
          studentRecordId: task.studentRecordId,
          teacherCanonicalName: task.teacherCanonicalName,
          fromMonth: task.courseMonth,
          owner,
        }));
      if (rows.length === 0) return 0;
      const now = new Date().toISOString();
      const result = await db.from(OWNER_ASSIGNMENTS_TABLE).upsert(
        rows.map((row) => ({
          student_record_id: row.studentRecordId,
          teacher_canonical_name: row.teacherCanonicalName,
          from_month: row.fromMonth,
          owner,
          updated_at: now,
        })),
        { onConflict: "student_record_id,teacher_canonical_name,from_month" },
      );
      if (result.error) throw new Error(`设置负责人失败：${result.error.message}`);
      // 只改本地设定，不整表重读，下拉选完立刻生效
      const key = (row: OwnerAssignment) => `${row.studentRecordId}\u001f${row.teacherCanonicalName}\u001f${row.fromMonth}`;
      const replaced = new Set(rows.map(key));
      setOwners((current) => [...current.filter((row) => !replaced.has(key(row))), ...rows]);
      return rows.length;
    },
    [storedTasks],
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

  return {
    tasks,
    allTasks,
    unlinked,
    duplicates,
    summary,
    excludedTeachers,
    setExcludedTeachers,
    loading,
    error,
    reload,
    updateStatus,
    updateOwner,
    addAlias,
    bindResponse,
  };
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
