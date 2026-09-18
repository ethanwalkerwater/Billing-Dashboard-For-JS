import type { PostgrestLike, PostgrestResult } from "../../src/shared/postgrest";

/**
 * 云函数里 `app.rdb()` 拿到的角色是 anon，写不了表；这里直接拼 PostgREST 请求，用环境 API Key（service_role）鉴权。
 * 和反馈追踪系统 feedback-api/service-db.ts 同一套，多了 delete。
 */
class Query implements PromiseLike<PostgrestResult<never>> {
  private readonly parts: string[] = [];
  constructor(private readonly run: (search: string) => Promise<PostgrestResult<never>>, select?: string) {
    if (select) this.parts.push(`select=${encodeURIComponent(select)}`);
  }
  eq(column: string, value: unknown): this {
    this.parts.push(`${encodeURIComponent(column)}=eq.${encodeURIComponent(String(value))}`);
    return this;
  }
  in(column: string, values: readonly unknown[]): this {
    const list = values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(",");
    this.parts.push(`${encodeURIComponent(column)}=in.${encodeURIComponent(`(${list})`)}`);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.parts.push(`order=${encodeURIComponent(`${column}.${options?.ascending === false ? "desc" : "asc"}`)}`);
    return this;
  }
  then<A = PostgrestResult<never>, B = never>(
    onfulfilled?: ((value: PostgrestResult<never>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run(this.parts.join("&")).then(onfulfilled, onrejected);
  }
}

export function createServiceDb(options: { envId: string; apiKey: string }): PostgrestLike {
  const base = `https://${options.envId}.api.tcloudbasegateway.com/v1/rdb/rest`;
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    "accept-profile": "public",
    "content-profile": "public",
  };

  async function send(method: string, table: string, search: string, body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(`${base}/${table}${search ? `?${search}` : ""}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* 保留原文 */
      }
      return { data: null, error: { message, code: String(response.status) } } as PostgrestResult<never>;
    }
    return { data: text ? (JSON.parse(text) as never[]) : [], error: null } as PostgrestResult<never>;
  }

  return {
    from(table) {
      const path = encodeURIComponent(table);
      return {
        select: (columns = "*") => new Query((search) => send("GET", path, search), columns) as never,
        upsert: (rows, upsertOptions) =>
          send("POST", path, upsertOptions?.onConflict ? `on_conflict=${encodeURIComponent(upsertOptions.onConflict)}` : "", rows, {
            prefer: "resolution=merge-duplicates,return=minimal",
          }),
        update: (values) => new Query((search) => send("PATCH", path, search, values)) as never,
        delete: () => new Query((search) => send("DELETE", path, search)) as never,
      };
    },
  };
}
