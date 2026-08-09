import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
const PDF_TEMP_ROOT = path.join(tmpdir(), "jingshi-parent-report");
const PDF_TEMP_PREFIX = "session-";
const PDF_TEMP_STALE_MS = 15 * 60 * 1_000;
const PDF_TEMP_MIN_FREE_BYTES = 96 * 1024 * 1024;
const PDF_DISK_CACHE_BYTES = 1024 * 1024;
const RUNTIME_INSTANCE_ID = randomUUID().slice(0, 8);
const photoCache = new Map();
let cjkFontDataUriPromise;
let serverlessChromiumRuntimePromise;

class PdfInfrastructureError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PdfInfrastructureError";
    this.statusCode = 503;
  }
}

class PdfInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PdfInputError";
    this.statusCode = 422;
  }
}

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

export function serverlessChromiumArgs(args, cacheDirectory) {
  return [
    ...args.filter((argument) => (
      !argument.startsWith("--disk-cache-size=")
      && !argument.startsWith("--disk-cache-dir=")
    )),
    `--disk-cache-size=${PDF_DISK_CACHE_BYTES}`,
    `--disk-cache-dir=${cacheDirectory}`,
  ];
}

export async function availableTemporaryBytes(directory = tmpdir()) {
  const statistics = await fs.statfs(directory);
  return Number(statistics.bavail) * Number(statistics.bsize);
}

export async function cleanupStalePdfSessions({
  root = PDF_TEMP_ROOT,
  now = Date.now(),
  staleAfterMs = PDF_TEMP_STALE_MS,
} = {}) {
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  let removed = 0;

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(PDF_TEMP_PREFIX)) return;
    const directory = path.join(root, entry.name);
    const statistics = await fs.stat(directory).catch(() => null);
    if (!statistics || now - statistics.mtimeMs <= staleAfterMs) return;
    try {
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
      removed += 1;
    } catch (error) {
      console.error(`[pdf-runtime] 无法回收陈旧临时目录 ${entry.name}`, error);
    }
  }));

  return removed;
}

export async function createPdfTemporarySession({ root = PDF_TEMP_ROOT } = {}) {
  await cleanupStalePdfSessions({ root });
  const freeBytes = await availableTemporaryBytes(path.dirname(root));
  if (freeBytes < PDF_TEMP_MIN_FREE_BYTES) {
    throw new PdfInfrastructureError(
      `PDF 服务临时空间不足（剩余 ${Math.floor(freeBytes / 1024 / 1024)} MiB）`,
    );
  }

  const directory = await fs.mkdtemp(path.join(root, PDF_TEMP_PREFIX));
  const profileDirectory = path.join(directory, "profile");
  const artifactsDirectory = path.join(directory, "artifacts");
  const cacheDirectory = path.join(directory, "cache");
  try {
    await Promise.all([
      fs.mkdir(profileDirectory),
      fs.mkdir(artifactsDirectory),
      fs.mkdir(cacheDirectory),
    ]);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    directory,
    profileDirectory,
    artifactsDirectory,
    cacheDirectory,
    async cleanup() {
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    },
  };
}

async function browserLaunchOptions({ cacheDirectory } = {}) {
  if (isServerlessRuntime()) {
    if (!serverlessChromiumRuntimePromise) {
      serverlessChromiumRuntimePromise = (async () => {
        const { default: serverlessChromium } = await import("@sparticuz/chromium");
        // PDF 生成不需要 WebGL；关闭 graphics mode 后 args 里的 SwiftShader/ANGLE
        // 旗标会换成 --disable-webgl，避免 serverless Chromium 在 Page.printToPDF
        // 阶段崩溃（线上实测报 Printing failed）。
        serverlessChromium.setGraphicsMode = false;
        // Register the font with fontconfig instead of embedding its 23 MB binary
        // as a 33 MB base64 data URI in every report page. Large data-URI pages can
        // make serverless Chromium fail in Page.printToPDF before it returns a PDF.
        // A shared initialization promise prevents concurrent cold invocations in
        // one Fluid Compute instance from extracting the same Chromium files twice.
        await ensureServerlessFontconfig();
        await serverlessChromium.font(CJK_FONT_PATH);
        return {
          args: serverlessChromium.args,
          executablePath: await serverlessChromium.executablePath(),
          headless: serverlessChromium.headless ?? true,
        };
      })().catch((error) => {
        serverlessChromiumRuntimePromise = undefined;
        throw error;
      });
    }
    const runtime = await serverlessChromiumRuntimePromise;
    return {
      args: serverlessChromiumArgs(runtime.args, cacheDirectory),
      executablePath: runtime.executablePath,
      // v138 的 args 已内置 --headless='shell'（chrome-headless-shell），
      // serverlessChromium.headless 在该版本已被移除，保持 undefined 让
      // Playwright 用默认 headless 即可，用户 args 里的 shell 旗标优先生效。
      headless: runtime.headless,
    };
  }
  return {
    executablePath: LOCAL_CHROME,
    headless: true,
  };
}

// "Target page, context or browser has been closed" 只是症状：它说明 Chromium
// 进程在 launch 之后死亡（崩溃、被系统杀死、或本地 Chrome 自动更新替换了二进制）。
// 真正的错误永远是被这条通用消息盖住的上游异常，所以重试逻辑必须区分
// “浏览器已经死了”（只能换浏览器重来）和“页面级错误”（可在原浏览器内换页重试）。
export function isBrowserDisconnectError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /has been closed|target closed|connection closed|browser disconnected/i.test(message);
}

