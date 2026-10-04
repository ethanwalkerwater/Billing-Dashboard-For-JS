import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** 月份区间，YYYY-MM，两端都含；null 表示不限。 */
export interface MonthRange {
  from: string | null;
  to: string | null;
}

export const ALL_TIME: MonthRange = { from: null, to: null };

export function shanghaiMonth(offset = 0): string {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15));
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(base).slice(0, 7);
}

export function inRange(month: string, range: MonthRange): boolean {
  return (!range.from || month >= range.from) && (!range.to || month <= range.to);
}

const monthText = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

function rangeLabel({ from, to }: MonthRange): string {
  if (!from && !to) return "全部时间";
  if (from && from === to) return monthText(from);
  if (from && to) return `${monthText(from)} – ${monthText(to)}`;
  return from ? `${monthText(from)} 起` : `至 ${monthText(to!)}`;
}

/**
 * 点选月份：点一个月 = 只看这个月；再点另一个月 = 两者之间的区间。
 * 有成绩的月份下面带一个点，免得点进没数据的月份。
 */
export function MonthRangePicker({ value, onChange, available }: { value: MonthRange; onChange: (next: MonthRange) => void; available: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [year, setYear] = useState(() => Number((value.to ?? value.from ?? shanghaiMonth()).slice(0, 4)));

  const presets: Array<[string, MonthRange]> = [
    ["全部时间", ALL_TIME],
    ["本月", { from: shanghaiMonth(), to: shanghaiMonth() }],
    ["近 3 个月", { from: shanghaiMonth(-2), to: null }],
    ["近 6 个月", { from: shanghaiMonth(-5), to: null }],
    ["今年", { from: `${shanghaiMonth().slice(0, 4)}-01`, to: null }],
  ];

  function pick(month: string) {
    if (!anchor) {
      setAnchor(month);
      onChange({ from: month, to: month });
      return;
    }
    const [from, to] = [anchor, month].sort();
    setAnchor(null);
    onChange({ from: from!, to: to! });
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setAnchor(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="font-normal">
          <CalendarRange className="opacity-60" />
          {rangeLabel(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <div className="flex flex-wrap gap-1">
          {presets.map(([label, range]) => (
            <Button
              key={label}
              variant={rangeLabel(range) === rangeLabel(value) ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                onChange(range);
                setOpen(false);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Button variant="ghost" size="icon-sm" onClick={() => setYear((y) => y - 1)} aria-label="上一年">
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium tabular-nums">{year} 年</span>
          <Button variant="ghost" size="icon-sm" onClick={() => setYear((y) => y + 1)} aria-label="下一年">
            <ChevronRight />
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1">
          {Array.from({ length: 12 }, (_, index) => {
            const month = `${year}-${String(index + 1).padStart(2, "0")}`;
            const edge = month === value.from || month === value.to;
            const inside = Boolean(value.from || value.to) && inRange(month, value);
            return (
              <button
                key={month}
                type="button"
                onClick={() => pick(month)}
                className={cn(
                  "relative flex h-9 flex-col items-center justify-center rounded-md text-sm tabular-nums transition-colors",
                  edge ? "bg-primary text-primary-foreground" : inside ? "bg-accent" : "hover:bg-accent",
                )}
              >
                {index + 1}月
                {available.has(month) ? <span className={cn("absolute bottom-1 size-1 rounded-full", edge ? "bg-primary-foreground" : "bg-viz-up")} /> : null}
              </button>
            );
          })}
        </div>
        <p className="text-muted-foreground mt-2 text-xs">{anchor ? `已选 ${monthText(anchor)}，再点一个月份选区间，或点空白处只看这个月` : "点一个月份只看这个月，再点另一个选区间；蓝点 = 有成绩"}</p>
      </PopoverContent>
    </Popover>
  );
}
