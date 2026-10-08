import { createDeterministicPublicToken } from "../../domain";
import type { FeedbackTaskDraft } from "../../domain";
import type { StoredFeedbackTask, TaskSyncPlan } from "./types";

function equalStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export async function buildTaskSyncPlan(input: {
  existing: StoredFeedbackTask[];
  drafts: FeedbackTaskDraft[];
  publicTokenPepper: string;
  now?: string;
}): Promise<TaskSyncPlan> {
  const now = input.now ?? new Date().toISOString();
  const existingById = new Map(input.existing.map((task) => [task.taskId, task]));
  const plan: TaskSyncPlan = { create: [], update: [], unchanged: [], remove: [], orphaned: [] };

  for (const draft of input.drafts) {
    const existing = existingById.get(draft.taskId);
    const courseNames = normalizeList(draft.courseNames);
    const scheduleRecordIds = normalizeList(draft.scheduleRecordIds);
    if (!existing) {
      const publicToken = await createDeterministicPublicToken(draft.taskId, input.publicTokenPepper);
      plan.create.push({
        ...draft,
        courseNames,
        scheduleRecordIds,
        status: "unsent",
        publicToken,
        responseRecordIds: [],
        validationIssues: [],
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }

    const unchanged =
      existing.studentName === draft.studentName &&
      existing.teacherSourceName === draft.teacherSourceName &&
      existing.teacherCanonicalName === draft.teacherCanonicalName &&
      equalStringArrays(existing.courseNames, courseNames) &&
      equalStringArrays(existing.scheduleRecordIds, scheduleRecordIds);
    if (unchanged) {
      plan.unchanged.push(existing);
      continue;
    }
    plan.update.push({
      ...existing,
      ...draft,
      courseNames,
      scheduleRecordIds,
      updatedAt: now,
    });
  }

  // 这次没再生成的旧任务（课程类型改判为非课程、或课表里的课被删了）：
  // 没人填过的直接删，免得继续催学生评一场会议；已经有答卷的保留，反馈不能丢。
  const draftIds = new Set(input.drafts.map((draft) => draft.taskId));
  for (const existing of input.existing) {
    if (draftIds.has(existing.taskId)) continue;
    if (existing.studentResponseId || existing.parentResponseId) plan.orphaned.push(existing);
    else plan.remove.push(existing);
  }
  return plan;
}

