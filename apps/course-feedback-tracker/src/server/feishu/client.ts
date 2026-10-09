import { FeishuApiError } from "./errors";
import type { FeishuEnvelope, FeishuField, FeishuFieldOption, FeishuPage, FeishuRecord, SearchFilter } from "./types";

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

  /**
   * 「查询记录」接口（POST /records/search）：支持服务端按日期过滤、只取指定列。
   * 返回形状和 list 接口不同：关联字段只有 {link_record_ids}，没有显示文本。
   */
  async searchRecords(input: {
    appToken: string;
    tableId: string;
    fieldNames: string[];
    filter: SearchFilter;
  }): Promise<FeishuRecord[]> {
    const records: FeishuRecord[] = [];
    let pageToken: string | undefined;
    do {
      const search = new URLSearchParams({ page_size: "500" });
      if (pageToken) search.set("page_token", pageToken);
      const page = await this.request<FeishuPage<FeishuRecord>>(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/search?${search}`,
        { method: "POST", body: JSON.stringify({ field_names: input.fieldNames, filter: input.filter, automatic_fields: true }) },
      );
      records.push(...(page.items ?? []));
      pageToken = page.has_more ? page.page_token : undefined;
      if (page.has_more && !pageToken) throw new FeishuApiError("飞书分页响应声明还有数据，但没有返回下一页游标");
    } while (pageToken);
    return records;
  }

  /** 读单条记录；记录不存在时返回 null（飞书错误码 1254043 RecordIdNotFound）。 */
  async getRecord(input: { appToken: string; tableId: string; recordId: string }): Promise<FeishuRecord | null> {
    try {
      const data = await this.request<{ record: FeishuRecord }>(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}?automatic_fields=true`,
      );
      return data.record;
    } catch (error) {
      if (error instanceof FeishuApiError && error.code === 1254043) return null;
      throw error;
    }
  }

  async updateRecord(input: {
    appToken: string;
    tableId: string;
    recordId: string;
    fields: Record<string, unknown>;
  }): Promise<FeishuRecord> {
    const data = await this.request<{ record: FeishuRecord }>(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records/${encodeURIComponent(input.recordId)}`,
      { method: "PUT", body: JSON.stringify({ fields: input.fields }) },
    );
    return data.record;
  }

  /** 机器人发消息；receiveIdType 为 open_id（私聊）或 chat_id（群）。 */
  async sendMessage(input: {
    receiveIdType: "open_id" | "chat_id";
    receiveId: string;
    msgType: "text" | "interactive";
    content: Record<string, unknown>;
  }): Promise<void> {
    await this.request<unknown>(`/open-apis/im/v1/messages?receive_id_type=${input.receiveIdType}`, {
      method: "POST",
      body: JSON.stringify({ receive_id: input.receiveId, msg_type: input.msgType, content: JSON.stringify(input.content) }),
    });
  }

  /** 多维表格附件的临时下载链接（24 小时有效，无需鉴权即可访问），一次最多 5 个 token。 */
  async tmpDownloadUrls(fileTokens: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (let i = 0; i < fileTokens.length; i += 5) {
      const search = new URLSearchParams();
      for (const token of fileTokens.slice(i, i + 5)) search.append("file_tokens", token);
      const data = await this.request<{ tmp_download_urls?: Array<{ file_token: string; tmp_download_url: string }> }>(
        `/open-apis/drive/v1/medias/batch_get_tmp_download_url?${search}`,
      );
      for (const item of data.tmp_download_urls ?? []) urls.set(item.file_token, item.tmp_download_url);
    }
    return urls;
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
