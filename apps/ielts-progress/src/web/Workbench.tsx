import { Check, ChevronDown, Copy, ExternalLink, Loader2, LogOut, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ISSUE_ORDER, KIND_LABELS, MIN_SAMPLES, OUTCOME_LABELS, SUBJECTS, averageDelta, groupTally, positiveRate, tally, teachersOf } from "@/domain/progress";
import type { Issue, Outcome, Sample, Subject } from "@/domain/progress";
import { cn } from "@/lib/utils";
import { Matrix, TeacherBars, pct, signed } from "./charts";
import type { TeacherRow } from "./charts";
import { useProgressData } from "./useProgressData";

const SCORE_TABLE_URL = import.meta.env.VITE_FEISHU_SCORE_TABLE_URL as string | undefined;
const FORM_URL = import.meta.env.VITE_FEISHU_FORM_URL as string | undefined;

type RangePreset = "all" | "3m" | "6m" | "year" | "custom";
type Source = "all" | "feishu" | "legacy";
type MatrixBy = "subject" | "month";

const RANGE_LABELS: Record<RangePreset, string> = { all: "全部时间", "3m": "近 3 个月", "6m": "近 6 个月", year: "今年", custom: "自定义" };
const SOURCE_LABELS: Record<Source, string> = { all: "全部来源", feishu: "飞书录入", legacy: "历史导入" };
const OUTCOME_DOT: Record<Outcome, string> = { up: "bg-viz-up", flat: "bg-viz-flat", down: "bg-viz-down" };

function shanghaiMonth(offset = 0): string {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15));
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(base).slice(0, 7);
}

function rangeOf(preset: RangePreset, from: string, to: string): [string, string] {
  if (preset === "3m") return [shanghaiMonth(-2), "9999-12"];
  if (preset === "6m") return [shanghaiMonth(-5), "9999-12"];
  if (preset === "year") return [`${shanghaiMonth().slice(0, 4)}-01`, "9999-12"];
  if (preset === "custom") return [from || "0000-01", to || "9999-12"];
  return ["0000-01", "9999-12"];
}

function timeLabel(iso: string | null): string {
  if (!iso) return "尚未同步";
  return `上次同步 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))}`;
}

const columnOf = (sample: Sample, by: MatrixBy) => (by === "subject" ? sample.subject : sample.date.slice(0, 7));

const recordUrl = (recordId: string | null) => (SCORE_TABLE_URL && recordId ? `${SCORE_TABLE_URL}&record=${recordId}` : null);

function Stat({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <Card className={cn("gap-1 py-4", className)}>
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardHeader>
    </Card>
  );
}

