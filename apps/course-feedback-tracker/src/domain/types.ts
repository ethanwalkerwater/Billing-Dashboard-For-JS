export type TaskStatus = "unsent" | "sent" | "completed" | "declined";

export type StatusChangeSource = "manual" | "response-sync";

export interface StudentRecord {
  recordId: string;
  name: string;
}

export interface ScheduleRecord {
  recordId: string;
  startsAt: string;
  studentRecordIds: string[];
  teacherNames: string[];
  courseNames: string[];
  teachingTypes: string[];
  cancellationTags: string[];
}

export interface FeedbackTaskDraft {
  taskId: string;
  courseMonth: string;
  collectionMonth: string;
  studentRecordId: string;
  studentName: string;
  teacherSourceName: string;
  teacherCanonicalName: string;
  courseNames: string[];
  scheduleRecordIds: string[];
}

export interface FeedbackTask extends FeedbackTaskDraft {
  status: TaskStatus;
  publicToken: string;
  submittedAt?: string;
  sentAt?: string;
  validationIssues: string[];
}

export interface SkippedScheduleRecord {
  recordId: string;
  reason: string;
}

export interface GroupingResult {
  tasks: FeedbackTaskDraft[];
  /** 临时取消或明确非授课，不生成任务。 */
  excludedRecords: SkippedScheduleRecord[];
  /** 没标授课类型、按课程处理并生成了任务，需教务复核。 */
  reviewRecords: SkippedScheduleRecord[];
  invalidRecords: Array<{
    recordId: string;
    reasons: string[];
  }>;
}

export interface GroupingOptions {
  collectionMonth: string;
  /** 「课程类型」页里教务手动设定的 课程类型 → 是否课程 */
  courseTypeOverrides?: ReadonlyMap<string, boolean>;
  teacherAliases?: Readonly<Record<string, string>>;
}
