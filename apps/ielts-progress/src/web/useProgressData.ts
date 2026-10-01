import { useCallback, useEffect, useMemo, useState } from "react";

import { buildSamples } from "@/domain/progress";
import type { FeishuSnapshot, Sample } from "@/domain/progress";
import { SNAPSHOTS_TABLE } from "@/shared/postgrest";
import type { SnapshotRow } from "@/shared/postgrest";
import { callIelts, db } from "./cloudbase";

interface LegacySnapshot {
  samples: Sample[];
  sourceFile: string;
  importedAt: string;
}

/** 两行快照一次读完；配对、归属、待处理全在浏览器里现算。 */
export function useProgressData() {
  const [feishu, setFeishu] = useState<FeishuSnapshot | null>(null);
  const [legacy, setLegacy] = useState<LegacySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await db.from(SNAPSHOTS_TABLE).select<SnapshotRow<unknown>>("*");
      if (result.error) throw new Error(result.error.message);
      const rows = result.data ?? [];
      setFeishu((rows.find((row) => row.key === "feishu")?.data as FeishuSnapshot | undefined) ?? null);
      setLegacy((rows.find((row) => row.key === "legacy")?.data as LegacySnapshot | undefined) ?? null);
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

  const built = useMemo(() => buildSamples(feishu?.scores ?? [], feishu?.lessons ?? []), [feishu]);
  const samples = useMemo(() => [...built.samples, ...(legacy?.samples ?? [])], [built, legacy]);

  return {
    samples,
    issues: built.issues,
    unknownTypes: feishu?.unknownTypes ?? {},
    syncedAt: feishu?.syncedAt ?? null,
    loading,
    syncing,
    error,
    sync,
  };
}
