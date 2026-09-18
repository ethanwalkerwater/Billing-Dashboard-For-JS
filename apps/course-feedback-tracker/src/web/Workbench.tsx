import { Download, ExternalLink, LogOut, RefreshCw, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TASK_STATUS_LABELS, collectionMonthToCourseMonth, shiftMonth } from "@/domain";
import type { TaskStatus } from "@/domain";
import { cn } from "@/lib/utils";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { BulkBar } from "./BulkBar";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { QrBatchDialog } from "./QrBatchDialog";
import { SyncDetails } from "./SyncDetails";
import type { SyncSummary } from "./SyncDetails";
import { TaskSheet } from "./TaskSheet";
import { TaskTable } from "./TaskTable";
import { UnmatchedBanner } from "./UnmatchedBanner";
import { callFeedbackApi } from "./cloudbase";
import { buildTasksCsv } from "./export-tasks";
import { downloadBlob, downloadQrZip } from "./qr";
import type { BatchProgress } from "./qr";
import { EMPTY_FILTERS, filterTasks, sortTasks, useTaskCounts, useWorkbenchData } from "./useWorkbenchData";
import type { SortKey } from "./useWorkbenchData";

const STATUS_ORDER: TaskStatus[] = ["unsent", "sent", "completed", "declined"];
const REPORT_URL = "https://jingshi-feedback-service.vercel.app/";

function currentCollectionMonth(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

/** 「2026年9月 · 8月课程」——不依赖浏览器语言，也把双月份口径说清楚。 */
function monthLabel(collectionMonth: string): string {
  const [year, month] = collectionMonth.split("-").map(Number);
  const courseMonth = Number(collectionMonthToCourseMonth(collectionMonth).slice(5));
  return `${year}年${month}月 · ${courseMonth}月课程`;
}

function Stat({
  label,
  value,
  hint,
  selected,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <Card
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === "Enter" || event.key === " ")) onClick();
      }}
      className={cn("gap-1 py-4", onClick && "hover:bg-accent/40 cursor-pointer transition-colors", selected && "border-primary ring-1 ring-primary")}
    >
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
      </CardHeader>
    </Card>
  );
}

