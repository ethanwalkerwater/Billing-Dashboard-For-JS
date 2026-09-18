import type { FeedbackTaskDraft, TaskStatus } from "../../domain";

export type BoundBy = "name" | "manual";

export interface StoredFeedbackTask extends FeedbackTaskDraft {
  status: TaskStatus;
  publicToken: string;
  submittedAt?: string;
  sentAt?: string;
  /** 学生本人那份答卷 */
  studentResponseId?: string;
  /** 家长那份答卷 */
  parentResponseId?: string;
  boundBy?: BoundBy;
  responseRecordIds: string[];
  validationIssues: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskSyncPlan {
  create: StoredFeedbackTask[];
  update: StoredFeedbackTask[];
  unchanged: StoredFeedbackTask[];
}

export type ResponseIdentity = "student" | "parent";

/**
 * matched   绑到任务并占了学生/家长其中一个位置，任务推进到"已填写"
 * duplicate 同一任务同一身份的第二份及以后，只留引用
 * unlinked  按姓名（含别名）找不到本月任务，需要教务加别名或手动绑定
 * exception 字段结构坏了，解析不出提交时间等关键字段
 */
export type ResponseSyncStatus = "matched" | "duplicate" | "unlinked" | "exception";

export interface ResponseOutcome {
  responseRecordId: string;
  submittedAt: string;
  /** 按提交时间（上海时区）归属的收集月份 */
  collectionMonth: string;
  /** 问卷里的原始写法，"对不上的答卷"列表靠它显示 */
  studentName: string;
  teacherName: string;
  identity: ResponseIdentity;
  taskId: string | null;
  boundBy?: BoundBy;
  syncStatus: ResponseSyncStatus;
  exceptionCode?: string;
  /** 需要把这份答卷写到任务的学生/家长位置并推进状态。稳态下全为 false。 */
  taskNeedsUpdate?: boolean;
}

export interface NameAlias {
  kind: "teacher" | "student";
  alias: string;
  canonical: string;
}

/** 教务手动把某份答卷绑到某个任务；重新同步时保留，不被姓名匹配覆盖。 */
export interface ManualBinding {
  responseRecordId: string;
  taskId: string;
}
