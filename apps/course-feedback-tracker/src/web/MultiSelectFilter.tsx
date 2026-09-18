import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * 多选筛选（老师 / 学生）。
 * 用 Popover 而不是 DropdownMenu：DropdownMenu 的 typeahead 会抢走输入框的按键，
 * 89 个学生不带搜索没法用。
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  className,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.toLocaleLowerCase().includes(needle));
  }, [options, query]);

  const selectedSet = new Set(selected);
  const allVisibleSelected = visible.length > 0 && visible.every((option) => selectedSet.has(option));

  function toggle(option: string) {
    onChange(selectedSet.has(option) ? selected.filter((value) => value !== option) : [...selected, option]);
  }

  /** 全选只作用于搜索后可见的那些，和表格里「全选当前筛选结果」同一套语义。 */
  function toggleAllVisible() {
    if (allVisibleSelected) {
      const drop = new Set(visible);
      onChange(selected.filter((value) => !drop.has(value)));
    } else {
      onChange([...new Set([...selected, ...visible])]);
    }
  }

  const summary =
    selected.length === 0
      ? `全部${label}`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} 位${label}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("justify-between font-normal", selected.length > 0 && "border-primary/40", className)}
        >
          <span className="truncate">{summary}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="relative border-b">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${label}`}
            className="placeholder:text-muted-foreground h-9 w-full bg-transparent pl-9 pr-3 text-sm outline-none"
          />
        </div>

        <div className="flex items-center justify-between px-2 py-1.5">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={toggleAllVisible} disabled={visible.length === 0}>
            {allVisibleSelected ? "取消全选" : `全选${query ? `（${visible.length}）` : ""}`}
          </Button>
          {selected.length > 0 ? (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange([])}>
              <X /> 清空
            </Button>
          ) : null}
        </div>
        <Separator />

        <div className="max-h-64 overflow-y-auto p-1">
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-sm">没有匹配的{label}</p>
          ) : (
            visible.map((option) => {
              const active = selectedSet.has(option);
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => toggle(option)}
                  className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                      active ? "bg-primary border-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {active ? <Check className="size-3" /> : null}
                  </span>
                  <span className="truncate">{option}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
