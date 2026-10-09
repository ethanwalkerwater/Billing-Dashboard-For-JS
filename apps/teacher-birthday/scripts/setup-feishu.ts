/**
 * 幂等建表：tsx scripts/setup-feishu.ts（读 server.env）。已存在的字段/表跳过，不删不改。
 * 字段类型：1 文本 2 数字 3 单选 4 多选 5 日期 7 复选框 11 人员 13 电话 17 附件
 */
import { readFileSync } from "node:fs";

import { TEACHER_FIELDS as T, WISH_FIELDS as W } from "../src/domain/records";

const env = Object.fromEntries(
  readFileSync(new URL("../server.env", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const APP = env.TEACHER_APP_TOKEN;
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

const date = { date_formatter: "yyyy/MM/dd", auto_fill: false };
const select = (...names: string[]) => ({ options: names.map((name) => ({ name })) });
type Spec = [string, number, Record<string, unknown>?];

const teacherSpecs: Spec[] = [
  [T.scheduleName, 1], [T.gender, 3, select("男", "女")], [T.birth, 5, date], [T.join, 5, date],
  [T.phone, 13], [T.wechat, 1], [T.feishu, 11, { multiple: false }],
  [T.subject, 3, select("数学", "物理", "化学", "经济", "英语")],
  [T.education, 1], [T.intro, 1], [T.teaching, 1], [T.courses, 4, select()], [T.photo, 17],
  [T.active, 7], [T.handwritten, 1], [T.ai, 1],
  [T.lessons, 2, { formatter: "0" }], [T.students, 2, { formatter: "0" }], [T.hours, 2, { formatter: "0.0" }],
  [T.asked, 2, { formatter: "0" }], [T.celebrated, 2, { formatter: "0" }],
];
const wishSpecs: Spec[] = [
  [W.year, 2, { formatter: "0" }], [W.name, 1], [W.role, 3, select("学生", "家长", "同事")],
  [W.text, 1], [W.files, 17], [W.hidden, 7],
];

async function ensureFields(tableId: string, specs: Spec[], primaryName: string) {
  const { items } = await call<{ items: Array<{ field_id: string; field_name: string; is_primary?: boolean; type: number }> }>(
    "GET", `/bitable/v1/apps/${APP}/tables/${tableId}/fields?page_size=100`);
  const primary = items.find((f) => f.is_primary)!;
  if (primary.field_name !== primaryName) {
    await call("PUT", `/bitable/v1/apps/${APP}/tables/${tableId}/fields/${primary.field_id}`, { field_name: primaryName, type: 1 });
    console.log(`主字段 ${primary.field_name} → ${primaryName}`);
  }
  const existing = new Set(items.map((f) => f.field_name));
  for (const [field_name, type, property] of specs) {
    if (existing.has(field_name)) continue;
    await call("POST", `/bitable/v1/apps/${APP}/tables/${tableId}/fields`, { field_name, type, ...(property ? { property } : {}) });
    console.log(`+ ${field_name}`);
  }
}

await ensureFields(env.TEACHER_TABLE_ID, teacherSpecs, T.name);

const { items: tables } = await call<{ items: Array<{ table_id: string; name: string }> }>("GET", `/bitable/v1/apps/${APP}/tables`);
let wishTable = tables.find((t) => t.name === "生日祝福")?.table_id;
if (!wishTable) {
  wishTable = (await call<{ table_id: string }>("POST", `/bitable/v1/apps/${APP}/tables`, { table: { name: "生日祝福" } })).table_id;
  console.log(`+ 表 生日祝福 ${wishTable}`);
}
await ensureFields(wishTable, wishSpecs, W.teacher);

const { items: views } = await call<{ items: Array<{ view_id: string; view_name: string; view_type: string }> }>(
  "GET", `/bitable/v1/apps/${APP}/tables/${wishTable}/views`);
let formId = views.find((v) => v.view_type === "form")?.view_id;
if (!formId) {
  formId = (await call<{ view: { view_id: string } }>("POST", `/bitable/v1/apps/${APP}/tables/${wishTable}/views`, { view_name: "祝福问卷", view_type: "form" })).view.view_id;
}
const form = await call<{ form: { shared_url?: string } }>("PATCH", `/bitable/v1/apps/${APP}/tables/${wishTable}/forms/${formId}`, {
  name: "给老师的生日祝福",
  description: "写下你最想对 ta 说的话，也可以上传照片、表情包或小视频。生日当天，这些祝福会变成一份专属礼物送给老师。",
  shared: true,
  shared_limit: "anyone_editable",
});
const { items: formFields } = await call<{ items: Array<{ field_id: string; title: string }> }>(
  "GET", `/bitable/v1/apps/${APP}/tables/${wishTable}/forms/${formId}/fields`);
const formRules: Record<string, { required: boolean; visible: boolean; description?: string }> = {
  [W.teacher]: { required: true, visible: true },
  [W.year]: { required: true, visible: true },
  [W.name]: { required: true, visible: true, description: "学生请写学生姓名" },
  [W.role]: { required: true, visible: true },
  [W.text]: { required: true, visible: true },
  [W.files]: { required: false, visible: true, description: "选填：照片、表情包、GIF 或短视频" },
  [W.hidden]: { required: false, visible: false },
};
for (const field of formFields) {
  const rule = formRules[field.title];
  // 飞书不接受 visible:false 与其他属性同时提交（1254001 WrongRequestBody），隐藏字段只发 visible
  if (rule) await call("PATCH", `/bitable/v1/apps/${APP}/tables/${wishTable}/forms/${formId}/fields/${field.field_id}`, rule.visible ? rule : { visible: false });
}
// API 返回 /share/base/shrcn…（要求登录），匿名可填的是 /share/base/form/shrcn…
const formUrl = form.form.shared_url?.replace(/\/share\/base\/(?!form\/)/, "/share/base/form/");
console.log(`WISH_TABLE_ID=${wishTable}\nWISH_FORM_URL=${formUrl ?? "（未返回，去表单视图手动复制分享链接）"}`);
