import type { StoredFeedbackTask } from "@/server/tasks/types";

/** 生成名单刚建出来的任务置顶，其余仍按当前列排序。 */
export function pinNewTasks(tasks: StoredFeedbackTask[], newTaskIds: ReadonlySet<string>): StoredFeedbackTask[] {
  if (newTaskIds.size === 0) return tasks;
  const neu: StoredFeedbackTask[] = [];
  const rest: StoredFeedbackTask[] = [];
  for (const task of tasks) (newTaskIds.has(task.taskId) ? neu : rest).push(task);
  return [...neu, ...rest];
}
