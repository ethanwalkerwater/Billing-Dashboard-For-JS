import fs from "node:fs";
import path from "node:path";
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

export function deriveWebPdfOutputPath(inputPath, outputDir = DEFAULT_OUTPUT_DIR) {
  const parsed = path.parse(path.resolve(inputPath));
  return path.join(path.resolve(outputDir), `${parsed.name}.pdf`);
}

// 单页矢量 PDF 选项。注意各项语义同 export-parent-report-pdf.mjs，
// 在此独立维护，确保两条流水线互不影响。
export function buildWebPdfOptions({ widthPx, heightPx } = {}) {
  return {
    width: `${widthPx}px`,
    height: `${heightPx}px`,
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    preferCSSPageSize: false,
    tagged: true,
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
async function disablePagination(page) {
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

async function measureDocumentHeight(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(1, Math.ceil(
      Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight),
    ));
  });
}

export async function exportWebHtmlToPdf({
  inputPath,
  outputPath,
  outputDir,
  widthPx = PAGE_WIDTH_PX,
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
    await disablePagination(page);

    const heightPx = await measureDocumentHeight(page);

    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    await page.pdf({
      path: absoluteOutputPath,
      ...buildWebPdfOptions({ widthPx, heightPx }),
    });

    return {
      inputPath: absoluteInputPath,
      outputPath: absoluteOutputPath,
      widthPx,
      heightPx,
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
