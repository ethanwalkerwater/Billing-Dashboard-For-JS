/**
 * 幂等配置飞书答卷表：tsx scripts/setup-feishu.ts（读 server.env）。已经配好的跳过，不删不改别的字段。
 *  1. 加文本字段「反馈课程月份」，放进问卷（排在老师姓名后面），二维码预填它，答卷靠它归到哪一轮；
 *  2. 订阅这个多维表格的记录变更事件，飞书才会往 /webhooks/feishu 推「答卷有变化」
 *     （开放平台后台还要配好请求地址和 drive.file.bitable_record_changed_v1 事件，见 README）。
 */
import { readFileSync } from "node:fs";

import { FEEDBACK_MONTH_FIELD } from "../src/domain/form-url";

const env = Object.fromEntries(
  readFileSync(new URL("../server.env", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const APP = env.FEISHU_FEEDBACK_APP_TOKEN;
const TABLE = env.FEISHU_RESPONSE_TABLE_ID;
const API = "https://open.feishu.cn/open-apis";
const tokenRes = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
});
const { tenant_access_token: token } = (await tokenRes.json()) as { tenant_access_token: string };

async function call<R = any>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { code: number; msg: string; data: R };
  if (json.code !== 0) throw new Error(`${method} ${path} → ${json.code} ${json.msg}`);
  return json.data;
}

const base = `/bitable/v1/apps/${APP}/tables/${TABLE}`;
const { items: fields } = await call<{ items: Array<{ field_id: string; field_name: string }> }>("GET", `${base}/fields?page_size=100`);
let monthField = fields.find((f) => f.field_name === FEEDBACK_MONTH_FIELD)?.field_id;
if (!monthField) {
  // 文本而不是单选：单选的预填值不在选项里会静默丢掉，每月还得加选项
  monthField = (await call<{ field: { field_id: string } }>("POST", `${base}/fields`, { field_name: FEEDBACK_MONTH_FIELD, type: 1 })).field.field_id;
  console.log(`+ 字段 ${FEEDBACK_MONTH_FIELD} ${monthField}`);
}
const teacherField = fields.find((f) => f.field_name === "老师姓名")?.field_id;

const { items: views } = await call<{ items: Array<{ view_id: string; view_type: string }> }>("GET", `${base}/views`);
for (const form of views.filter((v) => v.view_type === "form")) {
  // 问题标题就是字段名，FORM_PREFILL_KEYS.courseMonth 按它预填。必须设成显示，预填才生效；
  // 扫码链接带 hide_反馈课程月份=1 把它藏起来，只有直接打开表单的人看得到这段说明。
  await call("PATCH", `${base}/forms/${form.view_id}/fields/${monthField}`, {
    title: FEEDBACK_MONTH_FIELD,
    description: "扫码后自动填好，表示这份反馈评的是哪个月的课，请不要修改",
    required: false,
    visible: true,
    ...(teacherField ? { pre_field_id: teacherField } : {}),
  });
  console.log(`✓ 问卷 ${form.view_id} 已显示「${FEEDBACK_MONTH_FIELD}」`);
}

await call("POST", `/drive/v1/files/${APP}/subscribe?file_type=bitable`);
console.log("✓ 已订阅答卷多维表格的记录变更事件");
