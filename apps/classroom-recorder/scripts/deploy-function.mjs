/**
 * 打包并部署 classroom-api：server.env（已 gitignore）+ cloudbaserc.json 合成 cloudbaserc.local.json 再部署，
 * 然后创建每分钟定时触发器（已存在时 tcb 会报错，忽略即可）。
 * --build-only：只打包和生成配置，不部署；没有 server.env 时也能跑（用于检查打包）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildOnly = process.argv.includes("--build-only");
const envFile = resolve(root, "server.env");
const envVariables = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    const value = trimmed.slice(index + 1).trim();
    if (index > 0 && value) envVariables[trimmed.slice(0, index).trim()] = value;
  }
}
const required = [
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "TEACHER_APP_TOKEN", "TEACHER_TABLE_ID", "SCHEDULE_APP_TOKEN", "SCHEDULE_TABLE_ID",
  "API_BASE_URL", "REPORT_BASE_URL", "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "AI_BASE_URL", "AI_API_KEY", "AI_MODEL",
  "CLOUDBASE_ENV_ID", "CLOUDBASE_API_KEY",
];
const missing = required.filter((key) => !envVariables[key]);
if (missing.length && !buildOnly) {
  console.error(`server.env 缺少：${missing.join("、")}（先复制 server.env.example 为 server.env 并填入真实值）`);
  process.exit(1);
}

const outDir = resolve(root, "dist-functions/classroom-api");
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [resolve(root, "functions/classroom-api/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  logLevel: "info",
});
writeFileSync(resolve(outDir, "package.json"), `${JSON.stringify({ name: "classroom-api", version: "1.0.0", main: "index.js", private: true }, null, 2)}\n`);
if (buildOnly) process.exit(0);

const config = JSON.parse(readFileSync(resolve(root, "cloudbaserc.json"), "utf8"));
config.functions = config.functions.map((fn) => ({ ...fn, envVariables }));
const generated = resolve(root, "cloudbaserc.local.json");
writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`);

execFileSync("tcb", ["fn", "deploy", "classroom-api", "--force", "--config-file", generated], { cwd: root, stdio: "inherit" });
try {
  execFileSync("tcb", ["fn", "trigger", "create", "classroom-api", "--config-file", generated], { cwd: root, stdio: "inherit" });
} catch {
  console.log("定时触发器创建失败（多半是已存在），可用 tcb fn detail classroom-api 确认。");
}
