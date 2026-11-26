/**
 * 比对学生页写死的问卷（src/domain/monthly-questions.ts）和线上飞书答卷表，只读。
 * 改题后、部署前跑：npm run check:questions
 */
import { FeishuClient } from "../src/server/feishu/client";
import { loadFeishuConfig } from "../src/server/feishu/config";
import { formDrift } from "../src/server/monthly-answer";

const config = loadFeishuConfig();
const client = new FeishuClient({ appId: config.appId, appSecret: config.appSecret });
client.listAllFields({ appToken: config.feedbackAppToken, tableId: config.responseTableId }).then((fields) => {
  const drift = formDrift(fields);
  if (drift.length === 0) return console.log(`一致：飞书答卷表 ${fields.length} 个字段和学生页问卷对得上。`);
  console.error(`有 ${drift.length} 处对不上：\n${drift.map((line) => "· " + line).join("\n")}`);
  process.exitCode = 1;
});
