import { CircleCheck, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { SNAPSHOTS_TABLE } from "@/shared/rdb";
import { db } from "./cloudbase";
import { formatMoment } from "./report-types";
import type { SyncedAt } from "./report-types";

/** 答卷超过这么久没同步，打开页面时就去飞书拉一次；飞书事件推着的时候基本不会触发。 */
const STALE_MS = 10 * 60_000;

/** 这一轮的答卷是不是很久没同步了（从没同步过也算）。 */
export async function feedbackIsStale(collectionMonth: string): Promise<boolean> {
  const result = await db.from(SNAPSHOTS_TABLE).select<{ synced_at: string }>("synced_at").eq("kind", "feedback").eq("month", collectionMonth);
  const at = result.data?.[0]?.synced_at;
  return !at || Date.now() - Date.parse(at) > STALE_MS;
}

/** 读各月份最近一次同步时间（不带 CSV 正文）。 */
export function useSyncTimes() {
  const [times, setTimes] = useState<SyncedAt[]>([]);
  const reload = useCallback(async () => {
    const result = await db
      .from(SNAPSHOTS_TABLE)
      .select<{ kind: SyncedAt["kind"]; month: string; row_count: number; synced_at: string }>("kind,month,row_count,synced_at");
    if (!result.error) {
      setTimes((result.data ?? []).map((row) => ({ kind: row.kind, month: row.month, rowCount: row.row_count, syncedAt: row.synced_at })));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { times, reload };
}

/**
 * 顶部的同步时间：让老师一眼知道看到的数据新到什么时候。
 * 答卷 = 这一轮的飞书答卷（飞书事件、每日定时对账、「刷新反馈」时更新）；课表 = 课程月份的课表（点「生成名单」时更新）。
 */
export function SyncStatus({
  times,
  feedbackMonth,
  scheduleMonth,
  syncing,
  className,
}: {
  times: SyncedAt[];
  feedbackMonth: string;
  scheduleMonth: string;
  syncing?: boolean;
  className?: string;
}) {
  const feedback = times.find((row) => row.kind === "feedback" && row.month === feedbackMonth);
  const schedule = times.find((row) => row.kind === "schedule" && row.month === scheduleMonth);
  return (
    <div className={cn("text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}>
      <span className="inline-flex items-center gap-1.5">
        {syncing ? <RefreshCw className="size-3.5 animate-spin" /> : <CircleCheck className="text-success size-3.5" />}
        {syncing ? "正在从飞书同步最新答卷…" : feedback ? `答卷同步于 ${formatMoment(feedback.syncedAt)}（${feedback.rowCount} 份）` : "答卷尚未同步"}
      </span>
      <span aria-hidden>·</span>
      <span title="课表在「生成名单」时更新">
        {schedule ? `课表同步于 ${formatMoment(schedule.syncedAt)}（${schedule.rowCount} 节）` : "课表尚未同步，点「生成名单」"}
      </span>
    </div>
  );
}
