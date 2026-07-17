import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

// 桌面 web 风格的家长报告（如 claude-ivy-2488-2026-03.html）走这个目录，
// 与手机竖屏版 outputs/parent_reports/ 区分开，便于并行维护两套交付物。
const DEFAULT_OUTPUT_DIR = path.resolve(PROJECT_ROOT, "outputs", "parent_reports_web");

// 用户指定 PDF 宽度 = 1000px。原 HTML 内 .document 为 min(980px, 100%)，
// viewport 设 1000 让内容贴近 PDF 两侧（仅 10px 留白），同时保留卡片阴影的纵向投影。
// deviceScaleFactor=2 影响位图采样精度（如头像）；矢量文字与之无关，原生 page.pdf()
// 会把字体作为字符存进 PDF。
const PAGE_WIDTH_PX = 1000;
const VIEWPORT = { width: PAGE_WIDTH_PX, height: 1200, deviceScaleFactor: 2 };

const CHROME_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PDF_UNITE_PATH = process.env.PDFUNITE_PATH || "pdfunite";

export function deriveWebPdfOutputPath(inputPath, outputDir = DEFAULT_OUTPUT_DIR) {
  const parsed = path.parse(path.resolve(inputPath));
  return path.join(path.resolve(outputDir), `${parsed.name}.pdf`);
}

// 单页矢量 PDF 选项。注意各项语义同 export-parent-report-pdf.mjs，
// 在此独立维护，确保两条流水线互不影响。
export function buildWebPdfOptions({
  widthPx,
  heightPx,
  continuous = true,
  pageHeightPx = heightPx,
  optimizeForPreview = false,
} = {}) {
  return {
    width: `${widthPx}px`,
    height: `${continuous ? heightPx : pageHeightPx}px`,
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    preferCSSPageSize: false,
    tagged: !optimizeForPreview,
  };
}

async function waitForAssets(page) {
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    const imageLoads = [...document.images].map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", reject, { once: true });
      });
    });
    await Promise.all(imageLoads);
  });
}

// 原始 HTML 内 .page 用 page-break-after: always、@page { size: A4 } 强制分页，
// 这是为浏览器打印准备的。如果直接 page.pdf()，Chromium 会按这些规则把整张文档切成
// 一堆 PDF 页（每个 .page 一断、再加 A4 默认分页），结果就是几十页里大半留白、
// 卡片被拦腰截断、视觉极差。所以在生成 PDF 前必须显式禁用分页规则。
async function configurePagination(page, { continuous = true } = {}) {
  if (!continuous) {
    await page.addStyleTag({
      content: `
        @page { size: auto !important; margin: 0 !important; }
        *, *::before, *::after {
          page-break-inside: auto !important;
          break-inside: auto !important;
        }
        .document {
          padding-top: 0 !important;
          padding-bottom: 0 !important;
        }
        .page {
          margin-top: 0 !important;
          margin-bottom: 0 !important;
          page-break-after: always !important;
          break-after: page !important;
        }
        .page:last-child {
          page-break-after: auto !important;
          break-after: auto !important;
        }
      `,
    });
    return;
  }

  await page.addStyleTag({
    content: `
      @page { size: auto !important; margin: 0 !important; }
      *, *::before, *::after {
        page-break-before: auto !important;
        page-break-after: auto !important;
        page-break-inside: auto !important;
        break-before: auto !important;
        break-after: auto !important;
        break-inside: auto !important;
      }
    `,
  });
}

async function optimizeForPdfPreview(page) {
  await page.addStyleTag({
    content: `
      body {
        background: #eef1f6 !important;
      }
      .page {
        box-shadow: none !important;
      }
      .cover-lines {
        display: none !important;
      }
    `,
  });
}

async function prepareVariableSectionPages(page, sectionSelector) {
  await page.addStyleTag({
    content: `
      body {
        background: #fff !important;
      }
      .document {
        width: auto !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      ${sectionSelector} {
        width: 920px !important;
        min-height: auto !important;
        margin: 0 !important;
        box-shadow: none !important;
        overflow: visible !important;
      }
      ${sectionSelector}.cover {
        min-height: 960px !important;
      }
      ${sectionSelector}.closing {
        min-height: 560px !important;
      }
      .cover-lines {
        display: none !important;
      }
    `,
  });
}

async function measureSections(page, sectionSelector) {
  return page.evaluate((selector) => {
    return [...document.querySelectorAll(selector)].map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        widthPx: Math.max(1, Math.ceil(rect.width)),
        heightPx: Math.max(1, Math.ceil(rect.height)),
      };
    });
  }, sectionSelector);
}

async function showOnlySection(page, sectionSelector, sectionIndex) {
  await page.evaluate(({ selector, index }) => {
    [...document.querySelectorAll(selector)].forEach((element, elementIndex) => {
      element.style.display = elementIndex === index ? "" : "none";
    });
  }, { selector: sectionSelector, index: sectionIndex });
}