export function Workbench({ onSignOut }: { onSignOut: () => void | Promise<void> }) {
  const [collectionMonth, setCollectionMonth] = useState(currentCollectionMonth);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTask, setActiveTask] = useState<StoredFeedbackTask | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("teacher");
  const [sortAsc, setSortAsc] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncSummary | null>(null);
  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const batchAbort = useRef<AbortController | null>(null);

  const data = useWorkbenchData(collectionMonth);
  const visible = useMemo(() => sortTasks(filterTasks(data.tasks, filters), sortKey, sortAsc), [data.tasks, filters, sortKey, sortAsc]);
  // 统计永远基于全部任务：卡片是给教务看当前月份整体状况的指标，点击只筛下面的表格，数字不动。
  const { counts, total, studentDone, parentDone, completionRate } = useTaskCounts(data.tasks);
  const teachers = useMemo(
    () => [...new Set(data.tasks.map((task) => task.teacherCanonicalName))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [data.tasks],
  );
  const students = useMemo(
    () => [...new Set(data.tasks.map((task) => task.studentName))].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [data.tasks],
  );
  const monthOptions = useMemo(() => {
    const now = currentCollectionMonth();
    return Array.from({ length: 12 }, (_, index) => shiftMonth(now, -index));
  }, []);
  const selectedTasks = visible.filter((task) => selected.has(task.taskId));

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label);
    try {
      setNotice(await action());
    } catch (cause) {
      setNotice(`${label}失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(null);
    }
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((value) => !value);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  async function changeStatus(next: TaskStatus) {
    await run(`标记${TASK_STATUS_LABELS[next]}`, async () => {
      const result = await data.updateStatus(selected, next);
      setSelected(new Set());
      return `已把 ${result.updated} 份改为「${TASK_STATUS_LABELS[next]}」${result.skipped > 0 ? `，${result.skipped} 份已有答卷未改动` : ""}`;
    });
  }

  async function downloadCsvFromApi(action: string, label: string) {
    await run(label, async () => {
      const result = await callFeedbackApi<{ csv: string; fileName: string }>({ action, collectionMonth });
      downloadBlob(new Blob([result.csv], { type: "text/csv;charset=utf-8" }), result.fileName);
      return `已导出 ${result.fileName}`;
    });
  }

  /** 二维码批量生成：进度走弹窗，可中途取消，完成后弹窗明确提示下载好了。 */
  async function zipSelected() {
    const controller = new AbortController();
    batchAbort.current = controller;
    setBusy("下载二维码");
    try {
      await downloadQrZip(selectedTasks, setBatch, controller.signal);
    } catch (cause) {
      setNotice(`下载二维码失败：${cause instanceof Error ? cause.message : String(cause)}`);
      setBatch(null);
    } finally {
      batchAbort.current = null;
      setBusy(null);
    }
  }

  const toggleFilter = (status: TaskStatus | "all") =>
    setFilters((current) => ({ ...current, status: current.status === status ? "all" : status }));

  return (
    <div className="bg-muted/40 min-h-screen">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6 lg:p-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">月度课程反馈</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={collectionMonth}
              onValueChange={(value) => {
                setCollectionMonth(value);
                setSelected(new Set());
                setSync(null);
              }}
            >
              <SelectTrigger className="w-52" aria-label="收集月份">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((month) => (
                  <SelectItem key={month} value={month}>
                    {monthLabel(month)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("生成名单", async () => {
                  const result = await callFeedbackApi<SyncSummary>({ action: "sync-tasks", collectionMonth });
                  setSync(result);
                  await data.reload();
                  return `名单已更新：新增 ${result.created} · 变更 ${result.updated} · 不变 ${result.unchanged}`;
                })
              }
            >
              <RefreshCw className={cn(busy === "生成名单" && "animate-spin")} /> 生成名单
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run("刷新反馈", async () => {
                  const result = await callFeedbackApi<SyncSummary>({ action: "sync-responses", collectionMonth });
                  setSync((current) => ({ ...current, ...result }));
                  await data.reload();
                  return `收到 ${result.monthTotal} 份 · 对上 ${result.matched} · 对不上 ${result.unlinked}`;
                })
              }
            >
              <RefreshCw className={cn(busy === "刷新反馈" && "animate-spin")} /> 刷新反馈
            </Button>
            <Separator orientation="vertical" className="mx-1 h-5" />
            <Button variant="ghost" size="icon" onClick={() => void onSignOut()} aria-label="退出登录">
              <LogOut />
            </Button>
          </div>
        </header>

        <UnmatchedBanner
          unlinked={data.unlinked}
          tasks={data.tasks}
          onAddAlias={async (alias) => {
            await data.addAlias(alias);
            setNotice(`已记住「${alias.alias}」＝「${alias.canonical}」，点「刷新反馈」即可自动对上`);
          }}
          onBind={async (input) => {
            await data.bindResponse(input);
            setNotice("已手动绑定，该任务已标记为已填写");
          }}
        />

        <section className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label="应发" value={total} selected={filters.status === "all"} onClick={() => toggleFilter("all")} />
          {STATUS_ORDER.map((status) => (
            <Stat
              key={status}
              label={TASK_STATUS_LABELS[status]}
              value={counts[status]}
              hint={status === "completed" && total > 0 ? `完成率 ${completionRate}%` : undefined}
              selected={filters.status === status}
              onClick={() => toggleFilter(status)}
            />
          ))}
          <Stat
            label="收到反馈"
            value={data.summary?.total ?? "—"}
            hint={data.summary ? `学生 ${studentDone} · 家长 ${parentDone}${data.summary.unlinked ? ` · 对不上 ${data.summary.unlinked}` : ""}` : undefined}
          />
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input
                value={filters.query}
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                placeholder="搜索学生、老师或课程"
                className="h-8 w-64 pl-8"
              />
            </div>
            <MultiSelectFilter
              label="老师"
              options={teachers}
              selected={filters.teachers}
              onChange={(next) => setFilters((current) => ({ ...current, teachers: next }))}
              className="w-40"
            />
            <MultiSelectFilter
              label="学生"
              options={students}
              selected={filters.students}
              onChange={(next) => setFilters((current) => ({ ...current, students: next }))}
              className="w-40"
            />
            <Select value={filters.respondent} onValueChange={(value) => setFilters((current) => ({ ...current, respondent: value as typeof current.respondent }))}>
              <SelectTrigger size="sm" className="w-40">
                <SelectValue placeholder="谁评了" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">谁评了 · 全部</SelectItem>
                <SelectItem value="student-yes">学生已评</SelectItem>
                <SelectItem value="student-no">学生未评</SelectItem>
                <SelectItem value="parent-yes">家长已评</SelectItem>
                <SelectItem value="parent-no">家长未评</SelectItem>
                <SelectItem value="both">双方都评了</SelectItem>
              </SelectContent>
            </Select>
            {notice ? <span className="text-muted-foreground ml-2 text-xs">{notice}</span> : null}
            {data.error ? <span className="text-destructive ml-2 text-xs">{data.error}</span> : null}
            <span className="text-muted-foreground ml-auto text-xs">
              {visible.length === data.tasks.length ? `共 ${data.tasks.length} 份` : `筛出 ${visible.length} / ${data.tasks.length} 份`}
            </span>
          </div>

          <TaskTable
            tasks={visible}
            selected={selected}
            onToggle={(taskId) =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(taskId)) next.delete(taskId);
                else next.add(taskId);
                return next;
              })
            }
            onToggleAll={() =>
              setSelected((current) => {
                const allSelected = visible.length > 0 && visible.every((task) => current.has(task.taskId));
                const next = new Set(current);
                for (const task of visible) {
                  if (allSelected) next.delete(task.taskId);
                  else next.add(task.taskId);
                }
                return next;
              })
            }
            onOpen={setActiveTask}
            sortKey={sortKey}
            sortAsc={sortAsc}
            onSort={toggleSort}
            loading={data.loading}
          />

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || visible.length === 0}
              onClick={() =>
                void run("导出名单", async () => {
                  downloadBlob(new Blob([buildTasksCsv(visible)], { type: "text/csv;charset=utf-8" }), `问卷任务-${collectionMonth}.csv`);
                  return `已导出 ${visible.length} 份`;
                })
              }
            >
              <Download /> 导出名单
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void downloadCsvFromApi("export-schedule-csv", "导出课表")}>
              <Download /> 导出课表
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void downloadCsvFromApi("export-feedback-csv", "导出反馈")}>
              <Download /> 导出反馈
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <Button variant="link" size="sm" asChild>
              <a href={REPORT_URL} target="_blank" rel="noreferrer">
                反馈报表 <ExternalLink />
              </a>
            </Button>
          </div>
        </section>

        {sync ? <SyncDetails summary={sync} /> : null}
      </div>

      <BulkBar
        selectedCount={selectedTasks.length}
        filteredCount={visible.length}
        totalCount={data.tasks.length}
        busy={busy !== null}
        onSelectAllFiltered={() => setSelected(new Set(visible.map((task) => task.taskId)))}
        onClear={() => setSelected(new Set())}
        onMarkSent={() => void changeStatus("sent")}
        onMarkDeclined={() => void changeStatus("declined")}
        onMarkUnsent={() => void changeStatus("unsent")}
        onDownloadZip={() => void zipSelected()}
        onExportCsv={() =>
          void run("导出选中", async () => {
            downloadBlob(new Blob([buildTasksCsv(selectedTasks)], { type: "text/csv;charset=utf-8" }), `问卷任务-${collectionMonth}-已选${selectedTasks.length}.csv`);
            return `已导出 ${selectedTasks.length} 份`;
          })
        }
      />

      <QrBatchDialog progress={batch} onCancel={() => batchAbort.current?.abort()} onClose={() => setBatch(null)} />

      <TaskSheet task={activeTask} onClose={() => setActiveTask(null)} />
    </div>
  );
}
