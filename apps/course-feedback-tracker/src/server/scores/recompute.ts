import { courseMonthToCollectionMonth } from "../../domain";
import type { NameAlias } from "../tasks/types";

/**
 * 从这个课程月份起，老师分数由评分脚本按快照计算，并且重复反馈保留第一份（与问卷跟踪的任务占位一致）。
 * 之前的月份已经对外公布过，是导入的定稿（feedback_score_results.source = history），不自动重算。
 */
export const LIVE_SCORES_FROM = "2026-09";

/** 评分脚本或入参口径变了就加一，所有未定稿月份下次刷新时会重算。 */
export const SCORE_ENGINE_VERSION = "1";

export interface ScoreRequest {
  courseMonth: string;
  scheduleCsv: string;
  feedbackCsv: string;
  dedupeKeep: "first" | "last";
  aliases: NameAlias[];
  teacherNames: string[];
}

export interface ScoreResponse {
  ok: boolean;
  error?: string;
  teachers?: unknown[];
  stats?: Record<string, unknown>;
  detail?: unknown[];
}

export interface StoredResult {
  course_month: string;
  status: "draft" | "final";
  source: "live" | "history";
  teachers: unknown[];
  stats: Record<string, unknown>;
  detail: unknown[];
  error: string | null;
  inputs_hash: string | null;
  computed_at: string;
}

export interface ScoreStore {
  snapshot(kind: "schedule" | "feedback", month: string): Promise<string | undefined>;
  result(courseMonth: string): Promise<Pick<StoredResult, "status" | "source" | "inputs_hash"> | undefined>;
  saveResult(row: StoredResult): Promise<void>;
  aliases(): Promise<NameAlias[]>;
  teacherNames(): Promise<string[]>;
}

/** 课程月份 M 的反馈在 M+1 月收集；M+1 月过完，M 就定稿。 */
export function isFinalMonth(courseMonth: string, currentMonth: string): boolean {
  return currentMonth > courseMonthToCollectionMonth(courseMonth);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type RecomputeOutcome = "history" | "final" | "missing-input" | "unchanged" | "computed";

/**
 * 只在输入真的变了时才算：课表快照、答卷快照、别名、老师显示名和算法版本一起做哈希，
 * 和上次存的一样就直接返回。刷新反馈后答卷没变（最常见的情况）不会调用评分函数。
 */
export async function recomputeMonth(input: {
  store: ScoreStore;
  compute: (request: ScoreRequest) => Promise<ScoreResponse>;
  courseMonth: string;
  currentMonth: string;
  /** 手动重算：已定稿的月份也重算一次 */
  force?: boolean;
}): Promise<RecomputeOutcome> {
  const { store, courseMonth } = input;
  if (courseMonth < LIVE_SCORES_FROM) return "history";
  const existing = await store.result(courseMonth);
  if (existing?.status === "final" && !input.force) return "final";

  const [scheduleCsv, feedbackCsv, aliases, teacherNames] = await Promise.all([
    store.snapshot("schedule", courseMonth),
    store.snapshot("feedback", courseMonthToCollectionMonth(courseMonth)),
    store.aliases(),
    store.teacherNames(),
  ]);
  if (!scheduleCsv || !feedbackCsv) return "missing-input";

  const request: ScoreRequest = { courseMonth, scheduleCsv, feedbackCsv, dedupeKeep: "first", aliases, teacherNames };
  const status = isFinalMonth(courseMonth, input.currentMonth) ? "final" : "draft";
  const hash = await sha256(JSON.stringify({ v: SCORE_ENGINE_VERSION, request }));
  if (!input.force && existing?.inputs_hash === hash && existing.status === status) return "unchanged";

  const response = await input.compute(request);
  await store.saveResult({
    course_month: courseMonth,
    status,
    source: "live",
    teachers: response.ok ? (response.teachers ?? []) : [],
    stats: response.ok ? (response.stats ?? {}) : {},
    detail: response.ok ? (response.detail ?? []) : [],
    error: response.ok ? null : (response.error ?? "评分计算失败"),
    inputs_hash: hash,
    computed_at: new Date().toISOString(),
  });
  return "computed";
}
