import { Download, EyeOff, Loader2, LogOut, Pencil, RefreshCw, Search, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { STATUS_LABELS } from "@/domain/income";
import type { AlertStatus, Rates } from "@/domain/income";
import { cn } from "@/lib/utils";
import { EditableCell } from "./EditableCell";
import { downloadExcel } from "./export-excel";
import { useIncomeData } from "./useIncomeData";
import type { TeacherLine } from "./useIncomeData";

const STATUS_VARIANT: Record<AlertStatus, "destructive" | "warning" | "success" | "secondary"> = {
  alert: "destructive",
  between: "warning",
  reached: "success",
  "no-base": "secondary",
};

function shanghaiMonth(offset = 0): string {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15));
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(base).slice(0, 7);
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return `${year}年${monthNumber}月`;
}

const yuan = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
function money(value: number | null | undefined): string {
  return value == null ? "—" : yuan.format(value);
}

const DASH = <span className="text-muted-foreground">—</span>;
const PEN = "text-muted-foreground ml-0.5 inline size-3 align-[-1px]";

/** 列宽（含义见表格上方的注释）；最后一列学生不定宽。 */
const COLUMN_WIDTHS = ["w-28", "w-16", "w-24", "w-20", "w-20", "w-24", "w-20", "w-24", "w-16", "w-24", "w-16", "w-20", "w-24", "w-16", "w-36", ""];

/** 三组系数的颜色：表头上色、数据列淡淡铺底，横着看不串组。 */
const GROUP_TONE = {
  max: "bg-amber-50 text-amber-800 shadow-[inset_0_3px_0_var(--color-amber-500),inset_0_-1px_0_var(--border)]",
  min: "bg-emerald-50 text-emerald-800 shadow-[inset_0_3px_0_var(--color-emerald-500),inset_0_-1px_0_var(--border)]",
  custom: "bg-indigo-50 text-indigo-800 shadow-[inset_0_3px_0_var(--color-indigo-500),inset_0_-1px_0_var(--border)]",
} as const;
const BAND = { max: "bg-amber-50/50", min: "bg-emerald-50/50", custom: "bg-indigo-50/50" } as const;

/** 某个系数下的一组结果：预测薪资、差额（预测 − 预警线）、还需课时。 */
interface Scenario {
  rate: number;
  predicted: number | null;
  margin: number | null;
  hours: number | null;
}

function scenarios(line: TeacherLine, rates: Rates): [Scenario, Scenario, Scenario | null] {
  const custom = line.settings.customRate;
  return [
    { rate: rates.max, predicted: line.predictedMax, margin: line.marginToAlert, hours: line.hoursToAlert },
    { rate: rates.min, predicted: line.predictedMin, margin: line.marginToTarget, hours: line.hoursToTarget },
    custom ? { rate: custom, predicted: line.predictedCustom, margin: line.marginCustom, hours: line.hoursCustom } : null,
  ];
}

