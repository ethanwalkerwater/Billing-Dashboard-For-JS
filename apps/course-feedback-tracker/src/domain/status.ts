import type { StatusChangeSource, TaskStatus } from "./types";

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  unsent: "未发",
  // 「已发未填」而不是「已发」：教务真正要盯的是发出去还没人填的那些。
  sent: "已发未填",
  completed: "已填写",
  declined: "拒绝填写",
};

export function canTransitionTaskStatus(input: {
  current: TaskStatus;
  next: TaskStatus;
  source: StatusChangeSource;
  hasResponse: boolean;
}): boolean {
  if (input.current === input.next) return true;
  if (input.source === "response-sync") return input.next === "completed";
  if (input.hasResponse) return input.next === "completed";
  return true;
}

export function assertTaskStatusTransition(input: {
  current: TaskStatus;
  next: TaskStatus;
  source: StatusChangeSource;
  hasResponse: boolean;
}): void {
  if (!canTransitionTaskStatus(input)) {
    throw new Error("已有有效答卷的任务不能改为未完成状态");
  }
}
