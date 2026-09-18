import { monthOfShanghai, nameMatchKey } from "../../domain";
import type { FeishuClient } from "../feishu/client";
import type { FeishuConfig } from "../feishu/config";
import { FeishuSchemaError } from "../feishu/errors";
import { parseFeedbackResponse } from "../feishu/parsers";
import type { FeedbackResponseRecord } from "../feishu/parsers";
import type { FeedbackTaskRepository } from "../tasks/repository";
import type {
  ManualBinding,
  NameAlias,
  ResponseIdentity,
  ResponseOutcome,
  StoredFeedbackTask,
} from "../tasks/types";

export interface ReconcileResponsesResult {
  collectionMonth: string;
  /** 该收集月份收到的反馈总份数 */
  monthTotal: number;
  matched: number;
  duplicate: number;
  unlinked: number;
  exception: number;
  /** 绑定成功的答卷覆盖了多少个不同任务 */
  tasksCovered: number;
  outcomes: ResponseOutcome[];
}

/** 问卷「身份」字段 → 学生/家长位置。空值和未知写法按学生处理。 */
export function identityOf(raw: string[]): ResponseIdentity {
  const text = raw.join("");
  return /家长|监护/u.test(text) ? "parent" : "student";
}

function pairKey(studentName: string, teacherName: string): string {
  return `${nameMatchKey(studentName)}${nameMatchKey(teacherName)}`;
}

/**
 * 业务方决定不往飞书反馈表加字段、不用任务 ID，答卷只按（学生姓名, 老师姓名）匹配任务。
 *
 * 规则刻意简单：规范化（NFKC、去空格、忽略大小写）后精确相等，外加一张别名表
 * （Valentina 林 → Valentina Lin）。不做模糊匹配——对不上的明确列出来，教务加别名或手动绑定。
 * 实测 9 月 182 份答卷里 168 份直接精确相等，加 2 条别名后 179 份。
 */
export function matchResponsesToTasks(input: {
  responses: FeedbackResponseRecord[];
  tasks: readonly StoredFeedbackTask[];
  aliases?: readonly NameAlias[];
  manualBindings?: readonly ManualBinding[];
}): ResponseOutcome[] {
  const aliasMap = { teacher: new Map<string, string>(), student: new Map<string, string>() };
  for (const alias of input.aliases ?? []) aliasMap[alias.kind].set(nameMatchKey(alias.alias), alias.canonical);
  const resolve = (kind: "teacher" | "student", name: string) => aliasMap[kind].get(nameMatchKey(name)) ?? name;

  const tasksByPair = new Map<string, StoredFeedbackTask>();
  const tasksById = new Map<string, StoredFeedbackTask>();
  for (const task of input.tasks) {
    tasksByPair.set(pairKey(task.studentName, task.teacherCanonicalName), task);
    tasksById.set(task.taskId, task);
  }
  const manual = new Map((input.manualBindings ?? []).map((binding) => [binding.responseRecordId, binding.taskId]));

  /**
   * 每个任务的学生位置和家长位置各只认一份答卷；已存库的占位优先，保证重跑结果一致。
   * 同一身份的第二份及以后标记为重复。
   */
  const slots = new Map<string, { student?: string; parent?: string }>();
  for (const task of input.tasks) {
    slots.set(task.taskId, { student: task.studentResponseId, parent: task.parentResponseId });
  }

  const outcomes: ResponseOutcome[] = [];
  const sorted = [...input.responses].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));

  for (const response of sorted) {
    const studentName = response.studentNames[0] ?? "";
    const teacherName = response.teacherNames[0] ?? "";
    const identity = identityOf(response.identity);
    const base = {
      responseRecordId: response.recordId,
      submittedAt: response.submittedAt,
      collectionMonth: monthOfShanghai(response.submittedAt),
      studentName,
      teacherName,
      identity,
    };

    let task: StoredFeedbackTask | undefined;
    let boundBy: ResponseOutcome["boundBy"];
    const manualTaskId = manual.get(response.recordId);
    if (manualTaskId && tasksById.has(manualTaskId)) {
      task = tasksById.get(manualTaskId);
      boundBy = "manual";
    } else if (studentName && teacherName) {
      task = tasksByPair.get(pairKey(resolve("student", studentName), resolve("teacher", teacherName)));
      boundBy = task ? "name" : undefined;
    }

    if (!task) {
      outcomes.push({ ...base, taskId: null, syncStatus: "unlinked", exceptionCode: "no_matching_task" });
      continue;
    }

    const slot = slots.get(task.taskId)!;
    const current = slot[identity];
    if (current && current !== response.recordId) {
      outcomes.push({ ...base, taskId: task.taskId, boundBy, syncStatus: "duplicate" });
      continue;
    }
    slot[identity] = response.recordId;
    const alreadyStored =
      (identity === "student" ? task.studentResponseId : task.parentResponseId) === response.recordId &&
      task.status === "completed";
    outcomes.push({
      ...base,
      taskId: task.taskId,
      boundBy,
      syncStatus: "matched",
      taskNeedsUpdate: !alreadyStored,
    });
  }
  return outcomes;
}

export async function reconcileResponses(input: {
  client: FeishuClient;
  config: FeishuConfig;
  repository: FeedbackTaskRepository;
  collectionMonth: string;
  /** 只处理这些答卷记录（Webhook 场景）。 */
  onlyRecordIds?: string[];
}): Promise<ReconcileResponsesResult> {
  // ponytail: 全量读答卷表再按月过滤。当前 855 行，读全表最简单也最幂等；上万行后再按提交时间增量。
  const raw = await input.client.listAllRecords({
    appToken: input.config.feedbackAppToken,
    tableId: input.config.responseTableId,
  });
  const scope = input.onlyRecordIds ? new Set(input.onlyRecordIds) : null;

  const responses: FeedbackResponseRecord[] = [];
  const schemaFailures: ResponseOutcome[] = [];
  for (const record of raw) {
    if (scope && !scope.has(record.record_id)) continue;
    try {
      const parsed = parseFeedbackResponse(record);
      if (monthOfShanghai(parsed.submittedAt) !== input.collectionMonth) continue;
      responses.push(parsed);
    } catch (error) {
      if (!(error instanceof FeishuSchemaError)) throw error;
      schemaFailures.push({
        responseRecordId: record.record_id,
        submittedAt: new Date().toISOString(),
        collectionMonth: input.collectionMonth,
        studentName: "",
        teacherName: "",
        identity: "student",
        taskId: null,
        syncStatus: "exception",
        exceptionCode: "invalid_fields",
      });
    }
  }

  const [tasks, aliases, manualBindings] = await Promise.all([
    input.repository.listByCollectionMonth(input.collectionMonth),
    input.repository.listAliases(),
    input.repository.listManualBindings(input.collectionMonth),
  ]);
  const outcomes = [...matchResponsesToTasks({ responses, tasks, aliases, manualBindings }), ...schemaFailures];
  await input.repository.applyResponseOutcomes(outcomes);

  const count = (status: ResponseOutcome["syncStatus"]) =>
    outcomes.filter((outcome) => outcome.syncStatus === status).length;
  return {
    collectionMonth: input.collectionMonth,
    monthTotal: outcomes.length,
    matched: count("matched"),
    duplicate: count("duplicate"),
    unlinked: count("unlinked"),
    exception: count("exception"),
    tasksCovered: new Set(outcomes.filter((o) => o.taskId).map((o) => o.taskId)).size,
    outcomes,
  };
}
