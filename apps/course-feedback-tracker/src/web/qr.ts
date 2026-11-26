import JSZip from "jszip";
import QRCode from "qrcode";

import { monthlyFeedbackTitle } from "../domain/monthly-feedback";
import { monthlyUrl } from "./monthly-links";
import type { MonthlyLinks, StudentMonth } from "./monthly-links";

/**
 * 卡片 810 × 1013（原来 1080 × 1350 的 3/4）。
 * 微信里发图会再压一遍，810 宽足够清晰，而 PNG 体积和 toBlob 耗时都降到约一半。
 */
const CARD_WIDTH = 810;
const CARD_HEIGHT = 1013;
const SANS = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
/** 官网（jsjy.asia）左上角的同一枚 logo，藏青 #0E2848 + 金 #BA8D45，放在 public/ 下同源加载。 */
// 跟着 vite 的 base 走（/feedback/），写死 "/logo-blue.svg" 会去根目录找
export const BRAND_LOGO_URL = `${import.meta.env.BASE_URL}logo-blue.svg`;
const BRAND_NAVY = "#0E2848";
export const QR_DESCRIPTION = "扫码查看本月待评价的老师，可分次填写";

/**
 * 用 `scale`（每个模块整数像素）而不是 `width`。
 * `width` 会把二维码缩放到指定像素，模块边缘出现抗锯齿灰边，颜色数从 2 涨到上千，
 * PNG 直接压不动——实测单张 67 KB，换成整数 scale 后降到约 10 KB。
 * scale 按模块数算出来、刚好放进 boxPx，适配不同长度的月度链接。
 */
const QR_MARGIN = 2;
export async function monthlyQrDataUrl(url: string, boxPx = 420): Promise<string> {
  const modules = QRCode.create(url, { errorCorrectionLevel: "M" }).modules.size + QR_MARGIN * 2;
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: QR_MARGIN,
    scale: Math.max(1, Math.floor(boxPx / modules)),
    color: { dark: "#18181b", light: "#ffffff" },
  });
}

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && context.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
  return `${value}…`;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`加载图片失败：${src}`));
    image.src = src;
  });
}

let logoPromise: Promise<HTMLImageElement> | undefined;
/** logo 只加载一次，批量生成 260 张时别每张都 new Image()。 */
function brandLogo(): Promise<HTMLImageElement> {
  logoPromise ??= loadImage(BRAND_LOGO_URL);
  return logoPromise;
}

/** 批量生成时复用同一块画布，省掉 260 次 canvas 分配。 */
let sharedCanvas: HTMLCanvasElement | undefined;
function canvasFor(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  sharedCanvas ??= document.createElement("canvas");
  sharedCanvas.width = CARD_WIDTH;
  sharedCanvas.height = CARD_HEIGHT;
  const context = sharedCanvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持 canvas，无法生成二维码卡片");
  context.clearRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  return { canvas: sharedCanvas, context };
}

export async function renderQrCard(task: StudentMonth, url: string): Promise<Blob> {
  const [qrDataUrl, logo] = await Promise.all([monthlyQrDataUrl(url), brandLogo()]);
  const qrImage = await loadImage(qrDataUrl);
  const { canvas, context } = canvasFor();

  context.fillStyle = "#f4f4f5";
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  const cardX = 60;
  const cardY = 60;
  const cardW = CARD_WIDTH - 120;
  const cardH = CARD_HEIGHT - 120;
  const centerX = CARD_WIDTH / 2;
  // 细边框而不是投影：投影是一大片渐变灰，正好是 PNG 最不擅长压缩的内容，
  // 去掉后单张体积明显下降，观感也更干净。
  roundedRect(context, cardX, cardY, cardW, cardH, 30);
  context.fillStyle = "#ffffff";
  context.fill();
  context.strokeStyle = "#e4e4e7";
  context.lineWidth = 2;
  context.stroke();

  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  const maxTextW = cardW - 96;

  context.fillStyle = "#18181b";
  context.font = `700 46px ${SANS}`;
  context.fillText(fitText(context, monthlyFeedbackTitle(task.courseMonth, task.studentName), maxTextW), centerX, cardY + 160);

  context.fillStyle = "#52525b";
  context.font = `400 25px ${SANS}`;
  context.fillText(QR_DESCRIPTION, centerX, cardY + 232);

  // 二维码在一个固定的 420px 方框里居中：自然尺寸随版本在 390–420 之间浮动，
  // 固定框保证下面那两行文字的位置不跟着抖。不缩放，保持模块是纯黑白。
  const qrBox = 420;
  const qrPx = Math.min(qrImage.naturalWidth, qrBox);
  const qrTop = cardY + 276 + (qrBox - qrPx) / 2;
  context.imageSmoothingEnabled = false;
  context.drawImage(qrImage, centerX - qrPx / 2, qrTop, qrPx, qrPx);
  context.imageSmoothingEnabled = true;

  const logoH = 30;
  const logoW = (logo.naturalWidth / logo.naturalHeight) * logoH;
  context.font = `600 21px ${SANS}`;
  const gap = 9;
  const brandStartX = centerX - (logoW + gap + context.measureText("菁仕教育").width) / 2;
  const brandTop = cardY + cardH - 75;
  context.drawImage(logo, brandStartX, brandTop, logoW, logoH);
  context.textAlign = "left";
  context.fillStyle = BRAND_NAVY;
  context.fillText("菁仕教育", brandStartX + logoW + gap, brandTop + 22);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("生成 PNG 失败"))), "image/png");
  });
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

