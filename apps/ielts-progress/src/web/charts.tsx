import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MIN_SAMPLES, averageDelta, positiveRate } from "@/domain/progress";
import type { Tally } from "@/domain/progress";
import { cn } from "@/lib/utils";

export function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

export function signed(value: number | null): string {
  if (value == null) return "—";
  const text = (Math.round(value * 100) / 100).toString();
  return value > 0 ? `+${text}` : text;
}

function TallyTip({ value }: { value: Tally }) {
  return (
    <span className="tabular-nums">
      提升 {value.up} · 持平 {value.flat} · 下降 {value.down} · 平均提分 {signed(averageDelta(value))}
    </span>
  );
}

export function OutcomeLegend() {
  return (
    <div className="text-muted-foreground flex items-center gap-4 text-xs">
      {(
        [
          ["bg-viz-up", "提升"],
          ["bg-viz-flat", "持平"],
          ["bg-viz-down", "下降"],
        ] as const
      ).map(([color, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-[3px]", color)} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** 一条 100% 堆叠条：提升 | 持平 | 下降，段间 2px 白缝，两端圆角。 */
function OutcomeBar({ value }: { value: Tally }) {
  const parts = [
    [value.up, "bg-viz-up"],
    [value.flat, "bg-viz-flat"],
    [value.down, "bg-viz-down"],
  ] as const;
  return (
    <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]">
      {parts.map(([count, color]) =>
        count > 0 ? <div key={color} className={cn("h-full", color)} style={{ flexGrow: count, flexBasis: 0 }} /> : null,
      )}
    </div>
  );
}

export interface TeacherRow {
  teacher: string;
  tally: Tally;
}

/** 老师对比：按正向率排序；样本不足的放最后灰显、不排名。 */
export function TeacherBars({ rows, focused, onPick }: { rows: TeacherRow[]; focused: string | null; onPick: (teacher: string) => void }) {
  return (
    <div className="grid gap-1">
      <div className="text-muted-foreground grid grid-cols-[7rem_1fr_3.5rem_3rem_4rem] items-center gap-3 px-2 text-xs">
        <span>老师</span>
        <OutcomeLegend />
        <span className="text-right">正向率</span>
        <span className="text-right">样本</span>
        <span className="text-right">平均提分</span>
      </div>
      {rows.map(({ teacher, tally }) => {
        const few = tally.n < MIN_SAMPLES;
        return (
          <Tooltip key={teacher}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onPick(teacher)}
                className={cn(
                  "grid grid-cols-[7rem_1fr_3.5rem_3rem_4rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  focused === teacher && "bg-accent ring-foreground/20 ring-1",
                  few && "opacity-50",
                )}
              >
                <span className="truncate font-medium">{teacher}</span>
                <OutcomeBar value={tally} />
                <span className="text-right font-medium tabular-nums">{few ? "样本少" : pct(positiveRate(tally))}</span>
                <span className="text-muted-foreground text-right tabular-nums">{tally.n}</span>
                <span className="text-muted-foreground text-right tabular-nums">{signed(averageDelta(tally))}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <TallyTip value={tally} />
              {few ? `（少于 ${MIN_SAMPLES} 条，不参与排名）` : null}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// 单色蓝阶（浅 → 深），正向率 0–100% 分十档
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab"];

function Cell({ value, active, onClick }: { value: Tally | undefined; active: boolean; onClick: () => void }) {
  if (!value || value.n === 0) return <td className="text-muted-foreground/50 p-0.5 text-center text-xs">·</td>;
  const rate = positiveRate(value)!;
  const few = value.n < MIN_SAMPLES;
  const step = Math.min(RAMP.length - 1, Math.floor(rate * RAMP.length));
  return (
    <td className="p-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "flex h-10 w-full min-w-16 flex-col items-center justify-center rounded-[4px] text-xs tabular-nums transition-shadow hover:ring-2 hover:ring-foreground/30",
              few && "border border-dashed bg-transparent text-muted-foreground",
              !few && step >= 6 && "text-white",
              active && "ring-2 ring-foreground",
            )}
            style={few ? undefined : { backgroundColor: RAMP[step] }}
          >
            <span className="font-medium">{pct(rate)}</span>
            <span className="opacity-75">n={value.n}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <TallyTip value={value} />
        </TooltipContent>
      </Tooltip>
    </td>
  );
}

/** 老师 × 列（科目或月份）。首行「整体」按样本去重。 */
export function Matrix({
  teachers,
  columns,
  cells,
  overall,
  active,
  onPick,
}: {
  teachers: string[];
  columns: string[];
  cells: Map<string, Tally>;
  overall: Map<string, Tally>;
  active: { teacher: string | null; column: string | null };
  onPick: (teacher: string | null, column: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs">
            <th className="w-28 px-2 py-1 text-left font-normal">老师</th>
            {columns.map((column) => (
              <th key={column} className="px-1 py-1 font-normal">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2 text-xs font-medium">整体</td>
            {columns.map((column) => (
              <Cell key={column} value={overall.get(column)} active={!active.teacher && active.column === column} onClick={() => onPick(null, column)} />
            ))}
          </tr>
          {teachers.map((teacher) => (
            <tr key={teacher}>
              <td className="truncate px-2 text-sm">{teacher}</td>
              {columns.map((column) => (
                <Cell
                  key={column}
                  value={cells.get(`${teacher}|${column}`)}
                  active={active.teacher === teacher && active.column === column}
                  onClick={() => onPick(teacher, column)}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
