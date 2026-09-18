import { FeishuApiError } from "./errors";
import type { FeishuEnvelope, FeishuField, FeishuFieldOption, FeishuPage, FeishuRecord } from "./types";

const FEISHU_API_ORIGIN = "https://open.feishu.cn";

interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

interface TenantToken {
  value: string;
  expiresAt: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export class FeishuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private token?: TenantToken;

  constructor(options: FeishuClientOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async getTenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.fetchImpl(`${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = (await response.json()) as {
      code: number;
      msg: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new FeishuApiError(`飞书鉴权失败：${body.msg || `HTTP ${response.status}`}`, { code: body.code });
    }
    this.token = {
      value: body.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, body.expire ?? 7200) * 1000,
    };
    return this.token.value;
  }

  private async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const token = await this.getTenantToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${FEISHU_API_ORIGIN}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
          ...init.headers,
        },
      });
    } catch (error) {
      if (attempt < this.maxRetries) {
        await delay(250 * 2 ** attempt);
        return this.request(path, init, attempt + 1);
      }
      throw new FeishuApiError("无法连接飞书开放平台，请检查网络后重试", { cause: error });
    }

    if (isRetryable(response.status) && attempt < this.maxRetries) {
      const retryAfterSeconds = Number(response.headers.get("retry-after") ?? 0);
      await delay(retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 250 * 2 ** attempt);
      return this.request(path, init, attempt + 1);
    }

    const requestId = response.headers.get("x-tt-logid") ?? undefined;
    const body = (await response.json()) as FeishuEnvelope<T>;
    if (!response.ok || body.code !== 0 || body.data === undefined) {
      throw new FeishuApiError(`飞书接口失败：${body.msg || `HTTP ${response.status}`}`, {
        code: body.code,
        requestId,
      });
    }
    return body.data;
  }

  async listAllRecords(input: {
    appToken: string;
    tableId: string;
    viewId?: string;
    filter?: string;
    fieldNames?: string[];
  }): Promise<FeishuRecord[]> {
    const records: FeishuRecord[] = [];
    let pageToken: string | undefined;
    do {
      const search = new URLSearchParams({ page_size: "500" });
      if (pageToken) search.set("page_token", pageToken);
      if (input.viewId) search.set("view_id", input.viewId);
      if (input.filter) search.set("filter", input.filter);
      for (const fieldName of input.fieldNames ?? []) search.append("field_names", fieldName);
      const page = await this.request<FeishuPage<FeishuRecord>>(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records?${search}`,
      );
      records.push(...(page.items ?? []));
      pageToken = page.has_more ? page.page_token : undefined;
      if (page.has_more && !pageToken) {
        throw new FeishuApiError("飞书分页响应声明还有数据，但没有返回下一页游标");
      }
    } while (pageToken);
    return records;
  }

  async listAllFields(input: { appToken: string; tableId: string }): Promise<FeishuField[]> {
    const fields: FeishuField[] = [];
    let pageToken: string | undefined;
    do {
      const search = new URLSearchParams({ page_size: "100" });
      if (pageToken) search.set("page_token", pageToken);
      const page = await this.request<FeishuPage<FeishuField>>(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/fields?${search}`,
      );
      fields.push(...(page.items ?? []));
      pageToken = page.has_more ? page.page_token : undefined;
      if (page.has_more && !pageToken) throw new FeishuApiError("飞书字段分页缺少下一页游标");
    } while (pageToken);
    return fields;
  }

  async updateFieldOptions(input: {
    appToken: string;
    tableId: string;
    field: FeishuField;
    options: FeishuFieldOption[];
  }): Promise<FeishuField> {
    return this.request<FeishuField>(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/fields/${encodeURIComponent(input.field.field_id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          field_name: input.field.field_name,
          type: input.field.type,
          property: { ...input.field.property, options: input.options },
        }),
      },
    );
  }
}
