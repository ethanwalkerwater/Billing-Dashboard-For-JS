import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 表格里的可编辑单元格：看起来是普通文字，点进去才是输入框，失焦或回车保存，Esc 放弃。
 * 不做 Popover / Dialog——每月要改十几个数字，多一次点击就是十几次浪费。
 */
export function EditableCell({
  value,
  onSave,
  type = "text",
  placeholder = "—",
  className,
  align = "right",
}: {
  value: string | number | null;
  onSave: (next: string) => void | Promise<void>;
  type?: "text" | "number";
  placeholder?: string;
  className?: string;
  align?: "left" | "right";
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);

  const commit = () => {
    const original = value == null ? "" : String(value);
    if (draft.trim() !== original) void onSave(draft.trim());
  };

  return (
    <input
      type="text"
      inputMode={type === "number" ? "decimal" : undefined}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          setDraft(value == null ? "" : String(value));
          (event.target as HTMLInputElement).blur();
        }
      }}
      className={cn(
        "h-7 w-full rounded-md border border-border bg-background/60 px-1.5 text-[13px] tabular-nums outline-none transition-colors",
        "hover:border-input hover:bg-background focus:border-ring focus:bg-background focus:ring-ring/50 focus:ring-[3px]",
        "placeholder:text-muted-foreground/60",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    />
  );
}
