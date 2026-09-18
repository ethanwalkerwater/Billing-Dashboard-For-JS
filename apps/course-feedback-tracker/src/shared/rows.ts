import type { TaskStatus } from "../domain";
import type { StoredFeedbackTask } from "../server/tasks/types";

/** feedback_tasks 的数据库行形状，前端和云函数都通过 PostgREST 读写同一张表。 */
export interface FeedbackTaskRow {
  task_id: string;
  course_month: string;
  collection_month: string;
  student_record_id: string;
  student_name: string;
  teacher_source_name: string;
  teacher_canonical_name: string;
  course_names: string[];
  schedule_record_ids: string[];
  status: TaskStatus;
  public_token: string;
  sent_at: string | null;
  submitted_at: string | null;
  student_response_id: string | null;
  parent_response_id: string | null;
  bound_by: "name" | "manual" | null;
  response_record_ids: string[];
  validation_issues: string[];
  created_at: string;
  updated_at: string;
}

export function rowToTask(row: FeedbackTaskRow): StoredFeedbackTask {
  return {
    taskId: row.task_id,
    courseMonth: row.course_month,
    collectionMonth: row.collection_month,
    studentRecordId: row.student_record_id,
    studentName: row.student_name,
    teacherSourceName: row.teacher_source_name,
    teacherCanonicalName: row.teacher_canonical_name,
    courseNames: row.course_names ?? [],
    scheduleRecordIds: row.schedule_record_ids ?? [],
    status: row.status,
    publicToken: row.public_token,
    sentAt: row.sent_at ?? undefined,
    submittedAt: row.submitted_at ?? undefined,
    studentResponseId: row.student_response_id ?? undefined,
    parentResponseId: row.parent_response_id ?? undefined,
    boundBy: row.bound_by ?? undefined,
    responseRecordIds: row.response_record_ids ?? [],
    validationIssues: row.validation_issues ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function taskToRow(task: StoredFeedbackTask): FeedbackTaskRow {
  return {
    task_id: task.taskId,
    course_month: task.courseMonth,
    collection_month: task.collectionMonth,
    student_record_id: task.studentRecordId,
    student_name: task.studentName,
    teacher_source_name: task.teacherSourceName,
    teacher_canonical_name: task.teacherCanonicalName,
    course_names: task.courseNames,
    schedule_record_ids: task.scheduleRecordIds,
    status: task.status,
    public_token: task.publicToken,
    sent_at: task.sentAt ?? null,
    submitted_at: task.submittedAt ?? null,
    student_response_id: task.studentResponseId ?? null,
    parent_response_id: task.parentResponseId ?? null,
    bound_by: task.boundBy ?? null,
    response_record_ids: task.responseRecordIds,
    validation_issues: task.validationIssues,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}
