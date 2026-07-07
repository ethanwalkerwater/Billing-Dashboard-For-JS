import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");

for (const file of ["report-core.js", "payroll-core.js"]) {
  const source = path.resolve(REPO_ROOT, "packages/billing-core/src", file);
  const dest = path.resolve(APP_ROOT, "web/assets", file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  console.log(`synced billing-core -> ${path.relative(REPO_ROOT, dest)}`);
}

const payrollDefaults = path.resolve(REPO_ROOT, "data/payroll/normalized/master/defaults.json");
if (fs.existsSync(payrollDefaults)) {
  const dest = path.resolve(APP_ROOT, "web/assets/payroll/defaults.json");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(payrollDefaults, dest);
  console.log(`synced payroll defaults -> ${path.relative(REPO_ROOT, dest)}`);
}
