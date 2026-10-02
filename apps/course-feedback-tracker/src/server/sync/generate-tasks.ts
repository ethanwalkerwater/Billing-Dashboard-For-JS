import { collectionMonthToCourseMonth, groupScheduleIntoTasks } from "../../domain";
import type { SkippedScheduleRecord } from "../../domain";
import type { FeishuClient } from "../feishu/client";
import type { FeishuConfig } from "../feishu/config";
import { FeishuSchemaError } from "../feishu/errors";
import { parseScheduleRecord, parseStudentRecord } from "../feishu/parsers";
import { planSelectOptionAppend } from "../feishu/options";
import { ensureSelectFieldOptions } from "../feishu/sync-options";
import { buildTaskSyncPlan } from "../tasks/reconcile";
import type { FeedbackTaskRepository } from "../tasks/repository";
import type { TaskSyncPlan } from "../tasks/types";

export interface GenerateTasksResult {
  collectionMonth: string;
  courseMonth: string;
  scheduleRecordsScanned: number;
  created: number;
  updated: number;
  unchanged: number;
  excludedRecords: SkippedScheduleRecord[];
  reviewRecords: SkippedScheduleRecord[];
  invalidRecords: Array<{ recordId: string; reasons: string[] }>;
  /** 本次自动追加进问卷「学生姓名」下拉的学生 */
  studentsAddedToForm: string[];
  /** 课表里有、问卷下拉里没有的姓名。学生会自动追加（预演时只列出），老师只提示。 */
  studentsMissingFromForm: string[];
  teachersMissingFromForm: string[];
}

/**
 * 课表「上课时间」字段实测不支持服务端日期筛选（ExactDate 与时间戳均返回 1254018 InvalidFilter），
 * 因此这里全表读取后在内存里按上海时区月份过滤。当前约 8600 行，一次同步约 20s，可接受。
 */
async function readAllSchedule(client: FeishuClient, config: FeishuConfig) {
  return client.listAllRecords({
    appToken: config.scheduleAppToken,
    tableId: config.scheduleTableId,
  });
}

/** 结构错误不能静默吞掉：解析失败的记录进无效清单，而不是当作"没有这条课"。 */
function parseAll<T>(
  records: Array<{ record_id: string; fields: Record<string, unknown> }>,
  parse: (record: { record_id: string; fields: Record<string, unknown> }) => T,
): { parsed: T[]; failures: Array<{ recordId: string; reasons: string[] }> } {
  const parsed: T[] = [];
  const failures: Array<{ recordId: string; reasons: string[] }> = [];
  for (const record of records) {
    try {
      parsed.push(parse(record));
    } catch (error) {
      if (error instanceof FeishuSchemaError) {
        failures.push({ recordId: error.recordId, reasons: [error.message] });
        continue;
      }
      throw error;
    }
  }
  return { parsed, failures };
}

export async function generateMonthlyTasks(input: {
  client: FeishuClient;
  config: FeishuConfig;
  repository: FeedbackTaskRepository;
  collectionMonth: string;
  publicTokenPepper: string;
  /** 只做预演，不写数据库、也不追加问卷选项。 */
  dryRun?: boolean;
  now?: string;
}): Promise<GenerateTasksResult & { plan: TaskSyncPlan }> {
  const courseMonth = collectionMonthToCourseMonth(input.collectionMonth);
  const [scheduleRaw, studentRaw] = await Promise.all([
    readAllSchedule(input.client, input.config),
    input.client.listAllRecords({
      appToken: input.config.scheduleAppToken,
      tableId: input.config.studentTableId,
    }),
  ]);

  const schedule = parseAll(scheduleRaw, parseScheduleRecord);
  const students = parseAll(studentRaw, parseStudentRecord);

  const grouped = await groupScheduleIntoTasks(schedule.parsed, students.parsed, {
    collectionMonth: input.collectionMonth,
  });

  const invalidRecords = [...grouped.invalidRecords, ...schedule.failures, ...students.failures];

  // 预填值不在问卷下拉里时扫码后会静默失败。
  // 学生：业务方要求自动同步，把本月课表学生追加进「学生姓名」下拉。只追加不删除——
  // 删掉单选选项会清空历史答卷里的这个值。姓名取学生表「学生姓名」，不带课表里「姓名-手机尾号」的后缀。
  // 老师：仍只提示，由教务在飞书里手动加。
  let studentsAddedToForm: string[] = [];
  let studentsMissingFromForm: string[] = [];
  let teachersMissingFromForm: string[] = [];
  if (grouped.tasks.length > 0) {
    const studentNames = [...new Set(grouped.tasks.map((task) => task.studentName))];
    if (!input.dryRun) {
      studentsAddedToForm = (
        await ensureSelectFieldOptions({
          client: input.client,
          appToken: input.config.feedbackAppToken,
          tableId: input.config.responseTableId,
          fieldName: "学生姓名",
          requiredNames: studentNames,
        })
      ).addedNames;
    }
    const fields = await input.client.listAllFields({
      appToken: input.config.feedbackAppToken,
      tableId: input.config.responseTableId,
    });
    studentsMissingFromForm = planSelectOptionAppend({
      fields,
      fieldName: "学生姓名",
      requiredNames: studentNames,
    }).missingNames;
    teachersMissingFromForm = planSelectOptionAppend({
      fields,
      fieldName: "老师姓名",
      requiredNames: [...new Set(grouped.tasks.map((task) => task.teacherCanonicalName))],
    }).missingNames;
  }

  const existing = await input.repository.listByCollectionMonth(input.collectionMonth);
  const plan = await buildTaskSyncPlan({
    existing,
    drafts: grouped.tasks,
    publicTokenPepper: input.publicTokenPepper,
    now: input.now,
  });
  if (!input.dryRun) await input.repository.applySyncPlan(plan);

  return {
    plan,
    collectionMonth: input.collectionMonth,
    courseMonth,
    scheduleRecordsScanned: scheduleRaw.length,
    created: plan.create.length,
    updated: plan.update.length,
    unchanged: plan.unchanged.length,
    excludedRecords: grouped.excludedRecords,
    reviewRecords: grouped.reviewRecords,
    invalidRecords,
    studentsAddedToForm,
    studentsMissingFromForm,
    teachersMissingFromForm,
  };
}
