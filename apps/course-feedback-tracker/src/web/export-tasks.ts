import { TASK_STATUS_LABELS } from "../domain";
import { toCsv } from "../server/export/csv";
import type { StoredFeedbackTask } from "../server/tasks/types";
import { taskFormUrl } from "./qr";

const HEADERS = [
  "任务ID",
  "课程月份",
  "收集月份",
  "学生",
  "老师",
  "课程",
  "状态",
  "问卷链接",
  "发送时间",
  "提交时间",
  "异常信息",
];

/** 导出当前筛选范围的任务清单，字段与工作台一一对应，便于复算。 */
export function buildTasksCsv(tasks: StoredFeedbackTask[]): string {
  return toCsv(
    HEADERS,
    tasks.map((task) => ({
      任务ID: task.taskId,
      课程月份: task.courseMonth,
      收集月份: task.collectionMonth,
      学生: task.studentName,
      老师: task.teacherCanonicalName,
      课程: task.courseNames.join("、"),
      状态: TASK_STATUS_LABELS[task.status],
      问卷链接: taskFormUrl(task),
      发送时间: task.sentAt ?? "",
      提交时间: task.submittedAt ?? "",
      异常信息: task.validationIssues.join("；"),
    })),
  );
}
