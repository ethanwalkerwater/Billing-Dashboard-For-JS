import type { ManualBinding, NameAlias, ResponseOutcome, StoredFeedbackTask, TaskSyncPlan } from "./types";

export interface FeedbackTaskRepository {
  listByCollectionMonth(collectionMonth: string): Promise<StoredFeedbackTask[]>;
  findByTaskIds(taskIds: string[]): Promise<StoredFeedbackTask[]>;
  findByPublicToken(publicToken: string): Promise<StoredFeedbackTask | null>;
  applySyncPlan(plan: TaskSyncPlan): Promise<void>;
  /** 问卷写法 → 课表规范名 */
  listAliases(): Promise<NameAlias[]>;
  /** 教务手动绑定过的答卷，重新同步时保留 */
  listManualBindings(collectionMonth: string): Promise<ManualBinding[]>;
  /** 库里这个收集月份已记录的答卷 ID，用来找出飞书里已删除的 */
  listResponseIds(collectionMonth: string): Promise<string[]>;
  deleteResponses(responseRecordIds: string[]): Promise<void>;
  /** 写回任务的学生/家长位置、状态和提交时间（删除答卷后腾位置用） */
  updateTaskSlots(tasks: StoredFeedbackTask[]): Promise<void>;
  /** 写答卷引用，并把绑定成功的答卷填进任务的学生/家长位置、推进到"已填写"。 */
  applyResponseOutcomes(outcomes: ResponseOutcome[]): Promise<void>;
}
