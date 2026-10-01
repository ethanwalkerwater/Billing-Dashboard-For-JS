export class FeishuConfigError extends Error {
  override name = "FeishuConfigError";
}

export class FeishuApiError extends Error {
  override name = "FeishuApiError";
  readonly code?: number;
  readonly requestId?: string;

  constructor(message: string, options: { code?: number; requestId?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

export class FeishuSchemaError extends Error {
  override name = "FeishuSchemaError";
  readonly recordId: string;
  readonly fieldName: string;

  constructor(input: { recordId: string; fieldName: string; message: string }) {
    super(`飞书记录 ${input.recordId} 的“${input.fieldName}”${input.message}`);
    this.recordId = input.recordId;
    this.fieldName = input.fieldName;
  }
}

