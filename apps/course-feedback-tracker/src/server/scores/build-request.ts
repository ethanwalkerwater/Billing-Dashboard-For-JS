import { courseMonthToCollectionMonth } from "../../domain";
import type { NameAlias } from "../tasks/types";

/**
 * 从这个课程月份起，老师分数由评分脚本按快照实时计算，并且重复反馈保留第一份（与问卷跟踪的任务占位一致）。
 * 之前的月份已经对外公布过，用导入的定稿分数（feedback_score_history），不重算。
 */
export const LIVE_SCORES_FROM = "2026-09";

export interface SnapshotRow {
  kind: "schedule" | "feedback";
  month: string;
  csv: string;
}

export interface ScoreHistoryRow {
  course_month: string;
  teacher: string;
  hours: number | string;
  responses: number;
  matched_responses: number;
  coverage: number | string;
  learning_effect: number | string | null;
  responsibility: number | string | null;
  charisma: number | string | null;
}

const toNumber = (value: number | string | null): number | null => (value === null || value === "" ? null : Number(value));

/** 拼 feedback-score 云函数的入参。纯函数，便于测试；读库和调用在 feedback-api 里。 */
export function buildScoreRequest(input: {
  snapshots: SnapshotRow[];
  history: ScoreHistoryRow[];
  aliases: NameAlias[];
  excludedTeachers: string[];
  teacherNames: string[];
  detailMonth?: string;
  cumulativeFrom?: string;
  cumulativeTo?: string;
}) {
  const csvOf = (kind: SnapshotRow["kind"], month: string) =>
    input.snapshots.find((row) => row.kind === kind && row.month === month)?.csv;

  // 课程月份 M 的分数 = M 月课表 + M+1 月收到的反馈。两份快照都在才算得出来。
  const months = input.snapshots
    .filter((row) => row.kind === "schedule")
    .map((row) => row.month)
    .sort()
    .flatMap((courseMonth) => {
      const feedbackCsv = csvOf("feedback", courseMonthToCollectionMonth(courseMonth));
      if (!feedbackCsv) return [];
      const live = courseMonth >= LIVE_SCORES_FROM;
      return [
        {
          courseMonth,
          scheduleCsv: csvOf("schedule", courseMonth)!,
          feedbackCsv,
          dedupeKeep: live ? "first" : "last",
          countsTowardCumulative: live,
        },
      ];
    });

  const historyByMonth = new Map<string, ScoreHistoryRow[]>();
  for (const row of input.history) {
    if (row.course_month >= LIVE_SCORES_FROM) continue;
    historyByMonth.set(row.course_month, [...(historyByMonth.get(row.course_month) ?? []), row]);
  }

  return {
    months,
    history: [...historyByMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, rows]) => ({
      month,
      rows: rows.map((row) => ({
        teacher: row.teacher,
        hours: Number(row.hours),
        responses: row.responses,
        matchedResponses: row.matched_responses,
        coverage: Number(row.coverage),
        scores: {
          learning_effect: toNumber(row.learning_effect),
          responsibility: toNumber(row.responsibility),
          charisma: toNumber(row.charisma),
        },
      })),
    })),
    aliases: input.aliases,
    excludedTeachers: input.excludedTeachers,
    teacherNames: input.teacherNames,
    detailMonth: input.detailMonth,
    cumulativeFrom: input.cumulativeFrom,
    cumulativeTo: input.cumulativeTo,
  };
}
