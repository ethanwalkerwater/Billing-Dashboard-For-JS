import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportWebHtmlToPdf } from "./export-web-pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_HTML_DIR = path.resolve(PROJECT_ROOT, "outputs/parent_reports/generated");
const DEFAULT_PDF_DIR = path.resolve(PROJECT_ROOT, "outputs/parent_reports/generated_pdfs");
const DEFAULT_WIDTH_PX = 1120;

export function deriveStudentBillingPdfOutputPath(inputPath, outputDir = DEFAULT_PDF_DIR) {
  const parsed = path.parse(path.resolve(inputPath));
  return path.join(path.resolve(outputDir), `${parsed.name}.pdf`);
}

export function listStudentBillingHtmlFiles(inputDir = DEFAULT_HTML_DIR) {
  const absoluteInputDir = path.resolve(inputDir);
  if (!fs.existsSync(absoluteInputDir)) return [];

  return fs.readdirSync(absoluteInputDir)
    .filter((entry) => entry.toLowerCase().endsWith(".html"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((entry) => path.join(absoluteInputDir, entry));
}

export function buildStudentBillingPdfExportOptions({
  widthPx = DEFAULT_WIDTH_PX,
} = {}) {
  return {
    widthPx,
    sectionSelector: ".page",
    variableSectionPages: true,
    optimizeForPreview: true,
  };
}

export async function exportStudentBillingPdfs({
  inputDir = DEFAULT_HTML_DIR,
  outputDir = DEFAULT_PDF_DIR,
  widthPx = DEFAULT_WIDTH_PX,
} = {}) {
  const files = listStudentBillingHtmlFiles(inputDir);
  const results = [];
  const pdfOptions = buildStudentBillingPdfExportOptions({ widthPx });

  for (const inputPath of files) {
    const outputPath = deriveStudentBillingPdfOutputPath(inputPath, outputDir);
    const result = await exportWebHtmlToPdf({
      inputPath,
      outputPath,
      ...pdfOptions,
    });
    results.push(result);
  }

  return {
    inputDir: path.resolve(inputDir),
    outputDir: path.resolve(outputDir),
    files,
    results,
  };
}

async function main() {
  const result = await exportStudentBillingPdfs();

  if (result.files.length === 0) {
    console.log("No generated student billing HTML files found in", result.inputDir);
    process.exitCode = 1;
    return;
  }

  console.log(`Exported ${result.results.length} student billing PDFs`);
  for (const pdf of result.results) {
    if (pdf.variableSectionPages) {
      const pageSummary = pdf.sections
        .map((section) => {
          const widthPt = (section.widthPx * 72) / 96;
          const heightPt = (section.heightPx * 72) / 96;
          return `${widthPt.toFixed(0)}×${heightPt.toFixed(0)}pt`;
        })
        .join(", ");
      console.log(pdf.outputPath, `(${pdf.sections.length} section pages: ${pageSummary}, vector)`);
    } else {
      const widthPt = (pdf.widthPx * 72) / 96;
      const heightPt = ((pdf.continuous === false ? pdf.pageHeightPx : pdf.heightPx) * 72) / 96;
      console.log(
        pdf.outputPath,
        pdf.continuous === false
          ? `(${widthPt.toFixed(0)}pt × ${heightPt.toFixed(0)}pt pages, vector)`
          : `(${widthPt.toFixed(0)}pt × ${heightPt.toFixed(0)}pt, vector)`,
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
