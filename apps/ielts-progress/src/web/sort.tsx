import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";

import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Value = string | number | null | undefined;

export interface Sort {
  key: string;
  dir: "asc" | "desc";
  toggle: (key: string, first: "asc" | "desc") => void;
}

/** 表格排序：点表头切换升 / 降序；空值永远排最后。 */
export function useSort<T>(rows: T[], accessors: Record<string, (row: T) => Value>, initial: { key: string; dir: "asc" | "desc" }) {
  const [state, setState] = useState(initial);
  const sorted = useMemo(() => {
    const get = accessors[state.key];
    if (!get) return rows;
    const sign = state.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null || x === "") return y == null || y === "" ? 0 : 1;
      if (y == null || y === "") return -1;
      return sign * (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh-CN"));
    });
    // accessors 每次渲染都是新对象，按 key 取用，不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state]);
  const sort: Sort = {
    ...state,
    toggle: (key, first) => setState((current) => (current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: first })),
  };
  return { sorted, sort };
}

/** 数字列第一次点是降序（提分高的在前），文字列 text 为升序。 */
export function SortHead({ label, sortKey, sort, className, text = false }: { label: string; sortKey: string; sort: Sort; className?: string; text?: boolean }) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => sort.toggle(sortKey, text ? "asc" : "desc")}
        className={cn("-mx-1 inline-flex items-center gap-1 rounded px-1 hover:bg-accent", className?.includes("text-right") && "flex-row-reverse")}
      >
        {label}
        <Icon className={cn("size-3.5", active ? "text-foreground" : "text-muted-foreground/50")} />
      </button>
    </TableHead>
  );
}
