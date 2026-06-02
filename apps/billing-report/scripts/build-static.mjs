// 构建可部署到 Vercel 的静态站：先同步共享内核，再把 web/ 拷进 dist/。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

// 1) 把 billing-core 同步进 web/assets/report-core.js（浏览器 ESM 依赖它）
execFileSync(process.execPath, [path.join(__dirname, "sync-core.mjs")], { stdio: "inherit" });

// 2) web/ → dist/
const SRC = path.resolve(APP_ROOT, "web");
const DIST = path.resolve(APP_ROOT, "dist");
fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });

console.log("built static app into apps/billing-report/dist/");
