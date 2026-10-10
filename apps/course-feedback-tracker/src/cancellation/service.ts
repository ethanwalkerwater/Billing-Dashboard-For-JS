/**
 * 学生自助取消课程的流程编排：专属链接 → 选课 → 一次性取消编号 → 飞书问卷 → 核验写回 → 通知。
 *
 * 所有外部依赖（飞书课表、问卷表、数据库、消息）都经 CancellationDeps 注入，
 * 这里只写流程本身，测试用内存实现即可覆盖。
 */
import {
  cancellationTier,
  listCancellableLessons,
  validateCancellation,
} from "./rules";
import type { CancellableLesson, CancellationReason, CancellationTier, ListedLesson } from "./rules";
import { formatLessonTime, groupAlertCard, groupCancellationCard, teacherCancellationCard } from "./messages";
import type { FeishuCard } from "./messages";

/** 取消编号的有效期：学生在选课页点确认后，30 分钟内提交问卷才有效。 */
export const INTENT_TTL_MS = 30 * 60_000;

export interface CancelLink {
  token: string;
  /** 课表「学生」关联的学生表记录 ID（测试表若是文本字段则为学生名） */
  studentKey: string;
  studentName: string;
  active: boolean;
}

export type IntentStatus = "pending" | "applied" | "rejected";

export interface CancelIntent {
  intentId: string;
  token: string;
  studentKey: string;
  studentName: string;
  scheduleRecordId: string;
  /** 例：10/09（周五）19:30-21:30 · IG英语，工作台取消记录直接显示 */
  lessonLabel?: string;
  teacherName?: string;
  lessonStartMs?: number;
  createdMs: number;
  expiresMs: number;
  status: IntentStatus;
}

export interface IntentOutcome {
  status: Exclude<IntentStatus, "pending">;
  requestRecordId: string;
  tier?: CancellationTier;
  reason?: CancellationReason;
  message: string;
  processedMs: number;
}

/** 飞书「取消申请」表里学生提交的一行 */
export interface CancelRequest {
  recordId: string;
  intentId: string;
  reason: CancellationReason;
  note: string;
  hasSickProof: boolean;
  submittedMs: number;
  /** 已写过处理结果的申请不再处理（飞书事件可能重复推送） */
  processed: boolean;
}

export interface CancellationDeps {
  now(): number;
  randomId(): string;
  formUrl: string;
  links: { find(token: string): Promise<CancelLink | null> };
  intents: {
    create(intent: CancelIntent): Promise<void>;
    get(intentId: string): Promise<CancelIntent | null>;
    /** 只有 pending 的编号才会被改；返回 false 表示已被别的请求处理过 */
    finish(intentId: string, outcome: IntentOutcome): Promise<boolean>;
  };
  schedule: {
    listWindow(fromMs: number, toMs: number): Promise<CancellableLesson[]>;
    get(recordId: string): Promise<CancellableLesson | null>;
    writeCancellation(recordId: string, tier: CancellationTier): Promise<void>;
  };
  requests: {
    get(recordId: string): Promise<CancelRequest | null>;
    writeResult(recordId: string, result: string): Promise<void>;
  };
  notify: {
    user(openId: string, card: FeishuCard): Promise<void>;
    group(card: FeishuCard): Promise<void>;
  };
}

export class CancellationError extends Error {
  constructor(
    readonly code: "INVALID_LINK" | "LESSON_NOT_FOUND" | "NOT_CANCELLABLE",
    message: string,
  ) {
    super(message);
    this.name = "CancellationError";
  }
}

async function activeLink(deps: CancellationDeps, token: string): Promise<CancelLink> {
  const link = token ? await deps.links.find(token) : null;
  if (!link?.active) throw new CancellationError("INVALID_LINK", "链接无效或已停用，请联系教务获取新的取消链接");
  return link;
}

export async function listLessonsForLink(
  deps: CancellationDeps,
  token: string,
): Promise<{ studentName: string; lessons: ListedLesson[]; nowMs: number }> {
  const link = await activeLink(deps, token);
  const nowMs = deps.now();
  const day = 24 * 3_600_000;
  // 课表按上课时间取一个超集（飞书日期过滤只精确到天），精确窗口由 listCancellableLessons 判断
  const lessons = await deps.schedule.listWindow(nowMs - 2 * day, nowMs + 16 * day);
  return { studentName: link.studentName, lessons: listCancellableLessons(lessons, link.studentKey, nowMs), nowMs };
}

export const FORM_INTENT_FIELD = "取消编号";

export function buildCancelFormUrl(baseUrl: string, intentId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set(`prefill_${FORM_INTENT_FIELD}`, intentId);
  url.searchParams.set(`hide_${FORM_INTENT_FIELD}`, "1");
  return url.toString();
}

