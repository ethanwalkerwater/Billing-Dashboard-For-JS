import { ChevronsUpDown, Search, UserMinus } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatHours } from "./report-types";

/**
 * 评分页的「排除老师」：和老看板一样勾选即排除，剩下的老师重新排名（分数不变）。
 * 只影响当前浏览，不改数据；长期不参与统计的老师在「问卷跟踪 → 不统计的老师」里设置，这里不再列出。
 */
export function TeacherFilter({
  teachers,
  excluded,
  onChange,
  permanentCount,
}: {
  /** 当前视图里的老师和课时（月度 = 当月课时，累计 = 累计课时） */
  teachers: Array<{ teacher: string; hours: number }>;
  excluded: string[];
  onChange: (next: string[]) => void;
  permanentCount: number;
}) {
  const [query, setQuery] = useState("");
  const selected = new Set(excluded);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...teachers]
      .sort((a, b) => a.teacher.localeCompare(b.teacher, "zh-CN"))
      .filter((row) => !needle || row.teacher.toLowerCase().includes(needle));
  }, [teachers, query]);
  const activeCount = teachers.filter((row) => selected.has(row.teacher)).length;

  function toggle(teacher: string) {
    onChange(selected.has(teacher) ? excluded.filter((name) => name !== teacher) : [...excluded, teacher]);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("font-normal", activeCount > 0 && "border-primary/40")}>
          <UserMinus /> 排除老师
          {activeCount > 0 ? <Badge className="ml-0.5 h-5 min-w-5 px-1.5">{activeCount}</Badge> : null}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[30rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h4 className="font-semibold">排除老师</h4>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7" disabled={excluded.length === 0} onClick={() => onChange([])}>
            清空
          </Button>
        </div>
        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索老师姓名"
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent pr-3 pl-8 text-sm outline-none focus-visible:ring-[3px]"
            />
          </div>
        </div>
        <div className="grid max-h-80 grid-cols-2 gap-x-2 overflow-y-auto px-2 pb-2">
          {visible.length === 0 ? (
            <p className="text-muted-foreground col-span-2 py-6 text-center text-sm">没有匹配的老师</p>
          ) : (
            visible.map((row) => (
              <label key={row.teacher} className="hover:bg-accent flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm">
                <Checkbox checked={selected.has(row.teacher)} onCheckedChange={() => toggle(row.teacher)} />
                <span className="flex-1 truncate">{row.teacher}</span>
                <span className="text-muted-foreground font-mono text-xs tabular-nums">{formatHours(row.hours)}h</span>
              </label>
            ))
          )}
        </div>
        <Separator />
        <div className="text-muted-foreground flex items-center justify-between px-4 py-2.5 text-xs">
          <span>
            已排除 {activeCount} 位 · 展示 {teachers.length - activeCount} 位
          </span>
          <span>勾选即排除，剩下的老师重新排名</span>
        </div>
        {permanentCount > 0 ? (
          <p className="text-muted-foreground bg-muted/40 rounded-b-md px-4 py-2 text-xs">
            另有 {permanentCount} 位老师在「问卷跟踪 → 不统计的老师」里长期排除，这里不显示。
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