export function cardFileName(task: StudentMonth): string {
  return `${task.courseMonth}-${safeName(task.studentName)}-月度反馈.png`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type BatchPhase = "rendering" | "zipping" | "done" | "cancelled";

export interface BatchProgress {
  phase: BatchPhase;
  done: number;
  total: number;
  /** 打包阶段的百分比（0-100） */
  zipPercent: number;
  failed: Array<{ taskId: string; label: string; reason: string }>;
  fileName?: string;
  sizeBytes?: number;
}

/** 让浏览器有机会重绘进度条，否则整个循环跑完前界面是卡住的。 */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 批量二维码在浏览器里打包下载。
 *
 * 三处性能相关的决定：
 *  - ZIP 用 STORE 不压缩：PNG 本身已经是压缩格式，再 DEFLATE 一遍只是白烧 CPU。
 *  - 画布和 logo 复用，不是每张重新分配。
 *  - 每张之间让出主线程，进度条才会动；否则界面假死。
 *
 * 一个月每位学生一张，直接在浏览器中生成。
 */
export async function downloadQrZip(
  tasks: StudentMonth[],
  links: MonthlyLinks,
  onProgress: (progress: BatchProgress) => void,
  signal?: AbortSignal,
): Promise<BatchProgress> {
  const zip = new JSZip();
  const progress: BatchProgress = { phase: "rendering", done: 0, total: tasks.length, zipPercent: 0, failed: [] };
  const report = () => onProgress({ ...progress, failed: [...progress.failed] });
  report();

  const fileNames = new Set<string>();
  for (const task of tasks) {
    if (signal?.aborted) {
      progress.phase = "cancelled";
      report();
      return progress;
    }
    try {
      const base = cardFileName(task);
      let name = base;
      let index = 2;
      while (fileNames.has(name)) name = base.replace(/\.png$/, `-${index++}.png`);
      zip.file(name, await renderQrCard(task, monthlyUrl(links, task)));
      fileNames.add(name);
    } catch (error) {
      progress.failed.push({
        taskId: task.studentRecordId,
        label: task.studentName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    progress.done += 1;
    report();
    await yieldToBrowser();
  }

  if (progress.failed.length > 0) {
    const rows = progress.failed.map((item) => `${item.taskId},${item.label},${item.reason}`);
    zip.file("生成失败清单.csv", `﻿学生档案ID,学生,失败原因\r\n${rows.join("\r\n")}\r\n`);
  }

  progress.phase = "zipping";
  report();
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) => {
    progress.zipPercent = meta.percent;
    report();
  });

  if (signal?.aborted) {
    progress.phase = "cancelled";
    report();
    return progress;
  }

  const fileName = `月度反馈二维码-${tasks[0]?.courseMonth ?? ""}.zip`;
  downloadBlob(blob, fileName);
  progress.phase = "done";
  progress.zipPercent = 100;
  progress.fileName = fileName;
  progress.sizeBytes = blob.size;
  report();
  return progress;
}
