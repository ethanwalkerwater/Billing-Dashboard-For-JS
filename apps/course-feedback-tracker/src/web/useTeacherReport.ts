import { useCallback, useEffect, useRef, useState } from "react";

import { callFeedbackApi } from "./cloudbase";
import type { TeacherReport } from "./report-types";

export function currentCollectionMonth(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

/**
 * 老师评分数据。打开页面时：先用库里的快照算一次（1–2 秒出结果），
 * 同时从飞书刷新本月答卷（8–10 秒），刷新完再算一次替换——老师不用干等，看到的也一定是最新的。
 * 计算本身只要零点几秒，所以没有缓存、没有「重新计算」按钮。
 */
export function useTeacherReport(courseMonth: string, range: { from: string; to: string }) {
  const [report, setReport] = useState<TeacherReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const result = await callFeedbackApi<TeacherReport>({
        action: "teacher-report",
        courseMonth,
        cumulativeFrom: range.from || undefined,
        cumulativeTo: range.to || undefined,
      });
      // 只认最后一次请求的结果，快速切换月份时旧结果不会覆盖新结果。
      if (request === latest.current) {
        setReport(result);
        setError(null);
      }
    } catch (cause) {
      if (request === latest.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [courseMonth, range.from, range.to]);
  // 同步要 8–10 秒，期间老师可能切了月份：同步完用最新的 load，而不是发起同步时的那个。
  const loadRef = useRef(load);
  loadRef.current = load;

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      await callFeedbackApi({ action: "sync-responses", collectionMonth: currentCollectionMonth() });
      await loadRef.current();
    } catch (cause) {
      setError(`同步飞书答卷失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 只在打开页面时同步一次；切月份、改范围只重算。
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    void sync();
  }, [sync]);

  return { report, loading, syncing, error, sync };
}
