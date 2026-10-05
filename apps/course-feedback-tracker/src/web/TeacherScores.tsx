import { AlertTriangle, Download, FileSpreadsheet, Info, MessageSquareText, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { courseMonthToCollectionMonth, shiftMonth } from "@/domain";
import { cn } from "@/lib/utils";
import { PageHeader } from "./AppNav";
import type { Page } from "./AppNav";
import { FeedbackEntry } from "./FeedbackEntry";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { ScoreChart } from "./ScoreChart";
import type { ChartRow } from "./ScoreChart";
import { ScoreTable } from "./ScoreTable";
import { SyncStatus } from "./SyncStatus";
import { TeacherSheet } from "./TeacherSheet";
import { downloadCumulativeExcel, downloadMonthlyExcel, downloadScoresCsv, downloadTextsCsv } from "./export-scores";
import { hasSubstance, identityLabel } from "./feedback-text";
import { DIMENSION_LABELS, METRICS, formatHours, formatPercent, formatScore, monthName } from "./report-types";
import type { Dimension, MetricId, MonthReport, TeacherReport, TeacherScore } from "./report-types";
import { currentCollectionMonth, useTeacherReport } from "./useTeacherReport";

type View = "monthly" | "cumulative" | "texts";
type ChartMetric = MetricId | "overall";

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
      </CardHeader>
    </Card>
  );
}

/** 「2026年9月课程 · 10月收集」：课程月份是评分对象，收集月份是反馈提交的月份。 */
function courseLabel(month: string): string {
  const collection = Number(courseMonthToCollectionMonth(month).slice(5));
  return `${monthName(month)}课程 · ${collection}月收集`;
}

/** 按课时加权的覆盖率：课时多的老师占比大，和评分权重的口径一致。 */
function weightedCoverage(rows: Array<{ hours: number; coverage: number }>): number | null {
  const hours = rows.reduce((sum, row) => sum + row.hours, 0);
  return hours > 0 ? rows.reduce((sum, row) => sum + row.coverage * row.hours, 0) / hours : null;
}