async function logTemporarySpace(event) {
  if (!isServerlessRuntime()) return;
  const freeBytes = await availableTemporaryBytes().catch(() => null);
  const freeMiB = freeBytes == null ? null : Math.floor(freeBytes / 1024 / 1024);
  console.info(`[pdf-runtime] ${event} instance=${RUNTIME_INSTANCE_ID} tmpFreeMiB=${freeMiB ?? "unknown"}`);
}

async function launchLocalBrowser(viewport) {
  const browser = await playwrightChromium.launch(await browserLaunchOptions());
  let closeRequested = false;
  browser.on("disconnected", () => {
    if (!closeRequested) {
      console.error("[pdf] Chromium 进程意外断开（崩溃或被系统杀死）");
    }
  });
  return {
    isConnected: () => browser.isConnected(),
    initialPage: () => browser.newPage({ viewport, deviceScaleFactor: 1 }),
    newPage: () => browser.newPage({ viewport, deviceScaleFactor: 1 }),
    async close() {
      closeRequested = true;
      await browser.close().catch(() => {});
    },
  };
}

async function launchServerlessBrowser(viewport) {
  const temporarySession = await createPdfTemporarySession();
  let context;
  let closeRequested = false;
  let contextClosed = false;

  try {
    const options = await browserLaunchOptions({
      cacheDirectory: temporarySession.cacheDirectory,
    });
    const freeBytes = await availableTemporaryBytes();
    if (freeBytes < PDF_TEMP_MIN_FREE_BYTES) {
      throw new PdfInfrastructureError(
        `Chromium 解压后临时空间不足（剩余 ${Math.floor(freeBytes / 1024 / 1024)} MiB）`,
      );
    }
    context = await playwrightChromium.launchPersistentContext(
      temporarySession.profileDirectory,
      {
        ...options,
        artifactsDir: temporarySession.artifactsDirectory,
        viewport,
        deviceScaleFactor: 1,
      },
    );
    context.on("close", () => {
      contextClosed = true;
      if (!closeRequested) {
        void logTemporarySpace("chromium-disconnected");
      }
    });

    return {
      isConnected: () => !contextClosed,
      initialPage: async () => context.pages().find((page) => !page.isClosed())
        || context.newPage(),
      newPage: () => context.newPage(),
      async close() {
        closeRequested = true;
        try {
          await context.close().catch(() => {});
        } finally {
          await temporarySession.cleanup().catch((error) => {
            console.error("[pdf-runtime] 本次请求临时目录清理失败", error);
          });
          await logTemporarySpace("session-cleaned");
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await temporarySession.cleanup().catch(() => {});
    throw error;
  }
}

async function launchBrowser(viewport) {
  return isServerlessRuntime()
    ? launchServerlessBrowser(viewport)
    : launchLocalBrowser(viewport);
}

export async function runPdfSession(session, render) {
  try {
    return await render(session);
  } finally {
    await session.close();
  }
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

async function printSectionPdf(session, html, page, section) {
  await showOnlySection(page, section.index);
  try {
    return await page.pdf(sectionPdfOptions(section));
  } catch (error) {
    // 浏览器进程已死时不能再 newPage——那只会抛出 "browser has been closed"
    // 把 page.pdf 的真实崩溃原因吞掉。直接上抛，交给外层换浏览器重试。
    if (!session.isConnected() || isBrowserDisconnectError(error)) {
      throw error;
    }
    // serverless Chromium 偶发在 Page.printToPDF 崩溃；用全新 page 重试一次。
    const retryPage = await session.newPage();
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
    throw new PdfInputError("报告数据不完整");
  }
  if (!Array.isArray(teachers)) {
    throw new PdfInputError("老师资料不完整");
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

  // 浏览器进程崩溃是环境性故障（内存压力、serverless 回收、本地 Chrome 自动更新），
  // 与报告内容无关，换一个全新浏览器多半能成功。内容性错误（数据缺失、字体断言）
  // 重试无意义，原样抛出。最多两次尝试，避免把瞬时故障放大成死循环。
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await renderReportPdfWithFreshBrowser(html);
    } catch (error) {
      lastError = error;
      if (!isBrowserDisconnectError(error) || attempt === 2) {
        if (isBrowserDisconnectError(error)) {
          throw new PdfInfrastructureError("Chromium 在生成 PDF 时意外退出", {
            cause: error,
          });
        }
        throw error;
      }
      const freeBytes = isServerlessRuntime()
        ? await availableTemporaryBytes().catch(() => 0)
        : Number.POSITIVE_INFINITY;
      if (freeBytes < PDF_TEMP_MIN_FREE_BYTES) {
        throw new PdfInfrastructureError(
          `PDF 服务临时空间不足（剩余 ${Math.floor(freeBytes / 1024 / 1024)} MiB）`,
          { cause: error },
        );
      }
      console.error(
        `[pdf] 第 ${attempt} 次生成中断（${error instanceof Error ? error.message : String(error)}），换全新浏览器重试`,
      );
    }
  }
  throw lastError;
}

async function renderReportPdfWithFreshBrowser(html) {
  const viewport = { width: 1120, height: 1200 };
  const session = await launchBrowser(viewport);

  return runPdfSession(session, async () => {
    const page = await session.initialPage();
    await prepareReportPage(page, html);
    const sections = await sectionMeasurements(page);

    const buffers = [];

    for (const section of sections) {
      buffers.push(await printSectionPdf(session, html, page, section));
    }
    const output = await mergePdfBuffers(buffers);
    try {
      await assertPdfHasTextResources(output);
      return output;
    } catch (error) {
      if (!isServerlessRuntime()) throw error;
      // 必须等待截图和 PDF 保存结束后才能进入 runPdfSession 的 finally 关闭 context。
      return await renderRasterPdf(page, sections);
    }
  });
}
