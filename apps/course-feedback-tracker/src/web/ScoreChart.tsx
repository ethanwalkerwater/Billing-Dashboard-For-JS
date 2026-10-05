import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatScore } from "./report-types";
import { downloadBlob } from "./qr";

export interface ChartRow {
  teacher: string;
  value: number | null;
  /** 右侧小字，如「12 份 · 覆盖 80%」 */
  hint?: string;
}

/**
 * 分数几乎都挤在 4.5–5.0 之间，从 0 画起所有条一样长，看不出差别。
 * 坐标轴从「最低分往下取整到 0.1」开始，并在图上写明起点，避免误读成差距很大。
 */
export function chartAxis(rows: ChartRow[], scaleMax = 5): { min: number; max: number } {
  const values = rows.map((row) => row.value).filter((value): value is number => value != null);
  if (values.length === 0) return { min: 0, max: scaleMax };
  const min = Math.max(0, Math.floor((Math.min(...values) - 0.05) * 10) / 10);
  return { min: Math.min(min, scaleMax - 0.1), max: scaleMax };
}

function sortRows(rows: ChartRow[]): ChartRow[] {
  return [...rows].sort((a, b) => {
    if (a.value == null || b.value == null) return a.value == null ? (b.value == null ? 0 : 1) : -1;
    return b.value - a.value || a.teacher.localeCompare(b.teacher, "zh-CN");
  });
}

export function ScoreChart({
  rows,
  title,
  fileName,
  onSelect,
}: {
  rows: ChartRow[];
  title: string;
  fileName: string;
  onSelect?: (teacher: string) => void;
}) {
  // 无评分的老师（多是课时很少、已离职或没收到反馈）不画条，只在底部说一句有几位，免得把图拉得很长。
  const sorted = sortRows(rows).filter((row) => row.value != null);
  const unscored = rows.length - sorted.length;
  const axis = chartAxis(sorted);
  const scored = sorted;
  const average = scored.length ? scored.reduce((sum, row) => sum + row.value!, 0) / scored.length : null;
  const position = (value: number) => ((value - axis.min) / (axis.max - axis.min)) * 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground text-xs">
          坐标从 {axis.min.toFixed(1)} 起 · 虚线为平均 {average == null ? "—" : average.toFixed(3)} · 点击老师看明细
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadChartPng(sorted, title, axis, fileName)} disabled={sorted.length === 0}>
          <Download /> 下载完整图表 PNG
        </Button>
      </div>
      <div className="flex flex-col">
        {sorted.map((row, index) => (
          <button
            key={row.teacher}
            type="button"
            onClick={() => onSelect?.(row.teacher)}
            className="hover:bg-muted/60 grid grid-cols-[2rem_7.5rem_1fr_4rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm sm:grid-cols-[2rem_9rem_1fr_4.5rem_9rem]"
          >
            <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">{row.value == null ? "—" : index + 1}</span>
            <span className="truncate font-medium" title={row.teacher}>
              {row.teacher}
            </span>
            <span className="bg-muted relative h-5 overflow-hidden rounded-sm">
              {row.value != null ? (
                <span
                  className={cn("absolute inset-y-0 left-0 rounded-sm", index < 3 ? "bg-primary" : "bg-primary/70")}
                  style={{ width: `${Math.max(1.5, position(row.value))}%` }}
                />
              ) : null}
              {average != null ? (
                <span className="border-foreground/40 absolute inset-y-0 border-l border-dashed" style={{ left: `${position(average)}%` }} />
              ) : null}
            </span>
            <span className={cn("text-right font-mono tabular-nums", row.value == null && "text-muted-foreground text-xs")}>
              {formatScore(row.value)}
            </span>
            <span className="text-muted-foreground hidden truncate text-xs sm:block">{row.hint}</span>
          </button>
        ))}
        {unscored > 0 ? <p className="text-muted-foreground px-2 pt-2 text-xs">另有 {unscored} 位老师本期无评分，见下方明细表。</p> : null}
      </div>
    </div>
  );
}

/** 画一张包含全部老师的长图（不受页面滚动、宽度限制），直接用 canvas 画，不依赖截图库。 */
function downloadChartPng(rows: ChartRow[], title: string, axis: { min: number; max: number }, fileName: string) {
  const scale = 2;
  const width = 1200;
  const rowHeight = 36;
  const top = 96;
  const height = top + rows.length * rowHeight + 48;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d")!;
  context.scale(scale, scale);
  const font = (size: number, weight = 400) =>
    `${weight} ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#18181b";
  context.font = font(26, 600);
  context.fillText(title, 40, 52);
  context.fillStyle = "#71717a";
  context.font = font(14);
  context.fillText(`坐标从 ${axis.min.toFixed(1)} 起，满分 ${axis.max}`, 40, 78);

  const barLeft = 260;
  const barWidth = width - barLeft - 140;
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    context.fillStyle = "#71717a";
    context.font = font(14);
    context.textAlign = "right";
    context.fillText(row.value == null ? "—" : String(index + 1), 64, y + 22);
    context.textAlign = "left";
    context.fillStyle = "#18181b";
    context.font = font(16, 500);
    context.fillText(row.teacher, 80, y + 23);
    context.fillStyle = "#f4f4f5";
    context.fillRect(barLeft, y + 8, barWidth, 20);
    if (row.value != null) {
      context.fillStyle = index < 3 ? "#18181b" : "#52525b";
      const ratio = Math.max(0.015, (row.value - axis.min) / (axis.max - axis.min));
      context.fillRect(barLeft, y + 8, barWidth * ratio, 20);
    }
    context.fillStyle = row.value == null ? "#a1a1aa" : "#18181b";
    context.font = row.value == null ? font(14) : font(16, 600);
    context.fillText(formatScore(row.value), barLeft + barWidth + 16, y + 23);
  });

  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, fileName);
  }, "image/png");
}
