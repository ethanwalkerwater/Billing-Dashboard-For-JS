import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { BatchProgress } from "./qr";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * 二维码批量生成的进度弹窗：进度、可中途取消、完成后明确告诉教务下载好了。
 * 生成中不允许点遮罩或 Esc 关掉——那会让人以为取消了，其实循环还在跑。
 */
export function QrBatchDialog({
  progress,
  onCancel,
  onClose,
}: {
  progress: BatchProgress | null;
  onCancel: () => void;
  onClose: () => void;
}) {
  if (!progress) return null;
  const { phase, done, total, zipPercent, failed } = progress;
  const running = phase === "rendering" || phase === "zipping";
  const percent = phase === "rendering" ? (total === 0 ? 0 : (done / total) * 100) : zipPercent;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!running}
        onPointerDownOutside={(event) => running && event.preventDefault()}
        onEscapeKeyDown={(event) => running && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {running ? <Loader2 className="size-4 animate-spin" /> : null}
            {phase === "done" ? <CheckCircle2 className="text-success size-4" /> : null}
            {phase === "cancelled" ? <XCircle className="text-muted-foreground size-4" /> : null}
            {phase === "rendering" ? "正在生成二维码" : null}
            {phase === "zipping" ? "正在打包" : null}
            {phase === "done" ? "下载完成" : null}
            {phase === "cancelled" ? "已取消" : null}
          </DialogTitle>
          <DialogDescription>
            {phase === "rendering" ? `${done} / ${total} 张，按学生分文件夹` : null}
            {phase === "zipping" ? `${total} 张已生成，正在打成 ZIP` : null}
            {phase === "done"
              ? `${progress.fileName}${progress.sizeBytes ? `（${formatSize(progress.sizeBytes)}）` : ""}已保存到下载目录`
              : null}
            {phase === "cancelled" ? `已停在第 ${done} 张，没有下载任何文件` : null}
          </DialogDescription>
        </DialogHeader>

        {running ? <Progress value={percent} /> : null}

        {failed.length > 0 ? (
          <div className="border-warning/50 bg-warning/10 rounded-md border p-3">
            <p className="text-sm font-medium">{failed.length} 张生成失败</p>
            <ul className="text-muted-foreground mt-1 max-h-24 space-y-0.5 overflow-y-auto text-xs">
              {failed.slice(0, 20).map((item) => (
                <li key={item.taskId}>
                  {item.label} · {item.reason}
                </li>
              ))}
            </ul>
            {phase === "done" ? <p className="text-muted-foreground mt-1 text-xs">完整清单在 ZIP 里的「生成失败清单.csv」</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={onCancel}>
              取消
            </Button>
          ) : (
            <Button onClick={onClose}>知道了</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
