/**
 * 打包并部署 birthday-api：server.env（已 gitignore）+ cloudbaserc.json 合成 cloudbaserc.local.json 再部署，
 * 然后按配置创建定时触发器（已存在时 tcb 会报错，忽略即可）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, "server.env");
if (!existsSync(envFile)) {
  console.error(`找不到 ${envFile}，请先复制 server.env.example 为 server.env 并填入真实值。`);
  process.exit(1);
}
const envVariables = {};
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const index = trimmed.indexOf("=");
  const value = trimmed.slice(index + 1).trim();
  if (index > 0 && value) envVariables[trimmed.slice(0, index).trim()] = value;
}
const required = [
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "TEACHER_APP_TOKEN", "TEACHER_TABLE_ID", "WISH_TABLE_ID", "WISH_FORM_URL",
  "SCHEDULE_APP_TOKEN", "SCHEDULE_TABLE_ID", "BIRTHDAY_ACADEMIC_CHAT_ID", "BIRTHDAY_GROUP_CHAT_ID", "PAGE_BASE_URL", "PAGE_TOKEN_PEPPER",
];
const missing = required.filter((key) => !envVariables[key]);
if (missing.length) {
  console.error(`server.env 缺少：${missing.join("、")}`);
  process.exit(1);
}

const outDir = resolve(root, "dist-functions/birthday-api");
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [resolve(root, "functions/birthday-api/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  logLevel: "info",
});
writeFileSync(resolve(outDir, "package.json"), `${JSON.stringify({ name: "birthday-api", version: "1.0.0", main: "index.js", private: true }, null, 2)}\n`);

const config = JSON.parse(readFileSync(resolve(root, "cloudbaserc.json"), "utf8"));
config.functions = config.functions.map((fn) => ({ ...fn, envVariables }));
const generated = resolve(root, "cloudbaserc.local.json");
writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`);
if (process.argv.includes("--build-only")) process.exit(0);

execFileSync("tcb", ["fn", "deploy", "birthday-api", "--force", "--config-file", generated], { cwd: root, stdio: "inherit" });
try {
  execFileSync("tcb", ["fn", "trigger", "create", "birthday-api", "--config-file", generated], { cwd: root, stdio: "inherit" });
} catch {
  console.log("定时触发器创建失败（多半是已存在），可用 tcb fn detail birthday-api 确认。");
}
