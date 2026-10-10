/**
 * 打包并部署 cancel-api（学生自助取消课程）。
 *
 * 用独立的飞书应用，密钥放在 cancel.env（已 gitignore，模板见 cancel.env.example）；
 * CloudBase 数据库的 CLOUDBASE_ENV_ID / CLOUDBASE_API_KEY 复用 server.env。
 * 生成的 cloudbaserc.cancel.local.json 同样不进 Git。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv(file) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    console.error(`找不到 ${path}`);
    process.exit(1);
  }
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    const value = trimmed.slice(index + 1).trim();
    if (index > 0 && value) values[trimmed.slice(0, index).trim()] = value;
  }
  return values;
}

const server = readEnv("server.env");
const envVariables = {
  ...readEnv("cancel.env"),
  CLOUDBASE_ENV_ID: server.CLOUDBASE_ENV_ID,
  CLOUDBASE_API_KEY: server.CLOUDBASE_API_KEY,
};
const required = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "CANCEL_SCHEDULE_APP_TOKEN",
  "CANCEL_SCHEDULE_TABLE_ID",
  "CANCEL_STUDENT_TABLE_ID",
  "CANCEL_REQUEST_APP_TOKEN",
  "CANCEL_REQUEST_TABLE_ID",
  "CANCEL_FORM_URL",
  "CANCEL_GROUP_CHAT_ID",
  "CLOUDBASE_ENV_ID",
  "CLOUDBASE_API_KEY",
];
const missing = required.filter((key) => !envVariables[key]);
if (missing.length) {
  console.error(`cancel.env / server.env 缺少：${missing.join("、")}`);
  process.exit(1);
}

const outDir = resolve(root, "dist-functions/cancel-api");
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [resolve(root, "functions/cancel-api/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  logLevel: "info",
});
writeFileSync(resolve(outDir, "package.json"), `${JSON.stringify({ name: "cancel-api", version: "1.0.0", main: "index.js", private: true }, null, 2)}\n`);

const base = JSON.parse(readFileSync(resolve(root, "cloudbaserc.json"), "utf8"));
const config = {
  version: base.version,
  envId: base.envId,
  region: base.region,
  functionRoot: base.functionRoot,
  functions: [
    {
      name: "cancel-api",
      timeout: 30,
      memorySize: 256,
      runtime: "Nodejs20.19",
      handler: "index.main",
      installDependency: false,
      description: "学生自助取消课程：选课、一次性取消编号、飞书问卷回调写课表并通知老师",
      envVariables,
    },
  ],
};
const generated = resolve(root, "cloudbaserc.cancel.local.json");
writeFileSync(generated, `${JSON.stringify(config, null, 2)}\n`);
if (process.argv.includes("--build-only")) process.exit(0);
execFileSync("tcb", ["fn", "deploy", "cancel-api", "--force", "--config-file", generated], { cwd: root, stdio: "inherit" });
