import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TASK_STATUS_LABELS } from "@/domain";
import { cn } from "@/lib/utils";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { BRAND_LOGO_URL, FOOTER_LINE, cardFileName, downloadBlob, renderQrCard, taskFormUrl, taskQrDataUrl } from "./qr";
import { respondedBy } from "./useWorkbenchData";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function TaskSheet({ task, onClose }: { task: StoredFeedbackTask | null; onClose: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!task) return;
    let active = true;
    setQrDataUrl("");
    void taskQrDataUrl(task, 480).then((value) => {
      if (active) setQrDataUrl(value);
    });
    return () => {
      active = false;
    };
  }, [task]);

  if (!task) return null;
  const formUrl = taskFormUrl(task);
  const responded = respondedBy(task);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>
            {task.studentName} × {task.teacherCanonicalName}
          </SheetTitle>
          <SheetDescription>{task.courseNames.join("、")}</SheetDescription>
        </SheetHeader>

        <div className="px-4">
          {/* 与导出的 PNG 同一套设计：官网 logo、大标题「课程反馈」、罗列老师/学生、二维码、底部一句话 */}
          <div className="bg-muted/40 flex shrink-0 flex-col rounded-xl border p-5">
            <div className="mt-2 text-center">
              <div className="text-3xl font-bold tracking-tight">{task.teacherCanonicalName}老师</div>
              <div className="mt-2 text-base font-medium text-[#3f3f46]">{task.courseNames.join(" · ")}</div>
              <div className="text-muted-foreground mt-2 text-sm">学生：{task.studentName}</div>
            </div>
            <div className="mx-auto mt-5 size-48 shrink-0 overflow-hidden rounded-lg bg-white p-2 shadow-sm">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt={`${task.studentName} 评价 ${task.teacherCanonicalName} 老师的问卷二维码`} className="size-full" />
              ) : (
                <div className="bg-muted size-full animate-pulse rounded" />
              )}
            </div>
            <p className="text-muted-foreground mt-4 text-center text-[11px]">{FOOTER_LINE}</p>
            <div className="mt-3 flex items-center justify-center gap-1.5">
              <img src={BRAND_LOGO_URL} alt="" className="size-4" />
              <span className="text-xs font-semibold text-[#0E2848]">菁仕教育</span>
            </div>
          </div>

          <div className="mt-4 grid gap-2">
            <Button disabled={!qrDataUrl} onClick={() => void renderQrCard(task).then((blob) => downloadBlob(blob, cardFileName(task)))}>
              <Download /> 下载 PNG
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard.writeText(formUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "已复制" : "复制链接"}
              </Button>
              <Button variant="outline" asChild>
                <a href={formUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> 打开问卷
                </a>
              </Button>
            </div>
          </div>

          <Separator className="my-4" />

          <div className="divide-y">
            <Row label="状态">
              <Badge
                variant={
                  task.status === "completed" ? "success" : task.status === "declined" ? "destructive" : task.status === "sent" ? "secondary" : "outline"
                }
              >
                {TASK_STATUS_LABELS[task.status]}
              </Badge>
            </Row>
            <Row label="谁评了">
              <span className="inline-flex items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", responded.student ? "bg-success" : "bg-border")} />
                  学生{responded.student ? "已评" : "未评"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", responded.parent ? "bg-success" : "bg-border")} />
                  家长{responded.parent ? "已评" : "未评"}
                </span>
              </span>
            </Row>
            {task.boundBy ? <Row label="绑定方式">{task.boundBy === "manual" ? "教务手动绑定" : "按姓名自动匹配"}</Row> : null}
            <Row label="课程月份">
              <span className="font-mono text-xs">{task.courseMonth}</span>
            </Row>
            <Row label="任务 ID">
              <span className="font-mono text-xs">{task.taskId.slice(-12)}</span>
            </Row>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
