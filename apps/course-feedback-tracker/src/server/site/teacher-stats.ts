/**
 * 官网（jsjy.asia/teachers）要的老师数据：累计评分 + 课堂体验三项偏好，只用已定稿的月份。
 * 累计评分和老师评分页「累计」是同一个函数（src/web/scoring.ts cumulative）：月度分 × 当月课时加权；
 * 偏好把每月存的「偏右侧选择 × 课时」和、课时和直接相加，位置 = 加权和 ÷ 课时和 × 100。
 */
import type { MonthPreferences, StoredResult } from "../scores/recompute";
import { cumulative, roundScore } from "../../web/scoring";
import type { MetricId, MonthReport, TeacherScore } from "../../web/report-types";

export const PREFERENCE_AXES = ["classStyle", "teachingPace", "classroomInteraction"] as const;
export type PreferenceAxis = (typeof PREFERENCE_AXES)[number];

export type ScoreResultRow = Pick<StoredResult, "course_month" | "status" | "source" | "preferences"> & { teachers: TeacherScore[] };

export interface SiteTeacher {
  name: string;
  hours: number;
  /** 三位小数（ROUND_HALF_UP），与老师评分页一致 */
  scores: Record<MetricId, number | null>;
  overall: number | null;
  preferences: Record<PreferenceAxis, { position: number; responseCount: number } | null>;
}

export function buildTeacherStats(rows: ScoreResultRow[]): { months: string[]; teachers: SiteTeacher[] } {
  const final = rows.filter((row) => row.status === "final");
  const reports: MonthReport[] = final.map((row) => ({ month: row.course_month, source: row.source, teachers: row.teachers }));
  const { months, teachers } = cumulative(reports, new Set());

  const sums = new Map<string, MonthPreferences[string]>();
  for (const row of final) {
    for (const [teacher, axes] of Object.entries(row.preferences ?? {})) {
      const total = sums.get(teacher) ?? {};
      for (const [axis, item] of Object.entries(axes)) {
        const sum = (total[axis] ??= { weighted: 0, hours: 0, responses: 0 });
        sum.weighted += item.weighted;
        sum.hours += item.hours;
        sum.responses += item.responses;
      }
      sums.set(teacher, total);
    }
  }
  const preferencesOf = (teacher: string) =>
    Object.fromEntries(
      PREFERENCE_AXES.map((axis) => {
        const sum = sums.get(teacher)?.[axis];
        return [axis, sum && sum.hours > 0 ? { position: Math.round((sum.weighted / sum.hours) * 100), responseCount: sum.responses } : null];
      }),
    ) as SiteTeacher["preferences"];

  const scored = new Set(teachers.map((teacher) => teacher.teacher));
  return {
    months,
    teachers: [
      ...teachers.map((teacher) => ({
        name: teacher.teacher,
        hours: Math.round(teacher.hours * 100) / 100,
        scores: Object.fromEntries(
          Object.entries(teacher.scores).map(([metric, value]) => [metric, value == null ? null : roundScore(value)]),
        ) as SiteTeacher["scores"],
        overall: teacher.overall,
        preferences: preferencesOf(teacher.teacher),
      })),
      ...[...sums.keys()]
        .filter((name) => !scored.has(name))
        .map((name) => ({
          name,
          hours: 0,
          scores: { learning_effect: null, responsibility: null, charisma: null },
          overall: null,
          preferences: preferencesOf(name),
        })),
    ],
  };
}
