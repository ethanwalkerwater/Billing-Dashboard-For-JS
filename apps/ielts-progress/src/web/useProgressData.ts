import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildSamples } from "@/domain/progress";
import type { FeishuSnapshot } from "@/domain/progress";
import { SNAPSHOTS_TABLE } from "@/shared/postgrest";
import type { SnapshotRow } from "@/shared/postgrest";
import { callIelts, db } from "./cloudbase";

/** 快照 5 分钟内同步过就不再自动同步，免得来回刷新页面反复读飞书 */
const FRESH_MS = 5 * 60_000;

/**
 * 一行快照一次读完；配对、归属、待处理全在浏览器里现算。
 * 打开页面先显示上次的快照，同时在后台同步一次飞书，同步完自动刷新。
 */
export function useProgressData() {
  const [snapshot, setSnapshot] = useState<FeishuSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<FeishuSnapshot | null> => {
    try {
      const result = await db.from(SNAPSHOTS_TABLE).select<SnapshotRow<FeishuSnapshot>>("*").eq("key", "feishu");
      if (result.error) throw new Error(result.error.message);
      const next = result.data?.[0]?.data ?? null;
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      await callIelts({ action: "sync" });
      await reload();
    } catch (cause) {
      setError(`同步失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSyncing(false);
    }
  }, [reload]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode 下 effect 会跑两次，同步只发一次
    started.current = true;
    void reload().then((current) => {
      if (!current || Date.now() - new Date(current.syncedAt).getTime() > FRESH_MS) void sync();
    });
  }, [reload, sync]);

  const built = useMemo(() => buildSamples(snapshot?.scores ?? [], snapshot?.lessons ?? []), [snapshot]);

  return {
    ...built,
    unknownTypes: snapshot?.unknownTypes ?? {},
    syncedAt: snapshot?.syncedAt ?? null,
    loading,
    syncing,
    error,
    sync,
  };
}
