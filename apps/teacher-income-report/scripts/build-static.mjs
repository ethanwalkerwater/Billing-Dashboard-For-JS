import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

execFileSync(process.execPath, [path.join(__dirname, "sync-core.mjs")], { stdio: "inherit" });

const src = path.resolve(APP_ROOT, "web");
const dist = path.resolve(APP_ROOT, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(src, dist, { recursive: true });

console.log("built static app into apps/teacher-income-report/dist/");
