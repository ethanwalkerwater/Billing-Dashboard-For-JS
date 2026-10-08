export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
  created_time?: number | string;
  last_modified_time?: number | string;
}

export interface FeishuFieldOption {
  id?: string;
  name: string;
  color?: number;
}

export interface FeishuField {
  field_id: string;
  field_name: string;
  type: number;
  property?: {
    options?: FeishuFieldOption[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface FeishuPage<T> {
  items: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

export interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}


/** POST /records/search 的过滤条件 */
export interface SearchFilter {
  conjunction: "and" | "or";
  conditions: Array<{ field_name: string; operator: string; value: string[] }>;
}
