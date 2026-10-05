import { useCallback, useEffect, useRef, useState } from "react";

import { EXCLUDED_TEACHERS_TABLE, SCORE_RESULTS_TABLE } from "@/shared/rdb";
import { callFeedbackApi, db } from "./cloudbase";
import type { DetailRow, MonthReport } from "./report-types";

export function currentCollectionMonth(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

interface ResultRow {
  course_month: string;
  status: MonthReport["status"];
  source: MonthReport["source"];
  teachers: MonthReport["teachers"];
  stats: MonthReport["stats"];
  error: string | null;
  computed_at: string;
}

/**
 * 老师评分数据：直接读 feedback_score_results（每月算好存着），切月份、切标签、改累计范围都不调云函数。
 * 逐条明细（文字评价、老师抽屉要用，每月一两百 KB）按月份懒加载，读过就缓存。
 *
 * 打开页面时在后台刷新一次本月答卷：答卷有变化，云函数会重算本月并存库，刷新完再读一次表。
 * 答卷没变（最常见）就不会触发计算。
 */
export function useTeacherReport() {
  const [months, setMonths] = useState<MonthReport[] | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [details, setDetails] = useState<Record<string, DetailRow[]>>({});
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingDetail = useRef(new Set<string>());

  const load = useCallback(async () => {
    const [results, excludedRows] = await Promise.all([
      db
        .from(SCORE_RESULTS_TABLE)
        .select<ResultRow>("course_month,status,source,teachers,stats,error,computed_at")
        .order("course_month", { ascending: false }),
      db.from(EXCLUDED_TEACHERS_TABLE).select<{ teacher_name: string }>("teacher_name"),
    ]);
    if (results.error) throw new Error(results.error.message);
    setMonths(
      (results.data ?? []).map((row) => ({
        month: row.course_month,
        status: row.status,
        source: row.source,
        teachers: row.teachers,
        stats: row.stats,
        error: row.error ?? undefined,
        computedAt: row.computed_at,
      })),
    );
    setExcluded((excludedRows.data ?? []).map((row) => row.teacher_name));
  }, []);

  const loadDetail = useCallback(async (month: string, force = false) => {
    if (!force && loadingDetail.current.has(month)) return;
    loadingDetail.current.add(month);
    const result = await db.from(SCORE_RESULTS_TABLE).select<{ detail: DetailRow[] }>("detail").eq("course_month", month);
    if (!result.error) setDetails((current) => ({ ...current, [month]: result.data?.[0]?.detail ?? [] }));
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const collectionMonth = currentCollectionMonth();
      const result = await callFeedbackApi<{ scores?: Record<string, string> }>({ action: "sync-responses", collectionMonth });
      await load();
      // 重算过的月份，明细也换成新的
      for (const [month, outcome] of Object.entries(result.scores ?? {})) {
        if (outcome === "computed") await loadDetail(month, true);
      }
      setError(null);
    } catch (cause) {
      setError(`同步飞书答卷失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSyncing(false);
    }
  }, [load, loadDetail]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    void sync();
  }, [load, sync]);

  return { months, excluded, details, loadDetail, syncing, error, sync };
}
