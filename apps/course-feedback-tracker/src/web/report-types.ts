import { roundScore } from "./scoring";

/** feedback_score_results 里存的形状（由 functions/feedback-score/index.py 算出）。 */

export type MetricId = "learning_effect" | "responsibility" | "charisma";
export type Dimension = "total" | "student" | "parent";

export const METRICS: Array<{ id: MetricId; label: string; short: string }> = [
  { id: "learning_effect", label: "学习提升效果", short: "学习提升" },
  { id: "responsibility", label: "责任心与服务态度", short: "责任心" },
  { id: "charisma", label: "个人魅力", short: "个人魅力" },
];

export const DIMENSION_LABELS: Record<Dimension, string> = { total: "总", student: "学生", parent: "家长" };

export interface TeacherScore {
  teacher: string;
  rank: number | null;
  /** 三项总分平均（三位小数）；任一项无评分则为 null，不参与排名 */
  overall: number | null;
  scores: Record<MetricId, number | null>;
  hours: number;
  responses: number;
  matchedResponses: number;
  coverage: number;
  respondedStudents?: number;
  /** 实时计算的月份才有：各指标 总/学生/家长 */
  variants?: Record<string, Record<Dimension, number | null>>;
  counts?: Record<string, Record<Dimension, number>>;
}

export interface DetailRow {
  teacher: string;
  student: string;
  identity: string;
  sourceIdentities: string;
  submittedAt: string;
  matched: boolean;
  weight: number;
  scores: Record<string, number | null>;
  /** 按规则把 4 分算作 5 分的字段（scores 里仍是原始分） */
  adjusted?: Record<string, "streak" | "strict-rater">;
  texts: { improvement_student?: string; improvement_parent?: string; suggestion?: string };
}

export interface MonthReport {
  month: string;
  /** draft：收集中，刷新反馈会更新；final：收集月份已结束，定稿 */
  status?: "draft" | "final";
  /** live：按快照计算；history：老看板已公布的分数（分项按原始反馈补算） */
  source: "live" | "history";
  computedAt?: string;
  teachers: TeacherScore[];
  stats?: {
    feedbackRows?: number;
    dedupedRecords?: number;
    matchedRecords?: number;
    mergedRecords?: number;
    teacherCount?: number;
    totalHours?: number;
    unmappedScoreTexts?: Record<string, Record<string, number>>;
    breakdownFrom?: "feishu" | "legacy-detail";
    adjustedScores?: { streak: number; "strict-rater": number };
  };
  error?: string;
}

export interface CumulativeTeacher {
  teacher: string;
  rank: number | null;
  overall: number | null;
  scores: Record<MetricId, number | null>;
  hours: number;
  monthCount: number;
  firstMonth: string;
  lastMonth: string;
  coverage: number;
  responses: number;
}

export interface Contribution {
  month: string;
  teacher: string;
  hours: number;
  source: "live" | "history";
  scores: Record<MetricId, number | null>;
}

export interface SyncedAt {
  kind: "schedule" | "feedback";
  month: string;
  rowCount: number;
  syncedAt: string;
}

export function formatScore(value: number | null | undefined): string {
  return value == null ? "无评分" : roundScore(value).toFixed(3);
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatHours(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** 「2026-09」→「2026年9月」 */
export function monthName(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return `${year}年${value}月`;
}

export function formatMoment(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
