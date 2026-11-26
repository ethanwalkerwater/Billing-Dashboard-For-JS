import { Check, Copy, Download, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TASK_STATUS_LABELS } from "@/domain";
import { monthlyFeedbackTitle, monthlyTaskKey } from "@/domain/monthly-feedback";
import { cn } from "@/lib/utils";
import { isFrozen } from "@/server/tasks/reconcile";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { loadMonthlyLinks, monthlyUrl } from "./monthly-links";
import { BRAND_LOGO_URL, QR_DESCRIPTION, cardFileName, downloadBlob, renderQrCard, monthlyQrDataUrl } from "./qr";
import { formatMoment } from "./report-types";
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
  const [card, setCard] = useState<{ key: string; url: string; image: string }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!task) return;
    let active = true;
    setError("");
    setCopied(false);
    void loadMonthlyLinks([task]).then(async (links) => {
      const url = monthlyUrl(links, task);
      const image = await monthlyQrDataUrl(url, 480);
      if (active) setCard({ key: monthlyTaskKey(task), url, image });
    }).catch(() => {
      if (active) setError("暂时无法生成月度链接，请重试。");
    });
    return () => {
      active = false;
    };
  }, [task, attempt]);

  if (!task) return null;
  const ready = card?.key === monthlyTaskKey(task) ? card : undefined;
  const title = monthlyFeedbackTitle(task.courseMonth, task.studentName);
  const responded = respondedBy(task);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>同一个学生本月使用同一链接和二维码，名单同步后自动更新老师。</SheetDescription>
        </SheetHeader>

        <div className="px-4">
          <div className="bg-muted/40 flex shrink-0 flex-col rounded-xl border p-5">
            <div className="mt-2 text-center">
              <div className="text-xl font-bold tracking-tight">{title}</div>
              <p className="text-muted-foreground mt-2 text-sm">{QR_DESCRIPTION}</p>
            </div>
            <div className="mx-auto mt-5 size-48 shrink-0 overflow-hidden rounded-lg bg-white p-2 shadow-sm">
              {ready ? (
                <img src={ready.image} alt={`${title}二维码`} className="size-full" />
              ) : (
                <div className="bg-muted size-full rounded" />
              )}
            </div>
            <div className="mt-3 flex items-center justify-center gap-1.5">
              <img src={BRAND_LOGO_URL} alt="" className="size-4" />
              <span className="text-xs font-semibold text-[#0E2848]">菁仕教育</span>
            </div>
          </div>

          <div className="mt-4 grid gap-2">
            {error && <p role="alert" className="text-sm">{error} <button className="underline" onClick={() => setAttempt((count) => count + 1)}>重试</button></p>}
            <Button disabled={!ready} onClick={() => ready && void renderQrCard(task, ready.url).then((blob) => downloadBlob(blob, cardFileName(task))).catch(() => setError("下载失败，请重试。"))}>
              <Download /> 下载 PNG
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                disabled={!ready}
                onClick={() =>
                  ready && void navigator.clipboard.writeText(ready.url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }).catch(() => setError("无法复制，请打开月度反馈后复制地址。"))
                }
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "已复制" : "复制链接"}
              </Button>
              {ready ? <Button variant="outline" asChild>
                <a href={ready.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> 打开月度反馈
                </a>
              </Button> : <Button variant="outline" disabled>打开月度反馈</Button>}
            </div>
          </div>

          <Separator className="my-4" />

          <div className="divide-y">
            <Row label="当前任务">{task.teacherCanonicalName} · {task.courseNames.join("、")}</Row>
            <Row label="状态">
              <Badge
                variant={
                  task.status === "completed" ? "success" : task.status === "declined" ? "destructive" : task.status === "sent" ? "secondary" : "outline"
                }
              >
                {TASK_STATUS_LABELS[task.status]}
              </Badge>
            </Row>
            {task.sentAt && <Row label="发送时间">{formatMoment(task.sentAt)}</Row>}
            {task.submittedAt && <Row label="提交时间">{formatMoment(task.submittedAt)}</Row>}
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
            {task.lessons?.length ? (
              <Row label="课时">
                {task.lessons.length} 节 · {task.lessons.reduce((sum, lesson) => sum + (Number(lesson["课程时长"]) || 0), 0)} 小时
                <span className="text-muted-foreground ml-1.5 text-xs">{isFrozen(task) ? "已评价，课时定稿" : "按课表，生成名单时更新"}</span>
              </Row>
            ) : null}
            <Row label="任务 ID">
              <span className="font-mono text-xs">{task.taskId.slice(-12)}</span>
            </Row>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