/** 待处理：数据不会悄悄丢，所有没计入的原因都列在这里。 */
function IssuesPanel({ issues, unknownTypes }: { issues: Issue[]; unknownTypes: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const counts = ISSUE_ORDER.map((kind) => [kind, issues.filter((issue) => issue.kind === kind).length] as const).filter(([, n]) => n > 0);
  const unknown = Object.entries(unknownTypes);
  if (counts.length === 0 && unknown.length === 0) return null;
  const sorted = [...issues].sort((a, b) => ISSUE_ORDER.indexOf(a.kind) - ISSUE_ORDER.indexOf(b.kind) || b.date.localeCompare(a.date));
  return (
    <Alert variant="warning" className="mt-4">
      <AlertDescription className="text-foreground grid gap-2">
        <button type="button" className="flex flex-wrap items-center gap-2 text-left text-sm" onClick={() => setOpen((value) => !value)}>
          <span className="font-medium">待处理</span>
          {counts.map(([kind, n]) => (
            <Badge key={kind} variant="outline" className="bg-background">
              {kind} {n}
            </Badge>
          ))}
          {unknown.length > 0 ? (
            <Badge variant="outline" className="bg-background">
              课表科目无法识别 {unknown.reduce((sum, [, n]) => sum + n, 0)}
            </Badge>
          ) : null}
          <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div className="grid gap-3">
            {sorted.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型</TableHead>
                    <TableHead>编号</TableHead>
                    <TableHead>学生</TableHead>
                    <TableHead>考试日期</TableHead>
                    <TableHead>说明</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((issue, index) => (
                    <TableRow key={`${issue.recordId}-${issue.kind}-${issue.subject ?? ""}-${index}`}>
                      <TableCell>{issue.kind}</TableCell>
                      <TableCell className="tabular-nums">#{issue.no}</TableCell>
                      <TableCell>{issue.studentName}</TableCell>
                      <TableCell className="tabular-nums">{issue.date || "—"}</TableCell>
                      <TableCell className="text-muted-foreground whitespace-normal">{issue.detail}</TableCell>
                      <TableCell>
                        {recordUrl(issue.recordId) ? (
                          <a className="text-primary inline-flex items-center gap-1 text-xs hover:underline" href={recordUrl(issue.recordId)!} target="_blank" rel="noreferrer">
                            飞书 <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            {unknown.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                课表里这些课程类型识别不出科目，没有计入任何老师：{unknown.map(([type, n]) => `${type}（${n} 节）`).join("、")}。
                改成「雅思写作」这类写法即可。
              </p>
            ) : null}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function SamplesTable({ samples }: { samples: Sample[] }) {
  const rows = useMemo(() => [...samples].sort((a, b) => b.date.localeCompare(a.date) || a.studentName.localeCompare(b.studentName, "zh-CN")), [samples]);
  return (
    <Table containerClassName="overflow-visible">
      <TableHeader>
        <TableRow>
          <TableHead>考试日期</TableHead>
          <TableHead>学生</TableHead>
          <TableHead>科目</TableHead>
          <TableHead>老师（期间课数）</TableHead>
          <TableHead>上一次</TableHead>
          <TableHead className="text-right">成绩</TableHead>
          <TableHead className="text-right">提分</TableHead>
          <TableHead>结果</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((sample) => (
          <TableRow key={sample.key}>
            <TableCell className="tabular-nums">{sample.date}</TableCell>
            <TableCell>{sample.studentName}</TableCell>
            <TableCell>{sample.subject}</TableCell>
            <TableCell className="whitespace-normal">
              {sample.teachers.map((item) => (item.lessons ? `${item.name} ${item.lessons}` : item.name)).join("、")}
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
              {sample.source === "legacy" ? "历史导入" : `${KIND_LABELS[sample.prevKind!]} ${sample.prevDate}`}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {sample.before} → {sample.after}
            </TableCell>
            <TableCell className="text-right tabular-nums">{signed(sample.delta)}</TableCell>
            <TableCell>
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", OUTCOME_DOT[sample.outcome])} />
                {OUTCOME_LABELS[sample.outcome]}
              </span>
            </TableCell>
            <TableCell>
              {recordUrl(sample.recordId) ? (
                <a className="text-primary inline-flex items-center gap-1 text-xs hover:underline" href={recordUrl(sample.recordId)!} target="_blank" rel="noreferrer">
                  成绩单 <ExternalLink className="size-3" />
                </a>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Workbench({ onSignOut }: { onSignOut: () => void | Promise<void> }) {
  const { samples, issues, unknownTypes, syncedAt, loading, syncing, error, sync } = useProgressData();
  const [preset, setPreset] = useState<RangePreset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [subjects, setSubjects] = useState<Set<Subject>>(new Set(SUBJECTS));
  const [source, setSource] = useState<Source>("all");
  const [matrixBy, setMatrixBy] = useState<MatrixBy>("subject");
  const [focus, setFocus] = useState<{ teacher: string | null; column: string | null }>({ teacher: null, column: null });
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const [start, end] = rangeOf(preset, from, to);
    return samples.filter((sample) => {
      const month = sample.date.slice(0, 7);
      return month >= start && month <= end && subjects.has(sample.subject) && (source === "all" || sample.source === source);
    });
  }, [samples, preset, from, to, subjects, source]);

  const overall = useMemo(() => tally(filtered), [filtered]);

  const teacherRows = useMemo<TeacherRow[]>(() => {
    const rows = [...groupTally(filtered, teachersOf)].map(([teacher, value]) => ({ teacher, tally: value }));
    const ranked = (row: TeacherRow) => row.tally.n >= MIN_SAMPLES;
    return rows.sort(
      (a, b) =>
        Number(ranked(b)) - Number(ranked(a)) ||
        (ranked(a) ? positiveRate(b.tally)! - positiveRate(a.tally)! : 0) ||
        b.tally.n - a.tally.n ||
        a.teacher.localeCompare(b.teacher, "zh-CN"),
    );
  }, [filtered]);

  const matrix = useMemo(() => {
    const columns = matrixBy === "subject" ? SUBJECTS.filter((subject) => subjects.has(subject)) : [...new Set(filtered.map((s) => s.date.slice(0, 7)))].sort();
    return {
      columns: columns as string[],
      cells: groupTally(filtered, (sample) => teachersOf(sample).map((teacher) => `${teacher}|${columnOf(sample, matrixBy)}`)),
      overall: groupTally(filtered, (sample) => [columnOf(sample, matrixBy)]),
    };
  }, [filtered, matrixBy, subjects]);

  const detail = useMemo(
    () =>
      filtered.filter(
        (sample) => (!focus.teacher || teachersOf(sample).includes(focus.teacher)) && (!focus.column || columnOf(sample, matrixBy) === focus.column),
      ),
    [filtered, focus, matrixBy],
  );

  const toggleSubject = (subject: Subject) =>
    setSubjects((current) => {
      const next = new Set(current);
      if (next.has(subject) && next.size > 1) next.delete(subject);
      else next.add(subject);
      return next;
    });

  const switchMatrix = (next: MatrixBy) => {
    setMatrixBy(next);
    setFocus((current) => ({ teacher: current.teacher, column: null }));
  };

  async function copyForm() {
    if (!FORM_URL) return;
    await navigator.clipboard.writeText(FORM_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">雅思正向率</h1>
          <span className="text-muted-foreground text-xs">{timeLabel(syncedAt)}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {FORM_URL ? (
              <Button variant="outline" size="sm" onClick={copyForm} title="发给老师，老师用它录入基线和实考成绩">
                {copied ? <Check /> : <Copy />}
                {copied ? "已复制" : "复制录入表单链接"}
              </Button>
            ) : null}
            {SCORE_TABLE_URL ? (
              <Button variant="outline" size="sm" asChild>
                <a href={SCORE_TABLE_URL} target="_blank" rel="noreferrer" title="在飞书里核验实考、改错">
                  <ExternalLink />
                  飞书成绩表
                </a>
              </Button>
            ) : null}
            <Button size="sm" onClick={sync} disabled={syncing} title="从飞书读取最新成绩和课表，约 20 秒；每天 7:00 也会自动同步">
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {syncing ? "同步中…" : "同步"}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onSignOut} title="退出登录">
              <LogOut />
            </Button>
          </div>
        </header>

        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <IssuesPanel issues={issues} unknownTypes={unknownTypes} />

        <section className="mt-5 flex flex-wrap items-center gap-2">
          <Select value={preset} onValueChange={(value) => setPreset(value as RangePreset)}>
            <SelectTrigger className="w-32" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RANGE_LABELS) as RangePreset[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {RANGE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {preset === "custom" ? (
            <span className="flex items-center gap-1.5 text-sm">
              <Input type="month" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 w-36" aria-label="起始月份" />
              至
              <Input type="month" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 w-36" aria-label="结束月份" />
            </span>
          ) : null}
          <div className="flex rounded-md border p-0.5" role="group" aria-label="科目">
            {SUBJECTS.map((subject) => (
              <button
                key={subject}
                type="button"
                aria-pressed={subjects.has(subject)}
                onClick={() => toggleSubject(subject)}
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-sm transition-colors",
                  subjects.has(subject) ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {subject}
              </button>
            ))}
          </div>
          <Select value={source} onValueChange={(value) => setSource(value as Source)}>
            <SelectTrigger className="w-28" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SOURCE_LABELS) as Source[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SOURCE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground ml-auto text-xs">按考试日期筛选 · 每次实考的每一科算一条样本</span>
        </section>

        {loading ? (
          <p className="text-muted-foreground py-20 text-center text-sm">正在读取…</p>
        ) : filtered.length === 0 ? (
          <Card className="mt-5">
            <CardContent className="text-muted-foreground py-14 text-center text-sm">
              {samples.length === 0 ? "还没有可统计的成绩。老师用录入表单提交、教务在飞书核验实考后点「同步」。" : "当前筛选下没有样本。"}
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="样本" value={String(overall.n)} hint="实考 × 科目，去重" className="col-span-2 md:col-span-1" />
              <Stat label="正向率" value={pct(positiveRate(overall))} hint="本次比上一次高" />
              <Stat label="平均提分" value={signed(averageDelta(overall), 2)} />
              <Stat label="持平" value={pct(overall.n ? overall.flat / overall.n : null)} hint={`${overall.flat} 条`} />
              <Stat label="下降" value={pct(overall.n ? overall.down / overall.n : null)} hint={`${overall.down} 条`} />
            </section>

            <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              <Card className="gap-3">
                <CardHeader>
                  <CardTitle className="text-base">老师对比</CardTitle>
                  <CardDescription>一科多位老师时每人各算一次；点一位老师看明细</CardDescription>
                </CardHeader>
                <CardContent className="px-4">
                  <TeacherBars
                    rows={teacherRows}
                    focused={focus.column ? null : focus.teacher}
                    onPick={(teacher) => setFocus((current) => (current.teacher === teacher && !current.column ? { teacher: null, column: null } : { teacher, column: null }))}
                  />
                </CardContent>
              </Card>

              <Card className="gap-3">
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <div className="grid gap-1.5">
                    <CardTitle className="text-base">正向率矩阵</CardTitle>
                    <CardDescription>颜色越深正向率越高；虚线格样本少于 {MIN_SAMPLES} 条</CardDescription>
                  </div>
                  <div className="flex shrink-0 rounded-md border p-0.5 text-sm" role="group" aria-label="矩阵列">
                    {(
                      [
                        ["subject", "按科目"],
                        ["month", "按月份"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={matrixBy === key}
                        onClick={() => switchMatrix(key)}
                        className={cn("rounded-[5px] px-2.5 py-1 transition-colors", matrixBy === key ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-accent")}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  <Matrix
                    teachers={teacherRows.map((row) => row.teacher)}
                    columns={matrix.columns}
                    cells={matrix.cells}
                    overall={matrix.overall}
                    active={focus}
                    onPick={(teacher, column) =>
                      setFocus((current) => (current.teacher === teacher && current.column === column ? { teacher: null, column: null } : { teacher, column }))
                    }
                  />
                </CardContent>
              </Card>
            </div>

            <Card className="mt-4 gap-3">
              <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                <CardTitle className="text-base">明细</CardTitle>
                <span className="text-muted-foreground text-sm tabular-nums">{detail.length} 条</span>
                {focus.teacher || focus.column ? (
                  <Badge variant="secondary" className="gap-1">
                    {[focus.teacher, focus.column].filter(Boolean).join(" · ")}
                    <button type="button" onClick={() => setFocus({ teacher: null, column: null })} aria-label="清除">
                      <X className="size-3" />
                    </button>
                  </Badge>
                ) : null}
              </CardHeader>
              <CardContent className="max-h-[560px] overflow-auto px-2 [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:bg-card">
                <SamplesTable samples={detail} />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
