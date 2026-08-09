import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { chromium as playwrightChromium } from "playwright-core";

import { renderStudentBillingReportHtml } from "../src/render-student-billing-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const PHOTO_DIR = path.resolve(APP_ROOT, "assets/teacher-optimized");
const CJK_FONT_PATH = path.resolve(APP_ROOT, "assets/fonts/NotoSerifSC-Regular.ttf");
const LOCAL_CHROME = process.env.CHROME_EXECUTABLE_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const photoCache = new Map();
let cjkFontDataUriPromise;

function isServerlessRuntime() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function optimizedPhotoDataUri(file) {
  if (!file) return "";
  if (photoCache.has(file)) return photoCache.get(file);
  const optimizedName = `${path.parse(file).name}.jpg`;
  const task = fs.readFile(path.join(PHOTO_DIR, optimizedName))
    .then((buffer) => `data:image/jpeg;base64,${buffer.toString("base64")}`);
  photoCache.set(file, task);
  return task;
}

function isUsablePhotoDataUri(value) {
  return typeof value === "string" && value.startsWith("data:") && value.length > 32;
}

export async function prepareTeachers(teachers) {
  return Promise.all(teachers.map(async (teacher) => ({
    ...teacher,
    // 自定义老师的照片由前端压缩后直接传 data URI，跳过 assets 文件查找；
    // 内置老师（photo 为空字符串时同理）维持按文件名读取优化图。
    photoDataUri: isUsablePhotoDataUri(teacher.photoDataUri)
      ? teacher.photoDataUri
      : await optimizedPhotoDataUri(teacher.photo),
  })));
}

async function loadCjkFontDataUri() {
  if (!cjkFontDataUriPromise) {
    cjkFontDataUriPromise = fs.readFile(CJK_FONT_PATH)
      .then((buffer) => `data:font/ttf;base64,${buffer.toString("base64")}`);
  }
  return cjkFontDataUriPromise;
}

export async function ensureServerlessFontconfig() {
  const fontDirectory = process.env.FONTCONFIG_PATH || path.join(tmpdir(), "fonts");
  const cacheDirectory = path.join(tmpdir(), "fonts-cache");
  const configPath = path.join(fontDirectory, "fonts.conf");
  await Promise.all([
    fs.mkdir(fontDirectory, { recursive: true }),
    fs.mkdir(cacheDirectory, { recursive: true }),
  ]);
  await fs.writeFile(configPath, `<?xml version="1.0"?>
<fontconfig>
  <dir>${fontDirectory}</dir>
  <cachedir>${cacheDirectory}</cachedir>
  <config></config>
</fontconfig>
`, "utf8");
  process.env.FONTCONFIG_PATH = fontDirectory;
  process.env.FONTCONFIG_FILE = configPath;
}

async function browserLaunchOptions() {
  if (isServerlessRuntime()) {
    const { default: serverlessChromium } = await import("@sparticuz/chromium");
    // PDF 生成不需要 WebGL；关闭 graphics mode 后 args 里的 SwiftShader/ANGLE
    // 旗标会换成 --disable-webgl，避免 serverless Chromium 在 Page.printToPDF
    // 阶段崩溃（线上实测报 Printing failed）。
    serverlessChromium.setGraphicsMode = false;
    // Register the font with fontconfig instead of embedding its 23 MB binary
    // as a 33 MB base64 data URI in every report page. Large data-URI pages can
    // make serverless Chromium fail in Page.printToPDF before it returns a PDF.
    // @sparticuz/chromium's font() creates /tmp/fonts before executablePath()
    // can unpack its fonts.conf there. Own the config explicitly so a cold or
    // warm Lambda always starts Chromium with a valid fontconfig setup.
    await ensureServerlessFontconfig();
    await serverlessChromium.font(CJK_FONT_PATH);
    return {
      args: serverlessChromium.args,
      executablePath: await serverlessChromium.executablePath(),
      // v138 的 args 已内置 --headless='shell'（chrome-headless-shell），
      // serverlessChromium.headless 在该版本已被移除，保持 undefined 让
      // Playwright 用默认 headless 即可，用户 args 里的 shell 旗标优先生效。
      headless: serverlessChromium.headless ?? true,
    };
  }
  return {
    executablePath: LOCAL_CHROME,
    headless: true,
  };
}