function mergePdfFiles(inputPaths, outputPath) {
  if (inputPaths.length === 0) {
    throw new Error("At least one PDF is required to merge");
  }
  if (inputPaths.length === 1) {
    fs.copyFileSync(inputPaths[0], outputPath);
    return;
  }

  const result = spawnSync(PDF_UNITE_PATH, [...inputPaths, outputPath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const detail = stderr ? `: ${stderr}` : "";
    throw new Error(`Failed to merge PDF sections with pdfunite${detail}`);
  }
}

async function measureDocumentHeight(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(1, Math.ceil(
      Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight),
    ));
  });
}

async function exportVariableSectionPdf({
  page,
  outputPath,
  sectionSelector,
  optimizeForPreview,
}) {
  await configurePagination(page, { continuous: true });
  if (optimizeForPreview) {
    await optimizeForPdfPreview(page);
  }
  await prepareVariableSectionPages(page, sectionSelector);

  const sections = await measureSections(page, sectionSelector);
  if (sections.length === 0) {
    throw new Error(`No PDF sections found for selector: ${sectionSelector}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jingshi-section-pdf-"));
  const sectionPaths = [];

  try {
    for (const section of sections) {
      await showOnlySection(page, sectionSelector, section.index);
      const sectionPath = path.join(tmpDir, `section-${String(section.index).padStart(2, "0")}.pdf`);
      sectionPaths.push(sectionPath);
      await page.pdf({
        path: sectionPath,
        ...buildWebPdfOptions({
          widthPx: section.widthPx,
          heightPx: section.heightPx,
          optimizeForPreview,
        }),
      });
    }

    mergePdfFiles(sectionPaths, outputPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return sections;
}

export async function exportWebHtmlToPdf({
  inputPath,
  outputPath,
  outputDir,
  widthPx = PAGE_WIDTH_PX,
  continuous = true,
  pageHeightPx,
  optimizeForPreview = false,
  sectionSelector,
  variableSectionPages = false,
} = {}) {
  if (!inputPath) {
    throw new Error("inputPath is required");
  }

  const absoluteInputPath = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInputPath)) {
    throw new Error(`HTML file not found: ${absoluteInputPath}`);
  }

  const targetDir = outputDir ? path.resolve(outputDir) : DEFAULT_OUTPUT_DIR;
  const absoluteOutputPath = outputPath
    ? path.resolve(outputPath)
    : deriveWebPdfOutputPath(absoluteInputPath, targetDir);

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME_PATH,
  });

  try {
    const page = await browser.newPage({
      viewport: { ...VIEWPORT, width: widthPx },
    });
    await page.emulateMedia({ media: "screen" });
    await page.goto(pathToFileURL(absoluteInputPath).href);
    await waitForAssets(page);
    if (variableSectionPages) {
      const sections = await exportVariableSectionPdf({
        page,
        outputPath: absoluteOutputPath,
        sectionSelector,
        optimizeForPreview,
      });
      return {
        inputPath: absoluteInputPath,
        outputPath: absoluteOutputPath,
        widthPx,
        heightPx: sections.reduce((sum, section) => sum + section.heightPx, 0),
        sections,
        variableSectionPages: true,
        sectionSelector,
        optimizeForPreview,
      };
    }

    await configurePagination(page, { continuous });
    if (optimizeForPreview) {
      await optimizeForPdfPreview(page);
    }

    const heightPx = await measureDocumentHeight(page);

    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    await page.pdf({
      path: absoluteOutputPath,
      ...buildWebPdfOptions({
        widthPx,
        heightPx,
        continuous,
        pageHeightPx,
        optimizeForPreview,
      }),
    });

    return {
      inputPath: absoluteInputPath,
      outputPath: absoluteOutputPath,
      widthPx,
      heightPx,
      continuous,
      pageHeightPx: continuous ? heightPx : pageHeightPx,
      optimizeForPreview,
    };
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: node scripts/export-web-pdf.mjs <html-file> [<html-file> ...]",
    );
    console.error(`  → 输出到 ${path.relative(PROJECT_ROOT, DEFAULT_OUTPUT_DIR)}/`);
    process.exitCode = 1;
    return;
  }

  for (const file of args) {
    const absolute = path.resolve(file);
    if (!fs.existsSync(absolute)) {
      console.error("File not found:", file);
      process.exitCode = 1;
      continue;
    }

    console.log(
      "Converting",
      path.relative(PROJECT_ROOT, absolute),
      "→",
      path.relative(PROJECT_ROOT, DEFAULT_OUTPUT_DIR) + "/",
    );

    try {
      const result = await exportWebHtmlToPdf({ inputPath: absolute });
      const widthPt = (result.widthPx * 72) / 96;
      const heightPt = (result.heightPx * 72) / 96;
      console.log(
        "  →",
        path.relative(PROJECT_ROOT, result.outputPath),
        `(${widthPt.toFixed(0)}pt × ${heightPt.toFixed(0)}pt, vector)`,
      );
    } catch (error) {
      console.error(
        "  Failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