export async function createIntent(
  deps: CancellationDeps,
  token: string,
  scheduleRecordId: string,
): Promise<{ intentId: string; formUrl: string; expiresMs: number }> {
  const link = await activeLink(deps, token);
  const lesson = await deps.schedule.get(scheduleRecordId);
  if (!lesson) throw new CancellationError("LESSON_NOT_FOUND", "没有找到这节课，请刷新页面后重试");
  const nowMs = deps.now();
  const check = validateCancellation({ lesson, studentRecordId: link.studentKey, submittedMs: nowMs });
  if (!check.ok) throw new CancellationError("NOT_CANCELLABLE", check.message);

  const intent: CancelIntent = {
    intentId: deps.randomId(),
    token,
    studentKey: link.studentKey,
    studentName: link.studentName,
    scheduleRecordId,
    lessonLabel: `${formatLessonTime(lesson)} · ${lesson.courseName}`,
    teacherName: lesson.teacherName,
    lessonStartMs: lesson.startMs,
    createdMs: nowMs,
    expiresMs: nowMs + INTENT_TTL_MS,
    status: "pending",
  };
  await deps.intents.create(intent);
  return { intentId: intent.intentId, formUrl: buildCancelFormUrl(deps.formUrl, intent.intentId), expiresMs: intent.expiresMs };
}

export type ProcessResult =
  | { status: "applied"; tier: CancellationTier }
  | { status: "rejected"; message: string }
  | { status: "skipped"; message: string };

const TIER_LABEL: Record<CancellationTier, string> = {
  "0h-70%": "收取 70% 课时费",
  "2h-50%": "收取 50% 课时费",
  "6h-30%": "收取 30% 课时费",
  "提前取消-0%": "提前 6 小时以上，不收费",
  "学生病假-0%": "病假，默认不收费，待教务核实",
};

export function tierLabel(tier: CancellationTier): string {
  return TIER_LABEL[tier];
}

/**
 * 处理一条问卷提交。幂等：同一条申请、同一个取消编号只会写一次课表。
 * 事件里的业务字段不可信，只用 record id 回读飞书原始记录。
 */
export async function processRequest(deps: CancellationDeps, requestRecordId: string): Promise<ProcessResult> {
  const request = await deps.requests.get(requestRecordId);
  if (!request) return { status: "skipped", message: "申请记录不存在" };
  if (request.processed) return { status: "skipped", message: "申请已处理" };

  const reject = async (message: string, intent?: CancelIntent, lesson?: CancellableLesson): Promise<ProcessResult> => {
    const processedMs = deps.now();
    if (intent) {
      const won = await deps.intents.finish(intent.intentId, {
        status: "rejected",
        requestRecordId,
        reason: request.reason,
        message,
        processedMs,
      });
      if (!won) return { status: "skipped", message: "取消编号已被处理" };
    }
    await deps.requests.writeResult(requestRecordId, `未生效：${message}`);
    await deps.notify.group(groupAlertCard({ message, studentName: intent?.studentName, lesson, requestRecordId }));
    return { status: "rejected", message };
  };

  const intent = request.intentId ? await deps.intents.get(request.intentId) : null;
  if (!intent) return reject("取消编号无效（可能是直接打开了问卷，没有从取消链接进入）");
  if (intent.status !== "pending") return reject("这个取消编号已经用过", undefined);
  if (request.submittedMs > intent.expiresMs) return reject("取消编号已过期（超过 30 分钟才提交问卷）", intent);

  const lesson = await deps.schedule.get(intent.scheduleRecordId);
  if (!lesson) return reject("课表里找不到这节课（可能已被删除或改期）", intent);
  const check = validateCancellation({ lesson, studentRecordId: intent.studentKey, submittedMs: request.submittedMs });
  if (!check.ok) return reject(check.message, intent, lesson);

  const { tier } = cancellationTier(lesson, request.submittedMs, request.reason);
  const won = await deps.intents.finish(intent.intentId, {
    status: "applied",
    requestRecordId,
    tier,
    reason: request.reason,
    message: tierLabel(tier),
    processedMs: deps.now(),
  });
  if (!won) return { status: "skipped", message: "取消编号已被处理" };

  // ponytail: 写课表失败只重试 3 次（FeishuClient 内置）；仍失败就报警，由教务手动补写
  try {
    await deps.schedule.writeCancellation(lesson.recordId, tier);
  } catch (error) {
    const message = `写入课表失败，请教务手动在课表「临时取消」填写 ${tier}：${error instanceof Error ? error.message : String(error)}`;
    await deps.requests.writeResult(requestRecordId, `待处理：${message}`);
    await deps.notify.group(groupAlertCard({ message, studentName: intent.studentName, lesson, requestRecordId }));
    return { status: "rejected", message };
  }

  await deps.requests.writeResult(requestRecordId, `已生效：${tier}（${tierLabel(tier)}）`);
  const context = { studentName: intent.studentName, lesson, tier, tierText: tierLabel(tier), request };
  let teacherNotified = false;
  if (lesson.teacherOpenId) {
    try {
      await deps.notify.user(lesson.teacherOpenId, teacherCancellationCard(context));
      teacherNotified = true;
    } catch {
      teacherNotified = false;
    }
  }
  await deps.notify.group(groupCancellationCard({ ...context, teacherNotified }));
  return { status: "applied", tier };
}
