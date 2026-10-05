import { AlertTriangle, Check, CheckCircle2, ChevronDown, Copy, ExternalLink, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ISSUE_ORDER, SUBJECTS } from "@/domain/progress";
import type { Issue, Subject } from "@/domain/progress";
import { cn } from "@/lib/utils";
import { ALL_TIME, MonthRangePicker, inRange } from "./MonthRangePicker";
import type { MonthRange } from "./MonthRangePicker";
import { useProgressData } from "./useProgressData";
import type { SyncResult } from "./useProgressData";
import { MonthView, OverviewView, StudentView, TeacherView, recordUrl } from "./views";
import type { Nav } from "./views";

const SCORE_TABLE_URL = import.meta.env.VITE_FEISHU_SCORE_TABLE_URL as string | undefined;
const FORM_URL = import.meta.env.VITE_FEISHU_FORM_URL as string | undefined;

type Tab = "overview" | "teacher" | "month" | "student";

const TABS: Array<[Tab, string]> = [
  ["overview", "总览"],
  ["teacher", "老师"],
  ["month", "月度"],
  ["student", "学生"],
];

const clock = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

function changeText({ added, changed, removed }: SyncResult): string {
  const parts = [added && `新增 ${added} 条`, changed && `修改 ${changed} 条`, removed && `删除 ${removed} 条`].filter(Boolean);
  return parts.length > 0 ? `飞书成绩表${parts.join("、")}` : "飞书成绩表没有变化";
}

/**
 * 同步状态条：同步要 15–25 秒，期间页面显示的是上一次的数据，必须让人一眼看到。
 * 吸顶，滚到哪都看得见；同步完显示几秒「已是最新」，失败则一直留着直到重试。
 */
function SyncBanner({
  syncing,
  startedAt,
  syncedAt,
  lastSync,
  syncError,
  onRetry,
}: {
  syncing: boolean;
  startedAt: number | null;
  syncedAt: string | null;
  lastSync: SyncResult | null;
  syncError: string | null;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [syncing]);
  useEffect(() => {
    if (!lastSync) return;
    setShowDone(true);
    const timer = setTimeout(() => setShowDone(false), 8000);
    return () => clearTimeout(timer);
  }, [lastSync]);

  const stale = syncedAt ? `${clock(syncedAt)}（${ago(syncedAt)}）` : null;
  if (syncing) {
    const seconds = Math.max(0, Math.round((now - (startedAt ?? now)) / 1000));
    return (
      <div role="status" className="border-viz-up/30 bg-viz-up/8 sticky top-0 z-30 overflow-hidden rounded-lg border px-4 py-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Loader2 className="text-viz-up size-4 animate-spin" />
          <span className="font-medium">正在从飞书同步最新数据…</span>
          <span className="text-muted-foreground tabular-nums">已用 {seconds} 秒，通常 15–25 秒</span>
          <span className="text-muted-foreground w-full pl-7 text-xs sm:w-auto sm:pl-0">
            {stale ? `下面暂时是 ${stale} 的数据，同步完自动刷新` : "首次同步，完成后显示数据"}
          </span>
        </div>
        <div className="bg-viz-up/15 absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <div className="bg-viz-up h-full w-1/3 animate-[sync-bar_1.4s_ease-in-out_infinite]" />
        </div>
      </div>
    );
  }
  if (syncError) {
    return (
      <div role="alert" className="border-destructive/40 bg-destructive/8 sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-sm shadow-sm">
        <AlertTriangle className="text-destructive size-4" />
        <span className="font-medium">同步失败，数据可能不是最新</span>
        <span className="text-muted-foreground text-xs">
          {syncError}
          {stale ? ` · 下面是 ${stale} 的数据` : ""}
        </span>
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onRetry}>
          <RefreshCw /> 重试
        </Button>
      </div>
    );
  }
  if (showDone && lastSync) {
    return (
      <div role="status" className="border-success/30 bg-success/8 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-sm">
        <CheckCircle2 className="text-success size-4" />
        <span className="font-medium">已是最新数据</span>
        <span className="text-muted-foreground tabular-nums">
          用时 {lastSync.seconds} 秒 · {changeText(lastSync)}
        </span>
      </div>
    );
  }
  return null;
}

