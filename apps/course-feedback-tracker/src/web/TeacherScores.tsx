import { AlertTriangle, Download, FileSpreadsheet, Info, MessageSquareText, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { nameMatchKey, shiftMonth } from "@/domain";
import { cn } from "@/lib/utils";
import { PageHeader } from "./AppNav";
import type { Page } from "./AppNav";
import { FeedbackEntry } from "./FeedbackEntry";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { ScoreChart } from "./ScoreChart";
import type { ChartRow } from "./ScoreChart";
import { ScoreTable } from "./ScoreTable";
import { SyncStatus, useSyncTimes } from "./SyncStatus";
import { TeacherFilter } from "./TeacherFilter";
import { TeacherSheet } from "./TeacherSheet";
import { downloadCumulativeExcel, downloadMonthlyExcel, downloadScoresCsv, downloadTextsCsv } from "./export-scores";
import { hasSubstance, identityLabel } from "./feedback-text";
import { DIMENSION_LABELS, METRICS, formatHours, formatPercent, formatScore, monthName } from "./report-types";
import type { Contribution, CumulativeTeacher, DetailRow, Dimension, MetricId, MonthReport, TeacherScore } from "./report-types";
import { cumulative, rerankMonth } from "./scoring";
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

/** 「2026年9月课程」：评分对象是课程月份；这个月的反馈当月就能交，晚交的到下个月月底。 */
function courseLabel(month: string): string {
  return `${monthName(month)}课程`;
}

/** 「2026年2月 – 9月」 */
function rangeLabel(months: string[]): string {
  if (months.length === 0) return "无数据";
  const [first, last] = [months[0], months[months.length - 1]];
  if (first === last) return monthName(first);
  return first.slice(0, 4) === last.slice(0, 4) ? `${monthName(first)} – ${Number(last.slice(5))}月` : `${monthName(first)} – ${monthName(last)}`;
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

/** 4 分按 5 分算的两条规则，算法在 functions/feedback-score/index.py */
function AdjustNote({ report }: { report: MonthReport }) {
  const counts = report.stats?.adjustedScores;
  const total = counts ? counts.streak + counts["strict-rater"] : 0;
  return (
    <span title="连续 4 分：连续 3 个月给同一老师同一项打 4 分、每月都有课，本月的 4 分按 5 分算。评分标准高：本月给 2 位及以上老师打分、从没打过 5 分，4 分都按 5 分算。明细里显示为 4→5。">
      {" "}
      4 分按 5 分算的规则{total ? `本月改算 ${total} 项（连续 4 分 ${counts?.streak ?? 0}、评分标准高 ${counts?.["strict-rater"] ?? 0}）` : "本月没有命中"}，悬停看说明。
    </span>
  );
}

function StatusBadge({ report }: { report: MonthReport }) {
  if (report.source === "history") {
    return (
      <>
        <Badge variant="secondary">已公布</Badge>
        <span className="text-muted-foreground text-xs">
          分数为老看板已公布的定稿；学生/家长分项按{report.stats?.breakdownFrom === "legacy-detail" ? "老看板留存的逐条反馈" : "飞书原始答卷"}补算，仅供参考。
        </span>
      </>
    );
  }
  return report.status === "final" ? (
    <>
      <Badge variant="success">已定稿</Badge>
      <span className="text-muted-foreground text-xs">
        收集月份已结束，分数不再变化。同一学生对同一老师重复提交只算第一份；没评到的学生按当月平均分补齐。
        <AdjustNote report={report} />
      </span>
    </>
  ) : (
    <>
      <Badge variant="warning">收集中</Badge>
      <span className="text-muted-foreground text-xs">
        反馈还在陆续提交，每次刷新反馈后自动更新（{report.computedAt ? `本次计算于 ${report.computedAt.slice(5, 16).replace("T", " ")}` : ""}）。下月初自动定稿。
        <AdjustNote report={report} />
      </span>
    </>
  );
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
                title={metric === "overall" && item !== "total" ? "总评分是三项总分的平均，没有学生/家长之分；先选一项指标" : undefined}
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
        <p className="text-xs">{report?.error ?? "需要这个月的课表（点问卷跟踪页的「生成名单」）和收到的反馈。"}</p>
      </CardContent>
    </Card>
  );
}

function MonthlyView({ month, report, teachers, onSelect }: { month: string; report?: MonthReport; teachers: TeacherScore[]; onSelect: (teacher: string) => void }) {
  const [metric, setMetric] = useState<ChartMetric>("overall");
  const [dimension, setDimension] = useState<Dimension>("total");
  const [busy, setBusy] = useState(false);
  if (!report || report.teachers.length === 0) return <EmptyMonth month={month} report={report} />;

  const hasVariants = teachers.some((row) => row.variants);
  const effectiveDimension = hasVariants && metric !== "overall" ? dimension : "total";
  const scored = teachers.filter((row) => row.overall != null);
  const unmapped = Object.entries(report.stats?.unmappedScoreTexts ?? {});
  const chartRows: ChartRow[] = teachers.map((row) => ({
    teacher: row.teacher,
    value: chartValue(row, metric, effectiveDimension),
    hint: `${row.responses} 份 · 覆盖 ${formatPercent(row.coverage)}`,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge report={report} />
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="参与评分老师" value={`${scored.length} / ${teachers.length}`} hint="三项都有评分才参与排名" />
        <Stat
          label="有效反馈"
          value={report.stats?.mergedRecords ?? teachers.reduce((sum, row) => sum + row.responses, 0)}
          hint={
            report.stats?.feedbackRows != null
              ? `收到 ${report.stats.feedbackRows} 份 · 对上课时 ${report.stats.matchedRecords} 份`
              : "学生、家长同一对合并计 1 份"
          }
        />
        <Stat label="课时覆盖率" value={formatPercent(weightedCoverage(teachers))} hint="有反馈的学生课时 / 总课时" />
        <Stat label="平均总评分" value={formatScore(averageOverall(teachers))} hint={`共 ${formatHours(teachers.reduce((s, r) => s + r.hours, 0))} 课时`} />
      </section>

      {unmapped.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>有问卷选项没对应到分数，这些答案按缺失处理</AlertTitle>
          <AlertDescription>{unmapped.map(([column, answers]) => `${column}：${Object.keys(answers).join("、")}`).join("；")}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>老师排名 · {chartTitle(metric, effectiveDimension)}</CardTitle>
          <CardDescription>{courseLabel(month)}</CardDescription>
          <CardAction>
            <MetricPicker metric={metric} onMetric={setMetric} dimension={effectiveDimension} onDimension={setDimension} dimensionsEnabled={hasVariants} />
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
                void downloadMonthlyExcel(month, teachers, hasVariants).finally(() => setBusy(false));
              }}
            >
              <FileSpreadsheet /> 导出 Excel
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadScoresCsv(`teacher_scores-${month}.csv`, teachers)}>
              <Download /> 评分表 CSV
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScoreTable rows={teachers} onSelect={onSelect} />
        </CardContent>
      </Card>
    </div>
  );
}

function CumulativeView({
  result,
  months,
  range,
  onRange,
  onSelect,
}: {
  result: { months: string[]; teachers: CumulativeTeacher[]; contributions: Contribution[] };
  months: string[];
  range: { from: string; to: string };
  onRange: (range: { from: string; to: string }) => void;
  onSelect: (teacher: string) => void;
}) {
  const [metric, setMetric] = useState<ChartMetric>("overall");
  const [busy, setBusy] = useState(false);
  const { teachers, months: used } = result;
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
        <Stat label="统计范围" value={rangeLabel(used)} hint={`共 ${used.length} 个课程月份`} />
        <Stat label="参与评分老师" value={`${teachers.filter((row) => row.overall != null).length} / ${teachers.length}`} />
        <Stat label="累计课时" value={formatHours(teachers.reduce((sum, row) => sum + row.hours, 0))} />
        <Stat label="平均总评分" value={formatScore(averageOverall(teachers))} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>累计排名 · {chartTitle(metric, "total")}</CardTitle>
          <CardDescription>{rangeLabel(used)}</CardDescription>
          <CardAction>
            <MetricPicker metric={metric} onMetric={setMetric} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <ScoreChart rows={chartRows} title={`老师累计评分 ${rangeLabel(used)} · ${chartTitle(metric, "total")}`} fileName={`老师累计排名-${label}.png`} onSelect={onSelect} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>累计评分明细 · {rangeLabel(used)}</CardTitle>
          <CardDescription>「参与月数」是这位老师在范围内有课的月份数；点老师看逐月贡献。「评分表 CSV」与老看板 teacher_scores.csv 同格式，家长报告可直接使用</CardDescription>
          <CardAction className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void downloadCumulativeExcel(label, teachers, result.contributions).finally(() => setBusy(false));
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

function TextsView({
  month,
  detail,
  teachers: scores,
  onSelect,
}: {
  month: string;
  detail?: DetailRow[];
  teachers: TeacherScore[];
  onSelect: (teacher: string) => void;
}) {
  const [teachers, setTeachers] = useState<string[]>([]);
  const [identity, setIdentity] = useState<"all" | "学生" | "家长">("all");
  const [query, setQuery] = useState("");
  const [onlySubstance, setOnlySubstance] = useState(true);

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
    const byTeacher = new Map<string, DetailRow[]>();
    for (const row of filtered) byTeacher.set(row.teacher, [...(byTeacher.get(row.teacher) ?? []), row]);
    return [...byTeacher].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN"));
  }, [filtered]);

  if (!detail) {
    return (
      <Card>
        <CardContent className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
          <RefreshCw className="size-4 animate-spin" /> 正在读取{courseLabel(month)}的反馈…
        </CardContent>
      </Card>
    );
  }
  if (detail.length === 0) {
    return (
      <Card>
        <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center text-sm">
          <MessageSquareText className="size-5" />
          <p>{courseLabel(month)}没有逐条反馈数据。</p>
        </CardContent>
      </Card>
    );
  }

  const scoreOf = new Map(scores.map((row) => [row.teacher, row]));
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

const ADHOC_KEY = "teacher-scores:excluded";

/** 「排除老师」是每个人自己的浏览习惯，记在本机浏览器里；读写失败（隐私模式等）就当没有。 */
function loadAdhoc(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(ADHOC_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function TeacherScores({ page, onPageChange, onSignOut }: { page: Page; onPageChange: (page: Page) => void; onSignOut: () => void | Promise<void> }) {
  const { months, excluded, details, loadDetail, syncing, error, sync } = useTeacherReport();
  const syncTimes = useSyncTimes();
  const [chosenMonth, setChosenMonth] = useState<string | null>(null);
  const [view, setView] = useState<View>("monthly");
  const [range, setRange] = useState({ from: "", to: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [adhoc, setAdhoc] = useState<string[]>(loadAdhoc);

  // 默认看最近一个有结果的课程月份
  const courseMonth = chosenMonth ?? months?.[0]?.month ?? shiftMonth(currentCollectionMonth(), -1);
  const monthReport = months?.find((row) => row.month === courseMonth);

  useEffect(() => {
    void loadDetail(courseMonth);
  }, [courseMonth, loadDetail]);
  useEffect(() => {
    if (!syncing) void syncTimes.reload();
  }, [syncing, syncTimes.reload]);
  useEffect(() => {
    try {
      localStorage.setItem(ADHOC_KEY, JSON.stringify(adhoc));
    } catch {
      // 存不了就只在本次浏览生效
    }
  }, [adhoc]);

  // 长期不统计（问卷跟踪里设的）+ 本次临时排除，按姓名规范化后匹配（全角半角、空格不敏感）
  const permanentKeys = useMemo(() => new Set(excluded.map(nameMatchKey)), [excluded]);
  const hidden = useMemo(() => {
    const keys = new Set([...permanentKeys, ...adhoc.map(nameMatchKey)]);
    const names = new Set<string>();
    for (const month of months ?? []) for (const row of month.teachers) if (keys.has(nameMatchKey(row.teacher))) names.add(row.teacher);
    return names;
  }, [months, permanentKeys, adhoc]);
  const isPermanent = (teacher: string) => permanentKeys.has(nameMatchKey(teacher));

  const monthTeachers = useMemo(() => (monthReport ? rerankMonth(monthReport.teachers, hidden) : []), [monthReport, hidden]);
  const rangeMonths = useMemo(
    () => (months ?? []).filter((row) => (!range.from || row.month >= range.from) && (!range.to || row.month <= range.to) && row.teachers.length > 0),
    [months, range],
  );
  const cumulativeResult = useMemo(() => cumulative(rangeMonths, hidden), [rangeMonths, hidden]);
  const detail = details[courseMonth]?.filter((row) => !hidden.has(row.teacher));

  // 排除面板里列出的老师：当前视图里的（不含长期不统计的），带课时
  const filterOptions = useMemo(() => {
    if (view === "cumulative") {
      return cumulative(rangeMonths, new Set([...hidden].filter(isPermanent))).teachers.map((row) => ({ teacher: row.teacher, hours: row.hours }));
    }
    return (monthReport?.teachers ?? []).filter((row) => !isPermanent(row.teacher)).map((row) => ({ teacher: row.teacher, hours: row.hours }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, rangeMonths, monthReport, hidden, permanentKeys]);

  const selectedScore = selected ? monthTeachers.find((row) => row.teacher === selected) : undefined;
  const selectedCumulative = selected ? cumulativeResult.teachers.find((row) => row.teacher === selected) : undefined;

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
                <Select value={courseMonth} onValueChange={setChosenMonth}>
                  <SelectTrigger className="w-60" aria-label="课程月份">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(months ?? []).map((row) => (
                      <SelectItem key={row.month} value={row.month}>
                        {courseLabel(row.month)}
                        <span className="text-muted-foreground ml-2 text-xs">
                          {row.source === "history" ? "已公布" : row.status === "final" ? "已定稿" : "收集中"}
                        </span>
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
          status={<SyncStatus times={syncTimes.times} feedbackMonth={shiftMonth(currentCollectionMonth(), 1)} scheduleMonth={currentCollectionMonth()} syncing={syncing} />}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={view} onValueChange={(value) => setView(value as View)}>
            <TabsList>
              <TabsTrigger value="monthly">月度评分</TabsTrigger>
              <TabsTrigger value="cumulative">累计评分</TabsTrigger>
              <TabsTrigger value="texts">文字评价</TabsTrigger>
            </TabsList>
          </Tabs>
          <TeacherFilter teachers={filterOptions} excluded={adhoc} onChange={setAdhoc} permanentCount={excluded.length} />
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>出错了</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!months ? (
          <Card>
            <CardContent className="text-muted-foreground flex items-center justify-center gap-2 py-20 text-sm">
              <RefreshCw className="size-4 animate-spin" /> 正在读取老师评分…
            </CardContent>
          </Card>
        ) : (
          <>
            {view === "monthly" ? <MonthlyView key={courseMonth} month={courseMonth} report={monthReport} teachers={monthTeachers} onSelect={setSelected} /> : null}
            {view === "cumulative" ? (
              <CumulativeView result={cumulativeResult} months={months.map((row) => row.month)} range={range} onRange={setRange} onSelect={setSelected} />
            ) : null}
            {view === "texts" ? <TextsView key={courseMonth} month={courseMonth} detail={detail} teachers={monthTeachers} onSelect={setSelected} /> : null}
          </>
        )}
      </div>

      {selected ? (
        <TeacherSheet
          open
          onClose={() => setSelected(null)}
          teacher={selected}
          subtitle={view === "cumulative" ? `累计评分 · ${rangeLabel(cumulativeResult.months)}` : courseLabel(courseMonth)}
          score={view === "cumulative" ? selectedCumulative : selectedScore}
          detail={view === "cumulative" ? undefined : (detail ?? [])}
          contributions={view === "cumulative" ? cumulativeResult.contributions.filter((row) => row.teacher === selected) : undefined}
        />
      ) : null}
    </div>
  );
}