async function prepareReportPage(page, html) {
  await page.setContent(html, { waitUntil: "load" });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(async () => {
    await document.fonts?.load('16px "Noto Serif SC"', "菁仕 示例学生 课时费明细");
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all([...document.images].map((image) => (
      image.complete
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", reject, { once: true });
        })
    )));
  });
  await page.addStyleTag({
    content: `
      @page { size: auto !important; margin: 0 !important; }
      body { background: #fff !important; }
      .document {
        width: auto !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .page {
        width: 920px !important;
        min-height: auto !important;
        margin: 0 !important;
        box-shadow: none !important;
        overflow: visible !important;
        page-break-after: auto !important;
        break-after: auto !important;
      }
      .page.cover { min-height: 960px !important; }
      .page.closing { min-height: 560px !important; }
      .cover-lines { display: none !important; }
    `,
  });
}

async function sectionMeasurements(page) {
  return page.evaluate(() => [...document.querySelectorAll(".page")].map((element, index) => {
    const rect = element.getBoundingClientRect();
    return {
      index,
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
    };
  }));
}

async function showOnlySection(page, index) {
  await page.evaluate((activeIndex) => {
    [...document.querySelectorAll(".page")].forEach((element, elementIndex) => {
      element.style.display = elementIndex === activeIndex ? "" : "none";
    });
  }, index);
}

async function mergePdfBuffers(buffers) {
  const output = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  return Buffer.from(await output.save({ useObjectStreams: true }));
}

async function renderRasterPdf(page, sections) {
  const output = await PDFDocument.create();
  for (const section of sections) {
    await showOnlySection(page, section.index);
    const imageBuffer = await page.screenshot({
      type: "jpeg",
      quality: 92,
      clip: {
        x: 0,
        y: 0,
        width: section.width,
        height: section.height,
      },
    });
    if (imageBuffer.length < 1_000) {
      throw new Error("PDF 页面渲染失败，请重试");
    }
    const image = await output.embedJpg(imageBuffer);
    const pdfPage = output.addPage([section.width * 0.75, section.height * 0.75]);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: pdfPage.getWidth(),
      height: pdfPage.getHeight(),
    });
  }
  return Buffer.from(await output.save({ useObjectStreams: true }));
}

export async function assertPdfHasTextResources(buffer) {
  const document = await PDFDocument.load(buffer);
  const pageFontCounts = document.getPages().map((page) => {
    const resources = page.node.Resources();
    const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
    return fonts?.keys().length || 0;
  });
  if (!pageFontCounts.length || pageFontCounts.some((count) => count === 0)) {
    throw new Error("PDF 字体加载失败，请重试");
  }
}

function sectionPdfOptions(section) {
  return {
    width: `${section.width}px`,
    height: `${section.height}px`,
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    preferCSSPageSize: false,
    tagged: false,
  };
}

async function printSectionPdf(browser, html, page, section, viewport) {
  await showOnlySection(page, section.index);
  try {
    return await page.pdf(sectionPdfOptions(section));
  } catch (error) {
    // serverless Chromium 偶发在 Page.printToPDF 崩溃；用全新 page 重试一次。
    const retryPage = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    try {
      await prepareReportPage(retryPage, html);
      await showOnlySection(retryPage, section.index);
      return await retryPage.pdf(sectionPdfOptions(section));
    } finally {
      await retryPage.close().catch(() => {});
    }
  }
}

export async function generateStudentBillingPdfBuffer({ report, teachers }) {
  if (!report?.studentName || !Array.isArray(report.courseLines)) {
    throw new Error("报告数据不完整");
  }
  if (!Array.isArray(teachers)) {
    throw new Error("老师资料不完整");
  }

  const [preparedTeachers, cjkFontDataUri] = await Promise.all([
    prepareTeachers(teachers),
    isServerlessRuntime() ? Promise.resolve("") : loadCjkFontDataUri(),
  ]);
  const html = renderStudentBillingReportHtml(report, preparedTeachers, {
    embedTeacherPhotos: false,
    cjkFontDataUri,
    cjkFontFormat: "truetype",
  });
  const browser = await playwrightChromium.launch(await browserLaunchOptions());

  try {
    const viewport = { width: 1120, height: 1200 };
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: 1,
    });
    await prepareReportPage(page, html);
    const sections = await sectionMeasurements(page);

    const buffers = [];

    for (const section of sections) {
      buffers.push(await printSectionPdf(browser, html, page, section, viewport));
    }
    const output = await mergePdfBuffers(buffers);
    try {
      await assertPdfHasTextResources(output);
      return output;
    } catch (error) {
      if (!isServerlessRuntime()) throw error;
      return renderRasterPdf(page, sections);
    }
  } finally {
    await browser.close();
  }
}
