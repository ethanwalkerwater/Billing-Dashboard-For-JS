import { Download, QrCode, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

/**
 * 批量操作栏。作用范围写清楚：教务最容易踩的坑是以为"标记已发"作用于全部，
 * 实际只作用于勾选的那几行。fixed 定位——sticky 会被当成父级 grid 的网格项塞进侧栏列。
 */
export function BulkBar({
  selectedCount,
  filteredCount,
  totalCount,
  busy,
  onSelectAllFiltered,
  onClear,
  onMarkSent,
  onMarkDeclined,
  onMarkUnsent,
  onDownloadZip,
  onExportCsv,
}: {
  selectedCount: number;
  filteredCount: number;
  totalCount: number;
  busy: boolean;
  onSelectAllFiltered: () => void;
  onClear: () => void;
  onMarkSent: () => void;
  onMarkDeclined: () => void;
  onMarkUnsent: () => void;
  onDownloadZip: () => void;
  onExportCsv: () => void;
}) {
  if (selectedCount === 0) return null;

  return (
    <div className="bg-background fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border p-1.5 whitespace-nowrap shadow-lg">
      <div className="px-2 text-sm">
        <span className="font-medium">已选 {selectedCount} 行</span>
        <span className="text-muted-foreground ml-2 text-xs">
          筛选 {filteredCount} / 共 {totalCount}
        </span>
        {selectedCount < filteredCount ? (
          <Button variant="link" size="sm" className="ml-1 h-auto p-0 text-xs" onClick={onSelectAllFiltered}>
            选中全部 {filteredCount} 行
          </Button>
        ) : null}
      </div>
      <Separator orientation="vertical" className="h-5" />
      <Button variant="ghost" size="sm" disabled={busy} onClick={onMarkSent}>
        标记已发
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onMarkDeclined}>
        标记拒绝
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onMarkUnsent}>
        退回未发
      </Button>
      <Separator orientation="vertical" className="h-5" />
      <Button variant="ghost" size="sm" disabled={busy} onClick={onDownloadZip}>
        <QrCode /> 二维码 ZIP
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onExportCsv}>
        <Download /> 导出 CSV
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="取消选择">
        <X />
      </Button>
    </div>
  );
}
