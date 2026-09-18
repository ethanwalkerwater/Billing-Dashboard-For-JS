import { FeishuConfigError } from "./errors";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  scheduleAppToken: string;
  scheduleTableId: string;
  studentTableId: string;
  feedbackAppToken: string;
  responseTableId: string;
  formUrl: string;
}

const ENV_KEYS = {
  appId: "FEISHU_APP_ID",
  appSecret: "FEISHU_APP_SECRET",
  scheduleAppToken: "FEISHU_SCHEDULE_APP_TOKEN",
  scheduleTableId: "FEISHU_SCHEDULE_TABLE_ID",
  studentTableId: "FEISHU_STUDENT_TABLE_ID",
  feedbackAppToken: "FEISHU_FEEDBACK_APP_TOKEN",
  responseTableId: "FEISHU_RESPONSE_TABLE_ID",
  formUrl: "FEISHU_FORM_URL",
} as const;

export function loadFeishuConfig(environment: NodeJS.ProcessEnv = process.env): FeishuConfig {
  const missing: string[] = [];
  const values = Object.fromEntries(
    Object.entries(ENV_KEYS).map(([property, key]) => {
      const value = environment[key]?.trim();
      if (!value) missing.push(key);
      return [property, value ?? ""];
    }),
  ) as unknown as FeishuConfig;

  if (missing.length > 0) {
    throw new FeishuConfigError(`缺少飞书服务端配置：${missing.join("、")}`);
  }
  return values;
}

