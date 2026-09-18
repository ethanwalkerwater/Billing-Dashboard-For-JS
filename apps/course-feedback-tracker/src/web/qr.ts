import JSZip from "jszip";
import QRCode from "qrcode";

import { buildPrefilledFormUrl } from "../domain";
import type { StoredFeedbackTask } from "../server/tasks/types";
import { feishuFormUrl } from "./cloudbase";

/**
 * 卡片 810 × 1013（原来 1080 × 1350 的 3/4）。
 * 微信里发图会再压一遍，810 宽足够清晰，而 PNG 体积和 toBlob 耗时都降到约一半。
 */
const CARD_WIDTH = 810;
const CARD_HEIGHT = 1013;
const SANS = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
/** 官网（jsjy.asia）左上角的同一枚 logo，藏青 #0E2848 + 金 #BA8D45，放在 public/ 下同源加载。 */
export const BRAND_LOGO_URL = "/logo-blue.svg";
const BRAND_NAVY = "#0E2848";
/** 卡片底部那句话：匿名 + 善意。短，不说教。 */
export const FOOTER_LINE = "反馈完全匿名，你的善意会帮助老师变得更好";

/**
 * 二维码直接编码带预填的飞书表单链接，扫码零中转。
 * 答卷已按姓名匹配回任务，中间那一跳（/t/<token> → 302）没有任何作用，
 * 只剩冷启动延迟和腾讯默认域名的拦截页。旧端点保留，已印出去的码不失效。
 */
export function taskFormUrl(task: Pick<StoredFeedbackTask, "studentName" | "teacherCanonicalName">): string {
  return buildPrefilledFormUrl({
    baseUrl: feishuFormUrl(),
    teacherName: task.teacherCanonicalName,
    studentName: task.studentName,
  });
}

/**
 * 用 `scale`（每个模块整数像素）而不是 `width`。
 * `width` 会把二维码缩放到指定像素，模块边缘出现抗锯齿灰边，颜色数从 2 涨到上千，
 * PNG 直接压不动——实测单张 67 KB，换成整数 scale 后降到约 10 KB。
 * 代价是最终像素随链接长度（二维码版本）浮动，所以画的时候按自然尺寸居中。
 */
export async function taskQrDataUrl(
  task: Pick<StoredFeedbackTask, "studentName" | "teacherCanonicalName">,
  scale = 6,
): Promise<string> {
  return QRCode.toDataURL(taskFormUrl(task), {
    errorCorrectionLevel: "M",
    margin: 2,
    scale,
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

/**
 * 二维码卡片，自上而下：老师名（最大）→ 课程 → 学生 → 二维码 → 匿名提示 → 品牌。
 * 老师名做主角：学生一次会收到好几张，在聊天记录缩略图里就得认出评的是谁。
 */
export async function renderQrCard(task: StoredFeedbackTask): Promise<Blob> {
  const [qrDataUrl, logo] = await Promise.all([taskQrDataUrl(task), brandLogo()]);
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
  context.font = `700 72px ${SANS}`;
  context.fillText(fitText(context, `${task.teacherCanonicalName}老师`, maxTextW), centerX, cardY + 150);

  context.fillStyle = "#3f3f46";
  context.font = `500 36px ${SANS}`;
  context.fillText(fitText(context, task.courseNames.join(" · "), maxTextW), centerX, cardY + 219);

  context.fillStyle = "#71717a";
  context.font = `400 27px ${SANS}`;
  context.fillText(fitText(context, `学生：${task.studentName}`, maxTextW), centerX, cardY + 279);

  // 二维码在一个固定的 420px 方框里居中：自然尺寸随版本在 390–420 之间浮动，
  // 固定框保证下面那两行文字的位置不跟着抖。不缩放，保持模块是纯黑白。
  const qrBox = 420;
  const qrPx = Math.min(qrImage.naturalWidth, qrBox);
  const qrTop = cardY + 322 + (qrBox - qrPx) / 2;
  context.imageSmoothingEnabled = false;
  context.drawImage(qrImage, centerX - qrPx / 2, qrTop, qrPx, qrPx);
  context.imageSmoothingEnabled = true;

  context.fillStyle = "#71717a";
  context.font = `400 20px ${SANS}`;
  context.fillText(FOOTER_LINE, centerX, cardY + 780);

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

export function cardFileName(task: StoredFeedbackTask): string {
  return `${safeName(task.teacherCanonicalName)}-${safeName(task.studentName)}-${task.courseMonth}.png`;
}

/** ZIP 里按学生分文件夹：一个学生一个目录，教务直接把整个文件夹发给家长。 */
export function cardZipPath(task: StoredFeedbackTask): string {
  return `${safeName(task.studentName)}/${safeName(task.teacherCanonicalName)}-${task.courseMonth}.png`;
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
 * ponytail: 每月约 260 张，前端串行几秒钟就够，不值得为它开云存储 + Worker。
 */
export async function downloadQrZip(
  tasks: StoredFeedbackTask[],
  onProgress: (progress: BatchProgress) => void,
  signal?: AbortSignal,
): Promise<BatchProgress> {
  const zip = new JSZip();
  const progress: BatchProgress = { phase: "rendering", done: 0, total: tasks.length, zipPercent: 0, failed: [] };
  const report = () => onProgress({ ...progress, failed: [...progress.failed] });
  report();

  for (const task of tasks) {
    if (signal?.aborted) {
      progress.phase = "cancelled";
      report();
      return progress;
    }
    try {
      zip.file(cardZipPath(task), await renderQrCard(task));
    } catch (error) {
      progress.failed.push({
        taskId: task.taskId,
        label: `${task.studentName} × ${task.teacherCanonicalName}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    progress.done += 1;
    report();
    await yieldToBrowser();
  }

  if (progress.failed.length > 0) {
    const rows = progress.failed.map((item) => `${item.taskId},${item.label},${item.reason}`);
    zip.file("生成失败清单.csv", `﻿任务ID,学生 × 老师,失败原因\r\n${rows.join("\r\n")}\r\n`);
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

  const fileName = `课程反馈二维码-${tasks[0]?.collectionMonth ?? ""}.zip`;
  downloadBlob(blob, fileName);
  progress.phase = "done";
  progress.zipPercent = 100;
  progress.fileName = fileName;
  progress.sizeBytes = blob.size;
  report();
  return progress;
}