/** 数字格悬停：用这一行的真实数字写出算式，核对哪格看哪格。 */
function Tip({ tip, children, className }: { tip: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("cursor-help", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{tip}</TooltipContent>
    </Tooltip>
  );
}

function AlertLineCell({ line, multiplier }: { line: TeacherLine; multiplier: number }) {
  const base = line.settings.baseSalary;
  if (line.alertLine == null || base == null) return DASH;
  return (
    <Tip
      tip={
        <>
          底薪 {money(base)} × {multiplier} = {money(base * multiplier)}
          <br />− 额外收入 {money(line.settings.extraIncome ?? 0)}
          <br />
          <b>= 预警线 {money(line.alertLine)}</b>
        </>
      }
    >
      {money(line.alertLine)}
    </Tip>
  );
}

/** 差额写成「超 / 差」，不用正负号；下面小字是预测薪资。 */
function MarginCell({ line, at }: { line: TeacherLine; at: Scenario | null }) {
  if (!at || at.predicted == null) return DASH;
  const formula = `课时费 ${money(line.lessonFee)} × ${at.rate} = 预测 ${money(at.predicted)}`;
  const predicted = <span className="text-muted-foreground block text-xs">预测 {money(at.predicted)}</span>;
  if (at.margin == null) {
    return (
      <Tip className="block" tip={<>{formula}<br />没填底薪，没有预警线可比</>}>
        {DASH}
        {predicted}
      </Tip>
    );
  }
  const over = at.margin >= 0;
  const text = `${over ? "超" : "差"} ${money(Math.abs(at.margin))}`;
  return (
    <Tip
      className="block"
      tip={
        <>
          {formula}
          <br />− 预警线 {money(line.alertLine)}
          <br />
          <b>= {text}</b>
        </>
      }
    >
      <span className={over ? "text-success" : "text-destructive"}>{text}</span>
      {predicted}
    </Tip>
  );
}

function HoursCell({ line, at }: { line: TeacherLine; at: Scenario | null }) {
  if (!at || at.margin == null) return DASH;
  if (at.margin >= 0) {
    return (
      <Tip tip={`预测 ${money(at.predicted)} 已超过预警线 ${money(line.alertLine)}，不用再加课`}>
        <span className="text-muted-foreground">已越过</span>
      </Tip>
    );
  }
  if (at.hours == null || !line.unitPrice) return DASH;
  return (
    <Tip
      tip={
        <>
          差 {money(-at.margin)} ÷ (单价 {money(line.unitPrice)} × {at.rate} = 每小时 {money(line.unitPrice * at.rate)})
          <br />
          <b>≈ {at.hours} 小时</b>（向上取到 0.1）
        </>
      }
    >
      {at.hours} h
    </Tip>
  );
}

/** 表头 + 悬停解释。解释里能算的就写公式，一行说完。 */
function Head({ children, tip, className, rowSpan }: { children: React.ReactNode; tip: React.ReactNode; className?: string; rowSpan?: number }) {
  return (
    <TableHead rowSpan={rowSpan} className={cn("bg-muted shadow-[inset_0_-1px_0_var(--border)]", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">{children}</span>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

/** 分组表头：写系数和越过它意味着什么，下层统一是「差额 / 还需」。 */
function GroupHead({ children, hint, colSpan, tone }: { children: React.ReactNode; hint?: string; colSpan: number; tone?: keyof typeof GROUP_TONE }) {
  return (
    <TableHead
      colSpan={colSpan}
      className={cn("h-auto border-l py-1.5 text-center leading-tight", tone ? GROUP_TONE[tone] : "bg-muted shadow-[inset_0_-1px_0_var(--border)]")}
    >
      {children}
      {hint ? <span className={cn("block text-[11px] font-normal", tone ? "opacity-80" : "text-muted-foreground")}>{hint}</span> : null}
    </TableHead>
  );
}

function timeLabel(iso: string | null): string {
  if (!iso) return "尚未同步";
  return `上次同步 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))}`;
}

function Stat({ label, value, hint, selected, onClick }: { label: string; value: number; hint?: string; selected: boolean; onClick: () => void }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onClick()}
      className={cn("cursor-pointer gap-1 py-4 transition-colors hover:bg-accent/40", selected && "border-foreground/40 bg-accent/60")}
    >
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardHeader>
    </Card>
  );
}

function RateInput({
  label,
  value,
  onCommit,
  min = 0.01,
  max = 0.99,
  step = 0.01,
  title,
}: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (Number.isFinite(next) && next >= min && next <= max && next !== value) onCommit(next);
    else setDraft(String(value));
  };
  return (
    <label className="text-muted-foreground flex items-center gap-1.5 text-sm" title={title}>
      {label}
      <Input
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        className="h-8 w-20 text-right tabular-nums"
      />
    </label>
  );
}

export function Workbench({ onSignOut }: { onSignOut: () => void | Promise<void> }) {
  const [month, setMonth] = useState(shanghaiMonth());
  const [statusFilter, setStatusFilter] = useState<AlertStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const { lines, rates, syncedAt, loading, syncing, error, sync, saveTeacher, saveRates } = useIncomeData(month);

  const monthOptions = useMemo(() => [1, 0, -1, -2, -3, -4, -5].map((offset) => shanghaiMonth(offset)), []);

  // 被排除的老师不进统计卡、不进导出；表格里默认不显示，点「已排除 N 位」才列在最后，可以恢复
  const active = useMemo(() => lines.filter((line) => !line.excluded), [lines]);
  const excludedLines = useMemo(() => lines.filter((line) => line.excluded), [lines]);

  const counts = useMemo(() => {
    const result: Record<AlertStatus, number> = { alert: 0, between: 0, reached: 0, "no-base": 0 };
    for (const line of active) result[line.status] += 1;
    return result;
  }, [active]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (line: TeacherLine) =>
      !needle || [line.teacher, ...line.students, line.settings.note].join(" ").toLocaleLowerCase().includes(needle);
    const shown = active.filter((line) => (statusFilter === "all" || line.status === statusFilter) && matches(line));
    // 展开已排除时放在最上面，一眼看到排除了谁
    return showExcluded ? [...excludedLines.filter(matches), ...shown] : shown;
  }, [active, excludedLines, statusFilter, query, showExcluded]);
  const exportable = visible.filter((line) => !line.excluded);

  const toggleFilter = (status: AlertStatus) => setStatusFilter((current) => (current === status ? "all" : status));
  const numberOrNull = (text: string) => (text === "" ? null : Number(text));

  return (
    <TooltipProvider>
    <div className="mx-auto max-w-[1840px] px-6 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">教师薪资预警</h1>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {monthOptions.map((option) => (
              <SelectItem key={option} value={option}>
                {monthLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <RateInput label="最低系数" value={rates.min} onCommit={(min) => saveRates({ ...rates, min })} />
          <RateInput label="最高系数" value={rates.max} onCommit={(max) => saveRates({ ...rates, max })} />
          <RateInput
            label="底薪倍数"
            value={rates.baseMultiplier}
            min={1}
            max={3}
            step={0.05}
            title="预警线 = 基础薪水 × 底薪倍数，和老师收入详情的底薪扣减系数一致"
            onCommit={(baseMultiplier) => saveRates({ ...rates, baseMultiplier })}
          />
          <Button onClick={sync} disabled={syncing} title="从飞书课表重新汇总这个月，约 10 秒">
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {syncing ? "同步中…" : "同步课表"}
          </Button>
          <Button variant="ghost" size="icon" onClick={onSignOut} title="退出登录">
            <LogOut />
          </Button>
        </div>
      </header>
      <p className="text-muted-foreground mt-1 text-xs">
        {timeLabel(syncedAt)}
      </p>

      {error ? (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="预警" value={counts.alert} hint="预测最高仍低于预警线" selected={statusFilter === "alert"} onClick={() => toggleFilter("alert")} />
        <Stat label="区间内" value={counts.between} hint="预警线落在预测最低与最高之间" selected={statusFilter === "between"} onClick={() => toggleFilter("between")} />
        <Stat label="已达标" value={counts.reached} hint="预测最低已超过预警线" selected={statusFilter === "reached"} onClick={() => toggleFilter("reached")} />
        <Stat label="无底薪" value={counts["no-base"]} hint="课表里有课但没填基础薪水" selected={statusFilter === "no-base"} onClick={() => toggleFilter("no-base")} />
      </section>

      <div className="mt-5 flex items-center gap-3">
        <div className="relative w-72">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜老师、学生、备注" className="pl-8" />
        </div>
        <span className="text-muted-foreground text-sm">
          {exportable.length} / {active.length} 位老师
        </span>
        {excludedLines.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn("text-muted-foreground", showExcluded && "bg-accent text-foreground")}
            onClick={() => setShowExcluded((value) => !value)}
            title="被排除的老师不参与统计和导出"
          >
            <EyeOff />
            {showExcluded ? `收起已排除的 ${excludedLines.length} 位` : `已排除 ${excludedLines.length} 位`}
          </Button>
        ) : null}
        <Button
          variant="outline"
          className="ml-auto"
          disabled={exportable.length === 0}
          onClick={() => void downloadExcel(exportable, rates, month)}
          title="导出当前筛选出的老师（不含已排除的），每个数单独一列，方便再算"
        >
          <Download />
          导出 Excel
        </Button>
      </div>

      <p className="text-muted-foreground mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="bg-muted rounded-md px-2 py-1">
          <b className="text-foreground font-medium">预警线</b> = 底薪 × {rates.baseMultiplier} − 额外收入
        </span>
        <span className="bg-muted rounded-md px-2 py-1">
          <b className="text-foreground font-medium">差额</b> = 课时费 × 系数 − 预警线
        </span>
        <span className="bg-muted rounded-md px-2 py-1">
          <b className="text-foreground font-medium">还需</b> = 差额 ÷ (单价 × 系数)
        </span>
        <span className="ml-1">悬停任意数字，看这一格的真实算式</span>
      </p>

      {/* 列宽写在 colgroup 上：table-fixed 按第一行定列宽，而第一行是合并的分组表头。学生列不定宽，拿 min-w 减去其余各列（约 1310px）剩下的部分；加列时 min-w 要跟着加，否则学生列被挤没、整行撑得几千像素高 */}
      {/* overflow-hidden 会把这个 div 变成滚动容器，thead 的 sticky 就只相对它生效而失效；overflow-clip 只裁圆角、不产生滚动容器 */}
      <div className="mt-2 min-w-[1380px] overflow-clip rounded-lg border">
        <Table className="table-fixed text-[13px] [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2" containerClassName="overflow-visible">
          <colgroup>
            {COLUMN_WIDTHS.map((width, index) => (
              <col key={index} className={width} />
            ))}
          </colgroup>
          <TableHeader className="sticky top-0 z-10 [&_tr]:border-0">
            <TableRow className="hover:bg-transparent">
              <Head rowSpan={2} tip="课表「老师」字段的写法。鼠标移上去可排除这位老师">老师</Head>
              <Head
                rowSpan={2}
                tip={<>预警：按 {rates.max} 算也没越过预警线<br />区间内：按 {rates.max} 越过、按 {rates.min} 还没越过<br />已达标：按 {rates.min} 也越过了</>}
              >
                状态
              </Head>
              <GroupHead colSpan={3} hint="课时收入要追上的数">目标线</GroupHead>
              <GroupHead colSpan={2}>本月课表</GroupHead>
              <GroupHead colSpan={2} tone="max" hint="越过这条 = 脱离预警">× {rates.max} 最高系数</GroupHead>
              <GroupHead colSpan={2} tone="min" hint="越过这条 = 达标">× {rates.min} 最低系数</GroupHead>
              <GroupHead colSpan={3} tone="custom" hint="每位老师单独填，试算用">× 自定义系数</GroupHead>
              <Head rowSpan={2} className="border-l" tip="自由填写，点击修改">备注<Pencil className={PEN} /></Head>
              <Head rowSpan={2} tip="当月课表里这位老师带过的学生，悬停人数看名单">学生</Head>
            </TableRow>
            <TableRow className="hover:bg-transparent">
              <Head className="border-l text-right" tip="每月固定薪水，点击修改；和老师收入详情的基础薪水表一致">底薪<Pencil className={PEN} /></Head>
              <Head className="text-right" tip="课时以外的固定收入（如管理费），点击修改。从预警线里扣掉，课时费要覆盖的就少这么多">额外收入<Pencil className={PEN} /></Head>
              <Head className="text-right" tip={`底薪 × ${rates.baseMultiplier} − 额外收入。所有差额都和它比`}>预警线</Head>
              <Head className="border-l text-right" tip="当月课表「课程总价格」合计，已含请假折扣；不含没有单价的日历占位（会议、自习）">课时费</Head>
              <Head className="text-right" tip="每小时课时费，点击修改。灰字是当月均价 = 课时费 ÷ 小时数，手填后覆盖">单价<Pencil className={PEN} /></Head>
              <Head className="border-l text-right" tip={`课时费 × ${rates.max} − 预警线；小字是预测薪资`}>差额</Head>
              <Head className="text-right" tip={`差额 ÷ (单价 × ${rates.max})，向上取 0.1 小时`}>还需</Head>
              <Head className="border-l text-right" tip={`课时费 × ${rates.min} − 预警线；小字是预测薪资`}>差额</Head>
              <Head className="text-right" tip={`差额 ÷ (单价 × ${rates.min})，向上取 0.1 小时`}>还需</Head>
              <Head className="border-l text-right" tip="想试算的其他系数（如 0.55），点击修改；不填则本组为空">系数<Pencil className={PEN} /></Head>
              <Head className="text-right" tip="课时费 × 自定义系数 − 预警线；小字是预测薪资">差额</Head>
              <Head className="text-right" tip="差额 ÷ (单价 × 自定义系数)，向上取 0.1 小时">还需</Head>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_WIDTHS.length} className="text-muted-foreground h-24 text-center">
                  加载中…
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_WIDTHS.length} className="text-muted-foreground h-24 text-center">
                  {lines.length === 0 ? "这个月还没同步过，点右上角「同步课表」" : "没有符合条件的老师"}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((line: TeacherLine) => {
                const [atMax, atMin, atCustom] = scenarios(line, rates);
                return (
                  <TableRow
                    key={line.teacher}
                    className={cn("group", line.excluded ? "bg-muted/40 text-muted-foreground" : line.status === "alert" && "bg-destructive/[0.04]")}
                  >
                    <TableCell className="relative font-medium">
                      {/* 按钮浮在名字右侧，不占列宽，名字不会被挤成「Jack …」 */}
                      <div className="flex items-center">
                        <span className="truncate" title={line.teacher}>
                          {line.teacher}
                        </span>
                        {line.excluded ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="bg-background text-foreground absolute top-1/2 right-1 size-6 -translate-y-1/2 shadow-sm"
                            onClick={() => void saveTeacher(line.teacher, { is_excluded: false })}
                            title="恢复：重新参与统计"
                            aria-label={`恢复 ${line.teacher}`}
                          >
                            <Undo2 className="size-3.5" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="bg-background text-muted-foreground absolute top-1/2 right-1 size-6 -translate-y-1/2 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => void saveTeacher(line.teacher, { is_excluded: true })}
                            title="排除这位老师：不参与统计和导出，可随时恢复"
                            aria-label={`排除 ${line.teacher}`}
                          >
                            <EyeOff className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {line.excluded ? <Badge variant="outline">已排除</Badge> : <Badge variant={STATUS_VARIANT[line.status]}>{STATUS_LABELS[line.status]}</Badge>}
                    </TableCell>
                    <TableCell className="border-l !px-1 !py-1">
                      <EditableCell type="number" value={line.settings.baseSalary} onSave={(text) => saveTeacher(line.teacher, { base_salary: numberOrNull(text) })} />
                    </TableCell>
                    <TableCell className="!px-1 !py-1">
                      <EditableCell type="number" value={line.settings.extraIncome} onSave={(text) => saveTeacher(line.teacher, { extra_income: numberOrNull(text) })} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <AlertLineCell line={line} multiplier={rates.baseMultiplier} />
                    </TableCell>
                    <TableCell className="border-l text-right tabular-nums">
                      {money(line.lessonFee)}
                      <span className="text-muted-foreground block text-xs">
                        {line.lessons} 节 · {line.hours} h
                      </span>
                    </TableCell>
                    <TableCell className="!px-1 !py-1">
                      <EditableCell
                        type="number"
                        value={line.settings.unitPrice}
                        placeholder={line.unitPriceAuto ? `${line.unitPriceAuto}` : "—"}
                        onSave={(text) => saveTeacher(line.teacher, { unit_price: numberOrNull(text) })}
                        className={cn(line.settings.unitPrice == null && "text-muted-foreground")}
                      />
                    </TableCell>
                    <TableCell className={cn("border-l text-right tabular-nums", BAND.max)}><MarginCell line={line} at={atMax} /></TableCell>
                    <TableCell className={cn("text-right tabular-nums", BAND.max)}><HoursCell line={line} at={atMax} /></TableCell>
                    <TableCell className={cn("border-l text-right tabular-nums", BAND.min)}><MarginCell line={line} at={atMin} /></TableCell>
                    <TableCell className={cn("text-right tabular-nums", BAND.min)}><HoursCell line={line} at={atMin} /></TableCell>
                    <TableCell className={cn("border-l !px-1 !py-1", BAND.custom)}>
                      <EditableCell type="number" value={line.settings.customRate} onSave={(text) => saveTeacher(line.teacher, { custom_rate: numberOrNull(text) })} />
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", BAND.custom)}><MarginCell line={line} at={atCustom} /></TableCell>
                    <TableCell className={cn("text-right tabular-nums", BAND.custom)}><HoursCell line={line} at={atCustom} /></TableCell>
                    <TableCell className="border-l !px-1 !py-1">
                      <EditableCell align="left" value={line.settings.note} placeholder="备注" onSave={(text) => saveTeacher(line.teacher, { note: text })} />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {line.students.length === 0 ? (
                        DASH
                      ) : (
                        <Tip tip={line.students.join("、")} className="underline decoration-dotted decoration-muted-foreground/50 underline-offset-4">
                          {line.students.length} 位
                        </Tip>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        带 <Pencil className="inline size-3" /> 的列点进去直接改，失焦即保存。悬停表头看口径，悬停数字看算式，悬停学生人数看名单。鼠标移到老师名字上点 <EyeOff className="inline size-3" /> 可排除这位老师。
      </p>
    </div>
    </TooltipProvider>
  );
}
