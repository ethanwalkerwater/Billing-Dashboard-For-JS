/**
 * 一次性：给「反馈课程月份」还空着的答卷补上值（tsx scripts/backfill-feedback-month.ts，加 --write 才真写）。
 * 补的值就是没填时的默认归属——提交月份的上一个月（10 月交的是 9 月的课），所以归属和分数都不会变，
 * 只是在飞书表里能直接看到每份答卷评的是哪个月。学生、老师都没填的空行不动。
 */
import { readFileSync } from "node:fs";

import { FEEDBACK_MONTH_FIELD, monthOfShanghai, shiftMonth } from "../src/domain";
import { FeishuClient } from "../src/server/feishu/client";
import { loadFeishuConfig } from "../src/server/feishu/config";
import { parseFeedbackResponse, readFeedbackCourseMonth } from "../src/server/feishu/parsers";

for (const line of readFileSync(new URL("../server.env", import.meta.url), "utf8").split("\n")) {
  const index = line.indexOf("=");
  if (index > 0 && !line.trim().startsWith("#")) process.env[line.slice(0, index).trim()] ??= line.slice(index + 1).trim();
}
const config = loadFeishuConfig();
const client = new FeishuClient({ appId: config.appId, appSecret: config.appSecret });
const records = await client.listAllRecords({ appToken: config.feedbackAppToken, tableId: config.responseTableId });

const updates: Array<{ record_id: string; fields: Record<string, string> }> = [];
const byMonth = new Map<string, number>();
for (const record of records) {
  if (readFeedbackCourseMonth(record.fields)) continue;
  let parsed;
  try {
    parsed = parseFeedbackResponse(record);
  } catch {
    continue;
  }
  if (parsed.studentNames.length === 0 && parsed.teacherNames.length === 0) continue;
  const courseMonth = shiftMonth(monthOfShanghai(parsed.submittedAt), -1);
  updates.push({ record_id: record.record_id, fields: { [FEEDBACK_MONTH_FIELD]: courseMonth } });
  byMonth.set(courseMonth, (byMonth.get(courseMonth) ?? 0) + 1);
}
console.log(`共 ${records.length} 份，要补 ${updates.length} 份：`, Object.fromEntries([...byMonth].sort()));

if (process.argv.includes("--write")) {
  const tokenResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  const { tenant_access_token: token } = (await tokenResponse.json()) as { tenant_access_token: string };
  for (let index = 0; index < updates.length; index += 500) {
    const response = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.feedbackAppToken}/tables/${config.responseTableId}/records/batch_update`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ records: updates.slice(index, index + 500) }),
      },
    );
    const body = (await response.json()) as { code: number; msg: string };
    if (body.code !== 0) throw new Error(`批量更新失败：${body.code} ${body.msg}`);
    console.log(`已写 ${Math.min(index + 500, updates.length)} / ${updates.length}`);
  }
} else {
  console.log("预演，没写飞书。确认无误后加 --write。");
}
