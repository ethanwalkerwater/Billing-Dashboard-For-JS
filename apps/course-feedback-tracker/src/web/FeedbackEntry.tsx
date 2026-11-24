import { Quote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { identityLabel, improvementOptions, isNothingToImprove, suggestionText } from "./feedback-text";
import { METRICS } from "./report-types";
import type { DetailRow } from "./report-types";

/** 评分时把 4 分按 5 分算的两条规则，见 functions/feedback-score/index.py */
const ADJUST_RULES = {
  streak: { label: "连续 4 分", hint: "连续 3 个月给这位老师这一项打 4 分、每月都有课，本月的 4 分按 5 分算" },
  "strict-rater": { label: "评分标准高", hint: "本月给 2 位及以上老师打分、从没打过 5 分，4 分都按 5 分算" },
} as const;

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
export function FeedbackEntry({ row, showTeacher }: { row: DetailRow; showTeacher?: boolean }) {
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
          <Badge key={rule} variant="secondary" title={ADJUST_RULES[rule].hint}>
            {ADJUST_RULES[rule].label} · 4 分按 5 分
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
