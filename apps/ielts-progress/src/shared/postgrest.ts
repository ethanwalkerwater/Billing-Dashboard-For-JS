/** 浏览器 js-sdk 的 rdb() 和云函数里手写的 PostgREST 客户端共用的最小接口。 */
export interface PostgrestResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}

export interface PostgrestFilter<T> extends PromiseLike<PostgrestResult<T>> {
  eq(column: string, value: unknown): PostgrestFilter<T>;
  in(column: string, values: readonly unknown[]): PostgrestFilter<T>;
  order(column: string, options?: { ascending?: boolean }): PostgrestFilter<T>;
}

export interface PostgrestLike {
  from(table: string): {
    select<T = Record<string, unknown>>(columns?: string): PostgrestFilter<T>;
    upsert(rows: Record<string, unknown>[], options?: { onConflict?: string }): PromiseLike<PostgrestResult<unknown>>;
    update(values: Record<string, unknown>): PostgrestFilter<unknown>;
    delete(): PostgrestFilter<unknown>;
  };
}

export const SNAPSHOTS_TABLE = "ielts_snapshots";

export interface SnapshotRow<T> {
  key: "feishu";
  data: T;
  updated_at: string;
}
