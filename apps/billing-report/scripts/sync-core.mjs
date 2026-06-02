// 把共享内核 @jingshi/billing-core 的 report-core.js 拷贝到网页静态目录，
// 让浏览器原生 ESM（web/assets/app.js 里的 import "./report-core.js"）能直接加载。
// web/assets/report-core.js 是生成物，已在 .gitignore 中忽略，唯一真源在 packages/billing-core。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");

const SOURCE = path.resolve(REPO_ROOT, "packages/billing-core/src/report-core.js");
const DEST = path.resolve(APP_ROOT, "web/assets/report-core.js");

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(SOURCE, DEST);

console.log(`synced billing-core → ${path.relative(REPO_ROOT, DEST)}`);
