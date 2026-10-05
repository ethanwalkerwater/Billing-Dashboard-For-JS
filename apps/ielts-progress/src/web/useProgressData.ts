import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildSamples } from "@/domain/progress";
import type { FeishuSnapshot } from "@/domain/progress";
import { SNAPSHOTS_TABLE } from "@/shared/postgrest";
import type { SnapshotRow } from "@/shared/postgrest";
import { callIelts, db } from "./cloudbase";

/** 一次同步的结果，页面用它告诉用户「刚刚更新了什么」。 */
export interface SyncResult {
  seconds: number;
  added: number;
  changed: number;
  removed: number;
}

/** 飞书成绩表前后两次的差异：按记录 ID 比，内容变了算修改 */
function diffScores(before: FeishuSnapshot | null, after: FeishuSnapshot | null): Omit<SyncResult, "seconds"> {
  const old = new Map((before?.scores ?? []).map((score) => [score.id, JSON.stringify(score)]));
  const next = after?.scores ?? [];
  const added = next.filter((score) => !old.has(score.id)).length;
  const changed = next.filter((score) => old.has(score.id) && old.get(score.id) !== JSON.stringify(score)).length;
  return { added, changed, removed: old.size - (next.length - added) };
}

/**
 * 一行快照一次读完；配对、归属、待处理全在浏览器里现算。
 * 打开页面先显示上次的快照，同时在后台同步一次飞书，同步完自动刷新。
 */
export function useProgressData() {
  const [snapshot, setSnapshot] = useState<FeishuSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncStartedAt, setSyncStartedAt] = useState<number | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const current = useRef<FeishuSnapshot | null>(null);
  current.current = snapshot;

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
    const startedAt = Date.now();
    const before = current.current;
    setSyncStartedAt(startedAt);
    setSyncError(null);
    setLastSync(null);
    try {
      await callIelts({ action: "sync" });
      const after = await reload();
      setLastSync({ seconds: Math.round((Date.now() - startedAt) / 1000), ...diffScores(before, after) });
    } catch (cause) {
      setSyncError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncStartedAt(null);
    }
  }, [reload]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode 下 effect 会跑两次，同步只发一次
    started.current = true;
    // 先显示上次的快照，再同步：老师刚提交的成绩，教务一打开就能看到
    void reload().then(() => sync());
  }, [reload, sync]);

  const built = useMemo(() => buildSamples(snapshot?.scores ?? [], snapshot?.lessons ?? []), [snapshot]);

  return {
    ...built,
    unknownTypes: snapshot?.unknownTypes ?? {},
    syncedAt: snapshot?.syncedAt ?? null,
    loading,
    syncing: syncStartedAt !== null,
    syncStartedAt,
    lastSync,
    syncError,
    error,
    sync,
  };
}
