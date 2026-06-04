import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRawScheduleLookup,
  buildStudentMonthReports,
  parseCompleteBillingCsv,
  safeFileName,
} from "./student-billing-batch-data.mjs";
import { renderStudentBillingReportHtml } from "./render-student-billing-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

const DEFAULT_COMPLETE_DIR = path.resolve(PROJECT_ROOT, "data/完整课时费");
const DEFAULT_SCHEDULE = path.resolve(PROJECT_ROOT, "data/raw/schedule.csv");
const DEFAULT_TEACHERS = path.resolve(PROJECT_ROOT, "apps/parent-report/data/teachers.json");
const DEFAULT_OUTPUT = path.resolve(PROJECT_ROOT, "outputs/parent_reports/generated");

function listCsvFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((file) => file.toLowerCase().endsWith(".csv"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((file) => path.join(directory, file));
}

export function generateStudentBillingReports({
  completeBillingDir = DEFAULT_COMPLETE_DIR,
  schedulePath = DEFAULT_SCHEDULE,
  teachersPath = DEFAULT_TEACHERS,
  outputDir = DEFAULT_OUTPUT,
  embedTeacherPhotos = true,
} = {}) {
  const inputFiles = listCsvFiles(completeBillingDir);
  const billingRows = inputFiles.flatMap((file) => (
    parseCompleteBillingCsv(fs.readFileSync(file, "utf8"), file)
  ));
  const scheduleLookup = buildRawScheduleLookup(fs.readFileSync(schedulePath, "utf8"));
  const { teachers } = JSON.parse(fs.readFileSync(teachersPath, "utf8"));
  const reports = buildStudentMonthReports(billingRows, scheduleLookup);

  fs.mkdirSync(outputDir, { recursive: true });
  const written = reports.map((report) => {
    const fileName = `${safeFileName(report.studentName)}-${report.month}.html`;
    const outputPath = path.join(outputDir, fileName);
    const html = renderStudentBillingReportHtml(report, teachers, { embedTeacherPhotos });
    fs.writeFileSync(outputPath, html, "utf8");
    return outputPath;
  });

  return {
    inputFiles,
    reports,
    written,
    outputDir,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = generateStudentBillingReports();
  console.log(`Generated ${result.written.length} parent billing reports`);
  for (const file of result.written) console.log(file);
}
