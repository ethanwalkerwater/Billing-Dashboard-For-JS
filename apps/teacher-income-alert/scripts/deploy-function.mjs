/**
 * 部署 income-api：把不含密钥的 cloudbaserc.json 和本地 server.env 合成 cloudbaserc.local.json（已 gitignore）再部署。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, "server.env");
const generated = resolve(root, "cloudbaserc.local.json");

if (!existsSync(envFile)) {
  console.error(`找不到 ${envFile}，请先复制 server.env.example 为 server.env 并填入真实值。`);
  process.exit(1);
}

const envVariables = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const index = trimmed.indexOf("=");
  if (index < 1) continue;
  const value = trimmed.slice(index + 1).trim();
  if (value) envVariables[trimmed.slice(0, index).trim()] = value;
}

const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_SCHEDULE_APP_TOKEN", "FEISHU_SCHEDULE_TABLE_ID", "CLOUDBASE_ENV_ID", "CLOUDBASE_API_KEY"];
const missing = required.filter((key) => !envVariables[key]);
if (missing.length > 0) {
  console.error(`server.env 缺少：${missing.join("、")}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(resolve(root, "cloudbaserc.json"), "utf8"));
config.functions = config.functions.map((fn) => ({ ...fn, envVariables }));
writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`);

execFileSync("tcb", ["fn", "deploy", "income-api", "--force", "--config-file", generated], { cwd: root, stdio: "inherit" });
