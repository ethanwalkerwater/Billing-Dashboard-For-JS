import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { METRICS, formatHours, formatPercent, formatScore } from "./report-types";
import type { MetricId } from "./report-types";

export interface ScoreTableRow {
  teacher: string;
  rank: number | null;
  overall: number | null;
  scores: Record<MetricId, number | null>;
  hours: number;
  coverage: number;
  responses: number;
  monthCount?: number;
}

type SortKey = "rank" | "teacher" | "hours" | "responses" | "coverage" | "monthCount" | MetricId;

/** 反馈不到 3 份的老师分数波动大，标出来，别和样本充足的老师直接比。 */
const THIN_SAMPLE = 3;

function compareNullable(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return a - b;
}

export function ScoreTable({
  rows,
  showMonths,
  onSelect,
}: {
  rows: ScoreTableRow[];
  showMonths?: boolean;
  onSelect: (teacher: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [asc, setAsc] = useState(true);
  const [showUnscored, setShowUnscored] = useState(false);
  const unscored = rows.filter((row) => row.overall == null).length;

  const sorted = useMemo(() => {
    const value = (row: ScoreTableRow): number | null | undefined => {
      if (sortKey === "rank") return row.rank;
      if (sortKey === "teacher") return null;
      if (sortKey === "hours" || sortKey === "responses" || sortKey === "coverage" || sortKey === "monthCount") return row[sortKey];
      return row.scores[sortKey];
    };
    return [...rows].sort((a, b) => {
      if (sortKey === "teacher") return (asc ? 1 : -1) * a.teacher.localeCompare(b.teacher, "zh-CN");
      // 无评分永远排在最后，不随升降序跳到最前面。
      const left = value(a);
      const right = value(b);
      if (left == null || right == null) return compareNullable(left, right);
      return (asc ? 1 : -1) * (left - right) || a.teacher.localeCompare(b.teacher, "zh-CN");
    });
  }, [rows, sortKey, asc]);

  function head(label: string, key: SortKey, className?: string) {
    const active = key === sortKey;
    return (
      <TableHead key={key} className={className}>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-8", className?.includes("text-right") ? "-mr-3 ml-auto flex" : "-ml-3")}
          onClick={() => {
            if (active) setAsc((current) => !current);
            else {
              setSortKey(key);
              // 分数、课时默认从高到低看；排名、姓名默认从小到大。
              setAsc(key === "rank" || key === "teacher");
            }
          }}
        >
          {label}
          {active ? (
            asc ? (
              <ArrowUp className="size-3.5" />
            ) : (
              <ArrowDown className="size-3.5" />
            )
          ) : (
            <ChevronsUpDown className="size-3.5 opacity-50" />
          )}
        </Button>
      </TableHead>
    );
  }

  const visible = showUnscored ? sorted : sorted.filter((row) => row.overall != null);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {head("排名", "rank", "w-16")}
            {head("老师", "teacher")}
            {METRICS.map((metric) => head(metric.short, metric.id, "text-right"))}
            <TableHead className="text-right font-semibold">总评分</TableHead>
            {head(showMonths ? "累计课时" : "课时", "hours", "text-right")}
            {showMonths ? head("月份", "monthCount", "text-right") : head("反馈", "responses", "text-right")}
            {head("覆盖率", "coverage", "text-right")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.teacher} className="cursor-pointer" onClick={() => onSelect(row.teacher)}>
              <TableCell className="text-muted-foreground font-mono tabular-nums">{row.rank ?? "—"}</TableCell>
              <TableCell>
                <span className="font-medium">{row.teacher}</span>
                {!showMonths && row.responses < THIN_SAMPLE ? (
                  <Badge
                    variant="outline"
                    className="text-muted-foreground ml-2 font-normal"
                    title={`只有 ${row.responses} 份反馈，分数仅供参考`}
                  >
                    样本少
                  </Badge>
                ) : null}
              </TableCell>
              {METRICS.map((metric) => (
                <TableCell
                  key={metric.id}
                  className={cn("text-right font-mono tabular-nums", row.scores[metric.id] == null && "text-muted-foreground text-xs")}
                >
                  {formatScore(row.scores[metric.id])}
                </TableCell>
              ))}
              <TableCell
                className={cn(
                  "text-right font-mono font-semibold tabular-nums",
                  row.overall == null && "text-muted-foreground text-xs font-normal",
                )}
              >
                {formatScore(row.overall)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatHours(row.hours)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{showMonths ? row.monthCount : row.responses}</TableCell>
              <TableCell className="text-muted-foreground text-right font-mono tabular-nums">{formatPercent(row.coverage)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {unscored > 0 ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground mt-2" onClick={() => setShowUnscored((value) => !value)}>
          {showUnscored ? `收起 ${unscored} 位无评分老师` : `显示 ${unscored} 位无评分老师（三项不全或没有反馈，不参与排名）`}
        </Button>
      ) : null}
    </>
  );
}
