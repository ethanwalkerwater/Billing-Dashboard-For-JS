import type { PostgrestLike, PostgrestResult } from "../../src/shared/rdb";

/**
 * 云函数里 `app.rdb()` 走的是 `getClientCredential()`，实测拿到的 PostgreSQL 角色是 `anon`
 * ——和没登录的浏览器一样，读写 feedback_* 会直接 permission denied。
 *
 * 所以服务端自己拼 PostgREST 请求，用环境 API Key 鉴权（JWT 里 role=service_role，可绕过 RLS）。
 * Key 只存在云函数环境变量里，不下发浏览器、不进 Git。
 * 浏览器那一侧继续走 js-sdk 的 rdb() + RLS 管理员白名单，两条路都不经过 anon。
 *
 * 这里不用 SDK 里的 PostgrestClient：那个包只发布了打包产物，没有可单独引入的子模块。
 * 本项目只用到 select/upsert/update 三种请求，直接拼 URL 比把整个 SDK 塞进来更省事。
 */
interface ServiceDbOptions {
  envId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

type Condition = string;

class Query implements PromiseLike<PostgrestResult<never>> {
  private readonly conditions: Condition[] = [];
  private readonly extras: string[] = [];

  constructor(
    private readonly run: (search: string) => Promise<PostgrestResult<never>>,
    initialSelect?: string,
  ) {
    if (initialSelect) this.extras.push(`select=${encodeURIComponent(initialSelect)}`);
  }

  eq(column: string, value: unknown): this {
    this.conditions.push(`${encodeURIComponent(column)}=eq.${encodeURIComponent(String(value))}`);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    // PostgREST 的 in 列表用括号包裹，值里的逗号和引号必须转义。
    const list = values.map((value) => `"${String(value).replace(/"/g, '\\"')}"`).join(",");
    this.conditions.push(`${encodeURIComponent(column)}=in.${encodeURIComponent(`(${list})`)}`);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.extras.push(`order=${encodeURIComponent(`${column}.${options?.ascending === false ? "desc" : "asc"}`)}`);
    return this;
  }

  limit(count: number): this {
    this.extras.push(`limit=${count}`);
    return this;
  }

  then<TResult1 = PostgrestResult<never>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResult<never>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run([...this.extras, ...this.conditions].join("&")).then(onfulfilled, onrejected);
  }
}

export function createServiceDb(options: ServiceDbOptions): PostgrestLike {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://${options.envId}.api.tcloudbasegateway.com/v1/rdb/rest`;
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
    // PostgREST 用 Accept-Profile / Content-Profile 选 schema，不传会拿环境 ID 当 schema。
    "accept-profile": "public",
    "content-profile": "public",
  };

  async function send(
    method: string,
    table: string,
    search: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<PostgrestResult<never>> {
    const response = await fetchImpl(`${base}/${table}${search ? `?${search}` : ""}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; hint?: string };
        message = parsed.message ?? text;
      } catch {
        // 保留原始文本
      }
      return { data: null, error: { message, code: String(response.status) } };
    }
    return { data: text ? (JSON.parse(text) as never[]) : [], error: null };
  }

  return {
    from(table: string) {
      const path = encodeURIComponent(table);
      return {
        select: (columns = "*") => new Query((search) => send("GET", path, search), columns) as never,
        insert: (rows) => send("POST", path, "", rows),
        upsert: (rows, upsertOptions) =>
          send("POST", path, upsertOptions?.onConflict ? `on_conflict=${encodeURIComponent(upsertOptions.onConflict)}` : "", rows, {
            prefer: "resolution=merge-duplicates,return=minimal",
          }),
        update: (values) => new Query((search) => send("PATCH", path, search, values)) as never,
      };
    },
  };
}
