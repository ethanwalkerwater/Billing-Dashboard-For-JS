import { CalendarDays, Quote, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { identityLabel, improvementOptions, isNothingToImprove, suggestionText } from "./feedback-text";
import { METRICS, SCORE_ADJUST_RULES } from "./report-types";
import type { DetailRow } from "./report-types";
import type { StudentCourseTrend } from "./missing-feedback";

/** 一份反馈里某项指标的分数：学生、家长各一份时都列出来；按规则改算的写成 4→5。 */
function metricScores(row: DetailRow, metricId: string): string {
  const shown = (field: string) => {
    const value = row.scores[field];
    return value != null && row.adjusted?.[field] ? `${value}→5` : value;
  };
  const student = shown(`${metricId}_student`);
  const parent = shown(`${metricId}_parent`);
  if (student != null && parent != null) return `学 ${student} · 家 ${parent}`;
  const value = student ?? parent;
  return value == null ? "—" : String(value);
}

/** 一条反馈：谁、什么时候、三项分数、改进方向、文字建议。文字评价页和老师抽屉共用。 */
function monthNumber(month: string): number {
  return Number(month.slice(5));
}

function CourseTrend({ trend }: { trend: StudentCourseTrend }) {
  const current = trend.currentLessons;
  const next = trend.nextLessons;
  const nextText =
    next == null
      ? `${monthNumber(trend.nextMonth)}月课表未同步`
      : next === 0
        ? `${monthNumber(trend.nextMonth)}月 0 节 · 未续课`
        : current != null && next < current
          ? `${monthNumber(trend.nextMonth)}月 ${next} 节 · 减少 ${current - next} 节`
          : current === 0
            ? `${monthNumber(trend.nextMonth)}月 ${next} 节 · 新增续课`
            : `${monthNumber(trend.nextMonth)}月 ${next} 节 · 已续课${current != null && next > current ? `，增加 ${next - current} 节` : ""}`;
  const warning = next != null && (next === 0 || (current != null && next < current));
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs" aria-label="课程续课情况">
      <CalendarDays className="size-3.5" />
      <Badge variant="outline">
        {current == null ? `${monthNumber(trend.currentMonth)}月课表未同步` : `${monthNumber(trend.currentMonth)}月 ${current} 节`}
      </Badge>
      <Badge variant={warning ? "warning" : "secondary"}>
        {warning ? <TriangleAlert className="size-3" /> : null}
        {nextText}
      </Badge>
    </div>
  );
}

export function FeedbackEntry({ row, showTeacher, courseTrend }: { row: DetailRow; showTeacher?: boolean; courseTrend?: StudentCourseTrend }) {
  const options = improvementOptions(row);
  const suggestion = suggestionText(row);
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{row.student}</span>
        {showTeacher ? <span className="text-muted-foreground">评 {row.teacher}</span> : null}
        <Badge variant="outline">{identityLabel(row)}</Badge>
        {!row.matched ? (
          <Badge variant="warning" title="这对师生在该月课表里没有课时，不参与加权">
            未匹配课时
          </Badge>
        ) : null}
        {[...new Set(Object.values(row.adjusted ?? {}))].map((rule) => (
          <Badge key={rule} variant="secondary" title={SCORE_ADJUST_RULES[rule].hint}>
            {SCORE_ADJUST_RULES[rule].label} · 4 分按 5 分
          </Badge>
        ))}
        <span className="text-muted-foreground ml-auto font-mono text-xs">{row.submittedAt.slice(5, 16)}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {METRICS.map((metric) => (
          <span key={metric.id}>
            {metric.short} <span className="text-foreground font-mono tabular-nums">{metricScores(row, metric.id)}</span>
          </span>
        ))}
      </div>
      {courseTrend ? <CourseTrend trend={courseTrend} /> : null}
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option, index) => (
            <span
              key={`${option}-${index}`}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs",
                isNothingToImprove(option) ? "text-muted-foreground bg-muted/50" : "border-warning/40 bg-warning/10",
              )}
            >
              {option}
            </span>
          ))}
        </div>
      ) : null}
      {suggestion ? (
        <p className="bg-muted/40 flex gap-2 rounded-md px-3 py-2 text-sm leading-relaxed">
          <Quote className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <span>{suggestion}</span>
        </p>
      ) : null}
    </div>
  );
}