function averageOverall(rows: Array<{ overall: number | null }>): number | null {
  const values = rows.map((row) => row.overall).filter((value): value is number => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function MetricPicker({
  metric,
  onMetric,
  dimension,
  onDimension,
  dimensionsEnabled,
}: {
  metric: ChartMetric;
  onMetric: (metric: ChartMetric) => void;
  dimension?: Dimension;
  onDimension?: (dimension: Dimension) => void;
  dimensionsEnabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={metric} onValueChange={(value) => onMetric(value as ChartMetric)}>
        <TabsList>
          <TabsTrigger value="overall">总评分</TabsTrigger>
          {METRICS.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.short}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {dimension && onDimension ? (
        <Tabs value={dimension} onValueChange={(value) => onDimension(value as Dimension)}>
          <TabsList>
            {(["total", "student", "parent"] as Dimension[]).map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                disabled={!dimensionsEnabled || (metric === "overall" && item !== "total")}
                title={!dimensionsEnabled ? "历史定稿月份只有总分" : metric === "overall" ? "总评分只有总维度" : undefined}
              >
                {DIMENSION_LABELS[item]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}
    </div>
  );
}

function chartValue(row: TeacherScore, metric: ChartMetric, dimension: Dimension): number | null {
  if (metric === "overall") return row.overall;
  if (dimension === "total") return row.scores[metric];
  return row.variants?.[metric]?.[dimension] ?? null;
}

function chartTitle(metric: ChartMetric, dimension: Dimension): string {
  const label = metric === "overall" ? "总评分" : METRICS.find((item) => item.id === metric)!.label;
  return dimension === "total" || metric === "overall" ? label : `${label}（${DIMENSION_LABELS[dimension]}）`;
}

function EmptyMonth({ month, report }: { month: string; report?: MonthReport }) {
  return (
    <Card>
      <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center text-sm">
        <Info className="size-5" />
        <p>{courseLabel(month)}还算不出分数。</p>
        <p className="text-xs">
          {report?.error ?? "需要这个月的课表（点问卷跟踪页的「生成名单」）和下个月收到的反馈。"}
        </p>
      </CardContent>
    </Card>
  );
}

function MonthlyView({ month, report, onSelect }: { month: string; report?: MonthReport; onSelect: (teacher: string) => void }) {
  const [metric, setMetric] = useState<ChartMetric>("overall");
  const [dimension, setDimension] = useState<Dimension>("total");
  const [busy, setBusy] = useState(false);
  if (!report || report.teachers.length === 0) return <EmptyMonth month={month} report={report} />;

  const live = report.source === "live";
  const effectiveDimension = live && metric !== "overall" ? dimension : "total";
  const scored = report.teachers.filter((row) => row.overall != null);
  const unmapped = Object.entries(report.stats?.unmappedScoreTexts ?? {});
  const chartRows: ChartRow[] = report.teachers.map((row) => ({
    teacher: row.teacher,
    value: chartValue(row, metric, effectiveDimension),
    hint: `${row.responses} 份 · 覆盖 ${formatPercent(row.coverage)}`,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={live ? "success" : "secondary"}>{live ? "实时计算" : "历史定稿"}</Badge>
        <span className="text-muted-foreground text-xs">
          {live
            ? "按当月课时加权；同一学生对同一老师重复提交只算第一份；没评到的学生按当月平均分补齐。"
            : "从老看板导入的已公布分数，不再重算，只有总分，没有学生/家长分项。"}
        </span>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="参与评分老师" value={`${scored.length} / ${report.teachers.length}`} hint="三项都有评分才参与排名" />
        <Stat
          label="有效反馈"
          value={live ? (report.stats?.mergedRecords ?? "—") : report.teachers.reduce((sum, row) => sum + row.responses, 0)}
          hint={live && report.stats ? `收到 ${report.stats.feedbackRows} 份 · 对上课时 ${report.stats.matchedRecords} 份` : "学生、家长同一对合并计 1 份"}
        />
        <Stat label="课时覆盖率" value={formatPercent(weightedCoverage(report.teachers))} hint="有反馈的学生课时 / 总课时" />
        <Stat label="平均总评分" value={formatScore(averageOverall(report.teachers))} hint={`共 ${formatHours(report.teachers.reduce((s, r) => s + r.hours, 0))} 课时`} />
      </section>

      {unmapped.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>有问卷选项没对应到分数，这些答案按缺失处理</AlertTitle>
          <AlertDescription>
            {unmapped.map(([column, answers]) => `${column}：${Object.keys(answers).join("、")}`).join("；")}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>老师排名 · {chartTitle(metric, effectiveDimension)}</CardTitle>
          <CardDescription>{courseLabel(month)}</CardDescription>
          <CardAction>
            <MetricPicker metric={metric} onMetric={setMetric} dimension={effectiveDimension} onDimension={setDimension} dimensionsEnabled={live} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScoreChart
            rows={chartRows}
            title={`${courseLabel(month)} · ${chartTitle(metric, effectiveDimension)}`}
            fileName={`老师排名-${month}-${chartTitle(metric, effectiveDimension)}.png`}
            onSelect={onSelect}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>评分明细</CardTitle>
          <CardDescription>点列名排序，点老师看分项和每一条反馈</CardDescription>
          <CardAction className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void downloadMonthlyExcel(month, report.teachers, live).finally(() => setBusy(false));
              }}
            >
              <FileSpreadsheet /> 导出 Excel
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadScoresCsv(`teacher_scores-${month}.csv`, report.teachers)}>
              <Download /> 评分表 CSV
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScoreTable rows={report.teachers} onSelect={onSelect} />
        </CardContent>
      </Card>
    </div>
  );
}

function CumulativeView({
  report,
  months,
  range,
  onRange,
  onSelect,
}: {
  report: TeacherReport;
  months: string[];
  range: { from: string; to: string };
  onRange: (range: { from: string; to: string }) => void;
  onSelect: (teacher: string) => void;
}) {
  const [metric, setMetric] = useState<ChartMetric>("overall");
  const [busy, setBusy] = useState(false);
  const { teachers, months: used } = report.cumulative;
  const label = used.length ? `${used[0]}~${used[used.length - 1]}` : "无数据";
  const ascending = [...months].sort();
  const chartRows: ChartRow[] = teachers.map((row) => ({
    teacher: row.teacher,
    value: metric === "overall" ? row.overall : row.scores[metric],
    hint: `${row.monthCount} 个月 · ${formatHours(row.hours)} 课时`,
  }));

  const monthSelect = (value: string, onChange: (value: string) => void, placeholder: string) => (
    <Select value={value || "all"} onValueChange={(next) => onChange(next === "all" ? "" : next)}>
      <SelectTrigger size="sm" className="w-36">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{placeholder}</SelectItem>
        {ascending.map((month) => (
          <SelectItem key={month} value={month}>
            {monthName(month)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">课程月份</span>
        {monthSelect(range.from, (from) => onRange({ ...range, from }), "最早")}
        <span className="text-muted-foreground">至</span>
        {monthSelect(range.to, (to) => onRange({ ...range, to }), "最新")}
        <span className="text-muted-foreground ml-2 text-xs">先按月算出老师各项分数，再按老师每月实际课时加权平均。课时多的月份影响更大。</span>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="统计月份" value={used.length} hint={used.length ? `${monthName(used[0])} 至 ${monthName(used[used.length - 1])}` : undefined} />
        <Stat label="参与评分老师" value={`${teachers.filter((row) => row.overall != null).length} / ${teachers.length}`} />
        <Stat label="累计课时" value={formatHours(teachers.reduce((sum, row) => sum + row.hours, 0))} />
        <Stat label="平均总评分" value={formatScore(averageOverall(teachers))} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>累计排名 · {chartTitle(metric, "total")}</CardTitle>
          <CardDescription>{label}</CardDescription>
          <CardAction>
            <MetricPicker metric={metric} onMetric={setMetric} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScoreChart rows={chartRows} title={`老师累计评分 ${label} · ${chartTitle(metric, "total")}`} fileName={`老师累计排名-${label}.png`} onSelect={onSelect} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>累计评分明细</CardTitle>
          <CardDescription>「评分表 CSV」和老看板 teacher_scores.csv 同格式，家长报告可直接使用</CardDescription>
          <CardAction className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void downloadCumulativeExcel(label, teachers, report.cumulative.contributions).finally(() => setBusy(false));
              }}
            >
              <FileSpreadsheet /> 导出 Excel（含逐月贡献）
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadScoresCsv("teacher_scores.csv", teachers)}>
              <Download /> 评分表 CSV
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScoreTable rows={teachers} showMonths onSelect={onSelect} />
        </CardContent>
      </Card>
    </div>
  );
}

function TextsView({ month, report, onSelect }: { month: string; report?: MonthReport; onSelect: (teacher: string) => void }) {
  const [teachers, setTeachers] = useState<string[]>([]);
  const [identity, setIdentity] = useState<"all" | "学生" | "家长">("all");
  const [query, setQuery] = useState("");
  const [onlySubstance, setOnlySubstance] = useState(true);
  const detail = report?.detail;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const wanted = new Set(teachers);
    return (detail ?? []).filter((row) => {
      if (wanted.size > 0 && !wanted.has(row.teacher)) return false;
      if (identity !== "all" && !identityLabel(row).includes(identity)) return false;
      if (onlySubstance && !hasSubstance(row)) return false;
      if (!needle) return true;
      return [row.teacher, row.student, ...Object.values(row.texts)].join(" ").toLowerCase().includes(needle);
    });
  }, [detail, teachers, identity, query, onlySubstance]);

  const groups = useMemo(() => {
    const byTeacher = new Map<string, typeof filtered>();
    for (const row of filtered) byTeacher.set(row.teacher, [...(byTeacher.get(row.teacher) ?? []), row]);
    return [...byTeacher].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN"));
  }, [filtered]);

  if (!detail) {
    return (
      <Card>
        <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center text-sm">
          <MessageSquareText className="size-5" />
          <p>{courseLabel(month)}没有逐条反馈数据。</p>
          <p className="text-xs">2026年5月课程之前的月份只导入了老看板的月度分数。</p>
        </CardContent>
      </Card>
    );
  }

  const scoreOf = new Map((report?.teachers ?? []).map((row) => [row.teacher, row]));
  const allTeachers = [...new Set(detail.map((row) => row.teacher))].sort((a, b) => a.localeCompare(b, "zh-CN"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索老师、学生或评价内容" className="h-8 w-64 pl-8" />
        </div>
        <MultiSelectFilter label="老师" options={allTeachers} selected={teachers} onChange={setTeachers} className="w-40" />
        <Select value={identity} onValueChange={(value) => setIdentity(value as typeof identity)}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部身份</SelectItem>
            <SelectItem value="学生">学生</SelectItem>
            <SelectItem value="家长">家长</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={onlySubstance} onCheckedChange={(value) => setOnlySubstance(value === true)} />
          只看有具体建议的
        </label>
        <span className="text-muted-foreground ml-auto text-xs">
          {filtered.length} / {detail.length} 份
        </span>
        <Button variant="outline" size="sm" onClick={() => downloadTextsCsv(`文字评价-${month}.csv`, filtered)} disabled={filtered.length === 0}>
          <Download /> 导出 CSV
        </Button>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-12 text-center text-sm">
            没有符合条件的评价{onlySubstance ? "。大部分反馈选的是「已经很好了」，取消勾选「只看有具体建议的」可以看到全部。" : "。"}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map(([teacher, rows]) => {
            const score = scoreOf.get(teacher);
            return (
              <Card key={teacher} className="gap-2">
                <CardHeader>
                  <CardTitle>
                    <button type="button" className="hover:underline" onClick={() => onSelect(teacher)}>
                      {teacher}
                    </button>
                  </CardTitle>
                  <CardDescription>
                    {rows.length} 份评价{score ? ` · 总评分 ${formatScore(score.overall)}${score.rank ? ` · 第 ${score.rank} 名` : ""}` : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className="divide-y">
                  {rows.map((row, index) => (
                    <FeedbackEntry key={`${row.student}-${row.submittedAt}-${index}`} row={row} />
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TeacherScores({ page, onPageChange, onSignOut }: { page: Page; onPageChange: (page: Page) => void; onSignOut: () => void | Promise<void> }) {
  const [courseMonth, setCourseMonth] = useState(() => shiftMonth(currentCollectionMonth(), -1));
  const [view, setView] = useState<View>("monthly");
  const [range, setRange] = useState({ from: "", to: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const { report, loading, syncing, error, sync } = useTeacherReport(courseMonth, range);

  const months = useMemo(
    () => [...new Set([courseMonth, ...Object.keys(report?.monthly ?? {})])].sort().reverse(),
    [courseMonth, report],
  );
  const monthReport = report?.monthly[courseMonth];
  const selectedScore = selected ? monthReport?.teachers.find((row) => row.teacher === selected) : undefined;
  const selectedCumulative = selected ? report?.cumulative.teachers.find((row) => row.teacher === selected) : undefined;

  return (
    <div className="bg-muted/40 min-h-screen">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6 lg:p-8">
        <PageHeader
          page={page}
          onPageChange={onPageChange}
          onSignOut={onSignOut}
          actions={
            <>
              {view !== "cumulative" ? (
                <Select value={courseMonth} onValueChange={setCourseMonth}>
                  <SelectTrigger className="w-56" aria-label="课程月份">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((month) => (
                      <SelectItem key={month} value={month}>
                        {courseLabel(month)}
                        {report?.monthly[month]?.source === "history" ? "（定稿）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button variant="outline" disabled={syncing} onClick={() => void sync()}>
                <RefreshCw className={cn(syncing && "animate-spin")} /> 刷新反馈
              </Button>
            </>
          }
          status={
            <SyncStatus
              times={report?.syncedAt ?? []}
              feedbackMonth={courseMonthToCollectionMonth(courseMonth)}
              scheduleMonth={courseMonth}
              syncing={syncing}
            />
          }
        />

        <Tabs value={view} onValueChange={(value) => setView(value as View)}>
          <TabsList>
            <TabsTrigger value="monthly">月度评分</TabsTrigger>
            <TabsTrigger value="cumulative">累计评分</TabsTrigger>
            <TabsTrigger value="texts">文字评价</TabsTrigger>
          </TabsList>
        </Tabs>

        {error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>评分计算失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!report ? (
          <Card>
            <CardContent className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
              <RefreshCw className="size-4 animate-spin" /> 正在计算老师评分…
            </CardContent>
          </Card>
        ) : (
          <div className={cn("transition-opacity", loading && "opacity-60")}>
            {view === "monthly" ? <MonthlyView key={courseMonth} month={courseMonth} report={monthReport} onSelect={setSelected} /> : null}
            {view === "cumulative" ? (
              <CumulativeView report={report} months={Object.keys(report.monthly)} range={range} onRange={setRange} onSelect={setSelected} />
            ) : null}
            {view === "texts" ? <TextsView key={courseMonth} month={courseMonth} report={monthReport} onSelect={setSelected} /> : null}
          </div>
        )}
      </div>

      {selected ? (
        <TeacherSheet
          open
          onClose={() => setSelected(null)}
          teacher={selected}
          subtitle={view === "cumulative" ? `累计评分 · ${report?.cumulative.months.length ?? 0} 个月` : courseLabel(courseMonth)}
          score={view === "cumulative" ? selectedCumulative : selectedScore}
          detail={view === "cumulative" ? undefined : monthReport?.detail}
          contributions={view === "cumulative" ? report?.cumulative.contributions.filter((row) => row.teacher === selected) : undefined}
        />
      ) : null}
    </div>
  );
}