/** 待处理：数据不会悄悄丢，所有没计入的原因都列在这里。 */
function IssuesPanel({ issues, unknownTypes }: { issues: Issue[]; unknownTypes: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const counts = ISSUE_ORDER.map((kind) => [kind, issues.filter((issue) => issue.kind === kind).length] as const).filter(([, n]) => n > 0);
  const unknown = Object.entries(unknownTypes);
  if (counts.length === 0 && unknown.length === 0) return null;
  const sorted = [...issues].sort((a, b) => ISSUE_ORDER.indexOf(a.kind) - ISSUE_ORDER.indexOf(b.kind) || b.date.localeCompare(a.date));
  return (
    <Alert variant="warning">
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


export function Workbench({ onSignOut }: { onSignOut: () => void | Promise<void> }) {
  const { samples, records, issues, unknownTypes, syncedAt, loading, syncing, syncStartedAt, lastSync, syncError, error, sync } = useProgressData();
  const [tab, setTab] = useState<Tab>("overview");
  const [teachers, setTeachers] = useState<string[]>([]);
  const [student, setStudent] = useState<string | null>(null);
  const [range, setRange] = useState<MonthRange>(ALL_TIME);
  const [subjects, setSubjects] = useState<Set<Subject>>(new Set(SUBJECTS));
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(
    () => samples.filter((sample) => inRange(sample.date.slice(0, 7), range) && subjects.has(sample.subject)),
    [samples, range, subjects],
  );
  const months = useMemo(() => new Set(samples.map((sample) => sample.date.slice(0, 7))), [samples]);

  // 各视图之间跳转：点老师 / 学生名字直接切到对应视图并选中
  const nav: Nav = {
    teacher: (name) => {
      setTeachers([name]);
      setTab("teacher");
      window.scrollTo({ top: 0 });
    },
    student: (id) => {
      setStudent(id);
      setTab("student");
      window.scrollTo({ top: 0 });
    },
  };

  const toggleSubject = (subject: Subject) =>
    setSubjects((current) => {
      const next = new Set(current);
      if (next.has(subject) && next.size > 1) next.delete(subject);
      else next.add(subject);
      return next;
    });

  async function copyForm() {
    if (!FORM_URL) return;
    await navigator.clipboard.writeText(FORM_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="mx-auto grid max-w-[1400px] grid-cols-[minmax(0,1fr)] gap-4 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">雅思正向率</h1>
          <span className="text-muted-foreground text-xs" title={syncedAt ? `上次同步 ${clock(syncedAt)}` : undefined}>
            {syncedAt ? `数据更新于 ${ago(syncedAt)}` : "尚未同步"}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {FORM_URL ? (
              <Button variant="outline" size="sm" onClick={copyForm} title="发给老师，老师用它录入基线、阶段模考和实考成绩">
                {copied ? <Check /> : <Copy />}
                {copied ? "已复制" : "复制录入表单链接"}
              </Button>
            ) : null}
            {SCORE_TABLE_URL ? (
              <Button variant="outline" size="sm" asChild>
                <a href={SCORE_TABLE_URL} target="_blank" rel="noreferrer" title="在飞书里核验实考、改错、指定老师">
                  <ExternalLink />
                  飞书成绩表
                </a>
              </Button>
            ) : null}
            <Button size="sm" onClick={sync} disabled={syncing} title="从飞书读取最新成绩和课表，15–25 秒；每次打开网站也会自动同步">
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {syncing ? "同步中…" : "同步"}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onSignOut} title="退出登录">
              <LogOut />
            </Button>
          </div>
        </header>

        <SyncBanner syncing={syncing} startedAt={syncStartedAt} syncedAt={syncedAt} lastSync={lastSync} syncError={syncError} onRetry={sync} />

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <IssuesPanel issues={issues} unknownTypes={unknownTypes} />

        <section className="flex flex-wrap items-center gap-2">
          <nav className="bg-muted flex rounded-lg p-1" aria-label="视图">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={tab === key ? "page" : undefined}
                onClick={() => setTab(key)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                  tab === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </nav>
          <span className="bg-border mx-1 hidden h-6 w-px sm:block" />
          <MonthRangePicker value={range} onChange={setRange} available={months} />
          <div className="flex rounded-md border p-0.5" role="group" aria-label="科目">
            {SUBJECTS.map((subject) => (
              <button
                key={subject}
                type="button"
                aria-pressed={subjects.has(subject)}
                onClick={() => toggleSubject(subject)}
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-sm transition-colors",
                  subjects.has(subject) ? "bg-secondary text-foreground font-medium" : "text-muted-foreground/60 hover:bg-accent line-through",
                )}
              >
                {subject}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground ml-auto hidden text-xs lg:block">按考试日期筛选 · 每次实考的每一科算一条样本</span>
        </section>

        {loading ? (
          <p className="text-muted-foreground py-20 text-center text-sm">正在读取…</p>
        ) : samples.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground py-14 text-center text-sm">
              {syncing ? "正在从飞书读取数据…" : "还没有可统计的成绩。老师用录入表单提交、教务在飞书核验实考后点「同步」。"}
            </CardContent>
          </Card>
        ) : tab === "overview" ? (
          <OverviewView samples={filtered} subjects={subjects} nav={nav} />
        ) : tab === "teacher" ? (
          <TeacherView samples={filtered} teachers={teachers} onTeachers={setTeachers} nav={nav} />
        ) : tab === "month" ? (
          <MonthView samples={filtered} subjects={subjects} nav={nav} />
        ) : (
          <StudentView samples={filtered} records={records} student={student} onStudent={setStudent} nav={nav} />
        )}
      </div>
    </TooltipProvider>
  );
}
