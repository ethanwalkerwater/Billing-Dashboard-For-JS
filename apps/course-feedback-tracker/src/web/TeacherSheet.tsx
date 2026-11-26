import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { FeedbackEntry } from "./FeedbackEntry";
import { studentCourseTrend } from "./missing-feedback";
import type { MissingStudent } from "./missing-feedback";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { DIMENSION_LABELS, METRICS, formatHours, formatPercent, formatScore, monthName } from "./report-types";
import type { Contribution, DetailRow, Dimension, TeacherScore } from "./report-types";

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** 点老师名打开：这位老师的分项得分、课时覆盖、逐月贡献（累计）和每一条反馈。 */
export function TeacherSheet({
  open,
  onClose,
  teacher,
  subtitle,
  score,
  detail,
  contributions,
  missing,
  courseMonth,
  currentTasks,
  nextTasks,
}: {
  open: boolean;
  onClose: () => void;
  teacher: string;
  subtitle: string;
  score?: Pick<TeacherScore, "rank" | "overall" | "scores" | "hours" | "coverage" | "responses" | "variants" | "counts">;
  detail?: DetailRow[];
  contributions?: Contribution[];
  /** 月度评分：课表上有课但还没收到反馈的学生，用来查覆盖率缺口 */
  missing?: MissingStudent[];
  courseMonth?: string;
  /** null 表示该月课表还没同步，不能当成 0 节。 */
  currentTasks?: StoredFeedbackTask[] | null;
  nextTasks?: StoredFeedbackTask[] | null;
}) {
  const dimensions: Dimension[] = score?.variants ? ["total", "student", "parent"] : ["total"];
  const rows = (detail ?? []).filter((row) => row.teacher === teacher);
  const missingHours = (missing ?? []).reduce((sum, row) => sum + row.hours, 0);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="text-xl">{teacher}</SheetTitle>
          <SheetDescription>{subtitle}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-8">
          {score ? (
            <>
              <div className="grid grid-cols-4 gap-3 rounded-lg border p-4">
                <Fact label="排名" value={score.rank ?? "—"} />
                <Fact label="总评分" value={formatScore(score.overall)} />
                <Fact label="课时" value={formatHours(score.hours)} />
                <Fact label="覆盖率" value={formatPercent(score.coverage)} />
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>指标</TableHead>
                    {dimensions.map((dimension) => (
                      <TableHead key={dimension} className="text-right">
                        {DIMENSION_LABELS[dimension]}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {METRICS.map((metric) => (
                    <TableRow key={metric.id}>
                      <TableCell className="font-medium">{metric.label}</TableCell>
                      {dimensions.map((dimension) => {
                        const value = dimension === "total" ? score.scores[metric.id] : score.variants?.[metric.id]?.[dimension];
                        const count = score.counts?.[metric.id]?.[dimension];
                        return (
                          <TableCell key={dimension} className={cn("text-right font-mono tabular-nums", value == null && "text-muted-foreground")}>
                            {formatScore(value)}
                            {count != null ? <span className="text-muted-foreground ml-1 text-xs">({count})</span> : null}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {score.variants ? (
                <p className="text-muted-foreground -mt-3 text-xs">括号里是有效评分份数。没评到的学生按当月该项平均分补齐后再加权，所以份数少的老师分数不会虚高。</p>
              ) : null}
            </>
          ) : null}

          {contributions && contributions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">逐月贡献（按当月课时加权）</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>月份</TableHead>
                    <TableHead className="text-right">课时</TableHead>
                    {METRICS.map((metric) => (
                      <TableHead key={metric.id} className="text-right">
                        {metric.short}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contributions.map((row) => (
                    <TableRow key={row.month}>
                      <TableCell>
                        {monthName(row.month)}
                        {row.source === "history" ? <span className="text-muted-foreground ml-1 text-xs">定稿</span> : null}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatHours(row.hours)}</TableCell>
                      {METRICS.map((metric) => (
                        <TableCell
                          key={metric.id}
                          className={cn("text-right font-mono tabular-nums", row.scores[metric.id] == null && "text-muted-foreground")}
                        >
                          {formatScore(row.scores[metric.id])}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {detail ? (
            <div className="flex flex-col">
              <Separator />
              <h3 className="pt-4 text-sm font-medium">
                本月反馈 <span className="text-muted-foreground font-normal">{rows.length} 份</span>
              </h3>
              {rows.length === 0 ? (
                <p className="text-muted-foreground py-6 text-sm">这个月没有收到对这位老师的反馈。</p>
              ) : (
                <div className="divide-y">
                  {rows.map((row, index) => (
                    <FeedbackEntry
                      key={`${row.student}-${row.submittedAt}-${index}`}
                      row={row}
                      courseTrend={
                        courseMonth
                          ? studentCourseTrend({ courseMonth, teacher: row.teacher, student: row.student, currentTasks: currentTasks ?? null, nextTasks: nextTasks ?? null })
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {missing ? (
            <div className="flex flex-col gap-2">
              <Separator />
              <h3 className="pt-2 text-sm font-medium">
                未评价{" "}
                <span className="text-muted-foreground font-normal">
                  {missing.length} 人
                  {missingHours > 0 ? ` · ${formatHours(missingHours)} 课时` : ""}
                </span>
              </h3>
              <p className="text-muted-foreground -mt-1 text-xs">课表上跟这位老师有课、但还没收到反馈的学生。按课时从多到少排，方便先追覆盖率缺口大的。</p>
              {missing.length === 0 ? (
                <p className="text-muted-foreground py-4 text-sm">都评过了。</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {missing.map((row) => (
                    <li key={row.student} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium">
                          <span className="truncate">{row.student}</span>
                          {row.declined ? <Badge variant="secondary">拒绝填写</Badge> : null}
                        </div>
                        {row.courses.length > 0 ? (
                          <div className="text-muted-foreground mt-0.5 truncate text-xs">{row.courses.join("、")}</div>
                        ) : null}
                      </div>
                      <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                        {row.hours > 0 ? formatHours(row.hours) : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
