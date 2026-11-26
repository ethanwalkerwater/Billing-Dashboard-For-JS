import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { shiftMonth } from "@/domain";
import { formatHours, formatPercent, monthName } from "./report-types";

type Phase = { kind: "confirm" } | { kind: "running" } | { kind: "done"; siteRefreshed: boolean | null } | { kind: "error"; message: string };

/** 课程月份 M 到期自动定稿的日子：M+2 月 1 日 */
export function autoFinalizeLabel(month: string): string {
  return `${Number(shiftMonth(month, 2).slice(5))} 月 1 日`;
}

/**
 * 提前发布定稿的确认弹窗。发布不能撤回，所以先把当前数字和后果摆出来；
 * 发布要重读课表和答卷（约 1 分钟），进行中不允许点遮罩或 Esc 关掉。
 */
export function PublishDialog({
  month,
  summary,
  onPublish,
  onClose,
}: {
  month: string;
  summary: { teachers: number; responses: number; coverage: number | null; hours: number };
  onPublish: () => Promise<boolean | null>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const running = phase.kind === "running";
  const label = `${monthName(month)}课程`;

  const publish = async () => {
    setPhase({ kind: "running" });
    try {
      setPhase({ kind: "done", siteRefreshed: await onPublish() });
    } catch (cause) {
      setPhase({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

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
            {phase.kind === "done" ? <CheckCircle2 className="text-success size-4" /> : null}
            {phase.kind === "done" ? `${label}评分已发布` : `发布${label}评分？`}
          </DialogTitle>
          <DialogDescription>
            {phase.kind === "confirm" || phase.kind === "error"
              ? `当前 ${summary.teachers} 位老师 · 有效反馈 ${summary.responses} 份 · 课时覆盖率 ${formatPercent(summary.coverage)} · ${formatHours(summary.hours)} 课时`
              : null}
            {running ? "正在按最新课表和答卷核对、重算并定稿，约 1 分钟，请不要关闭页面。" : null}
            {phase.kind === "done"
              ? phase.siteRefreshed === true
                ? "分数已定稿，官网老师页的评分和课堂体验已经更新。"
                : phase.siteRefreshed === false
                  ? "分数已定稿。官网这次没通知到，会在 24 小时内自动更新。"
                  : "分数已定稿，官网老师页会随之更新（最晚 24 小时内）。"
              : null}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "confirm" || phase.kind === "error" ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                <li>分数定稿，之后不再变化。之后才交的反馈不计入评分（问卷跟踪里照样能看到）。</li>
                <li>官网老师页的评分和课堂体验会马上跟着更新。</li>
                <li>发布后不能撤回。不发布的话，{autoFinalizeLabel(month)}会自动定稿。</li>
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {phase.kind === "error" ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{phase.message}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {phase.kind === "done" ? (
            <Button onClick={onClose}>知道了</Button>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={onClose}>
                取消
              </Button>
              <Button disabled={running} onClick={() => void publish()}>
                {running ? <Loader2 className="animate-spin" /> : null}
                {phase.kind === "error" ? "重试" : "确认发布"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
