import { useCallback, useEffect, useMemo, useState } from "react";

import { buildSamples } from "@/domain/progress";
import type { FeishuSnapshot } from "@/domain/progress";
import { SNAPSHOTS_TABLE } from "@/shared/postgrest";
import type { SnapshotRow } from "@/shared/postgrest";
import { callIelts, db } from "./cloudbase";

/** 一行快照一次读完；配对、归属、待处理全在浏览器里现算。 */
export function useProgressData() {
  const [snapshot, setSnapshot] = useState<FeishuSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await db.from(SNAPSHOTS_TABLE).select<SnapshotRow<FeishuSnapshot>>("*").eq("key", "feishu");
      if (result.error) throw new Error(result.error.message);
      setSnapshot(result.data?.[0]?.data ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
