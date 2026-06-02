import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const REPORT_DIR = path.resolve(PROJECT_ROOT, "outputs", "parent_reports");

// 手机竖屏设计稿宽度 = 390px。viewport 设为 390 让 .document width:390px 刚好填满。
// PDF 用 page.pdf() 矢量输出，文字以字符存储，无论怎么放大都清晰可选；deviceScaleFactor
// 对矢量文字无影响，仅决定头像等位图的采样精度，2x 在 retina 屏幕上已经足够锐利。
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 };

const CHROME_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function derivePdfOutputPath(inputPath, outputPath) {
  if (outputPath) return path.resolve(outputPath);
  const absoluteInput = path.resolve(inputPath);
  const parsed = path.parse(absoluteInput);
  return path.join(parsed.dir, `${parsed.name}.pdf`);
}

// 单页矢量 PDF 的 page.pdf() 选项。
// - width/height 为 px 字符串：让 Playwright 把整张文档当作一张连续页面，避免 Chromium
//   默认的 A4 分页和切边。
// - printBackground: true：保留 .page 上的 ivory 背景与卡片阴影，否则 PDF 会丢掉所有
//   背景色，看起来空荡荡。
// - margin 全 0 字符串：与 width/height 完全对齐，杜绝白边。
// - preferCSSPageSize: false：忽略 HTML 内可能存在的 @page 规则，强制采用我们传入的尺寸。
// - tagged: true：生成 Tagged PDF，文字以矢量字符存储，既保证清晰度，又能被读屏识别、
//   被家长选中复制。
export function buildContinuousPdfOptions({ widthPx, heightPx } = {}) {
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

async function measureDocument(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const ceil = (value) => Math.max(1, Math.ceil(value));
    return {
      width: ceil(Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth)),
      height: ceil(Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight)),
    };
  });
}

export async function exportParentReportPdf({ inputPath, outputPath } = {}) {
  if (!inputPath) {
    throw new Error("inputPath is required");
  }

  const absoluteInputPath = path.resolve(inputPath);
  if (!fs.existsSync(absoluteInputPath)) {
    throw new Error(`HTML file not found: ${absoluteInputPath}`);
  }

  const absoluteOutputPath = derivePdfOutputPath(absoluteInputPath, outputPath);

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME_PATH,
  });

  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.emulateMedia({ media: "screen" });
    await page.goto(pathToFileURL(absoluteInputPath).href);
    await waitForAssets(page);

    const { width, height } = await measureDocument(page);

    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    await page.pdf({
      path: absoluteOutputPath,
      ...buildContinuousPdfOptions({ widthPx: width, heightPx: height }),
    });

    return {
      inputPath: absoluteInputPath,
      outputPath: absoluteOutputPath,
      widthPx: width,
      heightPx: height,
    };
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  const args = argv.slice(2);
  const fileArgs = args.filter((arg) => arg !== "--single-page" && arg !== "-s");

  if (fileArgs.length === 0) {
    // Batch mode
    if (!fs.existsSync(REPORT_DIR)) {
      console.log("No HTML files found in", REPORT_DIR);
      process.exitCode = 1;
      return;
    }
    const files = fs
      .readdirSync(REPORT_DIR)
      .filter((entry) => entry.endsWith(".html"))
      .map((entry) => path.join(REPORT_DIR, entry));

    for (const file of files) {
      console.log("Converting", path.relative(PROJECT_ROOT, file), "...");
      try {
        const result = await exportParentReportPdf({ inputPath: file });
        console.log("  →", path.relative(PROJECT_ROOT, result.outputPath), `(${result.pageCount} pages)`);
      } catch (error) {
        console.error("  Failed:", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
    return;
  }

  // Single file mode: input [output]
  const inputPath = path.resolve(fileArgs[0]);
  if (!fs.existsSync(inputPath)) {
    console.error("File not found:", inputPath);
    process.exitCode = 1;
    return;
  }
  const outputPath = fileArgs[1] ? path.resolve(fileArgs[1]) : undefined;

  console.log("Converting", path.relative(PROJECT_ROOT, inputPath), "...");
  try {
    const result = await exportParentReportPdf({ inputPath, outputPath });
    const widthPt = (result.widthPx * 72) / 96;
    const heightPt = (result.heightPx * 72) / 96;
    console.log("  →", path.relative(PROJECT_ROOT, result.outputPath), `(${widthPt.toFixed(0)}pt × ${heightPt.toFixed(0)}pt)`);
  } catch (error) {
    console.error("  Failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
