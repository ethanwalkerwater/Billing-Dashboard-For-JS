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

const payrollDefaults = process.env.JINGSHI_PAYROLL_DEFAULTS_PATH
  ? path.resolve(process.env.JINGSHI_PAYROLL_DEFAULTS_PATH)
  : path.resolve(REPO_ROOT, "data/local/teacher-income/defaults.json");
const payrollDefaultsDest = path.resolve(APP_ROOT, "web/assets/payroll/defaults.json");
if (fs.existsSync(payrollDefaults)) {
  fs.mkdirSync(path.dirname(payrollDefaultsDest), { recursive: true });
  fs.copyFileSync(payrollDefaults, payrollDefaultsDest);
  console.log(`synced payroll defaults -> ${path.relative(REPO_ROOT, payrollDefaultsDest)}`);
} else {
  fs.rmSync(payrollDefaultsDest, { force: true });
  console.log(`no local payroll defaults at ${path.relative(REPO_ROOT, payrollDefaults)}`);
}
