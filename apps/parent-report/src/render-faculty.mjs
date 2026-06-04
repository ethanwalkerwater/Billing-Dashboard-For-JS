// 师资卡渲染（模板与批量报告共用）。卡片结构：头像 + 姓名 + 标签 + 简介 + 底部3评分。
// 数据来自 data/teachers.json（由 scripts/build-teachers.mjs 解析 老师卡片.txt 生成）。
//
// 图片两种模式：
//   1) 路径引用（默认）：opts.photoBase = URL 前缀，文件小、便于维护（模板用）。
//   2) base64 内嵌：opts.embed = true + opts.photoDir = 头像文件夹绝对路径，
//      生成自包含单文件 HTML（批量发给家长用）。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const _cache = new Map();

function optimizePhotoBuffer(inputPath) {
  const result = spawnSync("magick", [
    inputPath,
    "-auto-orient",
    "-resize", "360x360>",
    "-background", "white",
    "-alpha", "remove",
    "-alpha", "off",
    "-strip",
    "-quality", "82",
    "jpeg:-",
  ]);

  if (result.status !== 0 || !result.stdout?.length) {
    return null;
  }
  return result.stdout;
}

function embedPhoto(dir, file, { optimize = false } = {}) {
  const inputPath = path.join(dir, file);
  const key = JSON.stringify([inputPath, optimize]);
  if (_cache.has(key)) return _cache.get(key);

  const optimized = optimize ? optimizePhotoBuffer(inputPath) : null;
  const buf = optimized || fs.readFileSync(inputPath);
  const mime = optimized ? "image/jpeg" : MIME[path.extname(file).toLowerCase()] || "image/png";
  const uri = `data:${mime};base64,${buf.toString("base64")}`;
  _cache.set(key, uri);
  return uri;
}

const METRIC_KEYS = ["学习提升", "责任心", "个人魅力"];

export function renderFacultyCard(t, {
  photoBase = "",
  embed = false,
  photoDir = "",
  optimizeEmbeddedPhotos = false,
} = {}) {
  const src = !t.photo ? ""
    : embed && photoDir ? embedPhoto(photoDir, t.photo, { optimize: optimizeEmbeddedPhotos })
    : photoBase + encodeURIComponent(t.photo);
  const metrics = METRIC_KEYS.map((k) => {
    const v = t.scores && t.scores[k] ? t.scores[k] : "—";
    return `            <div class="faculty-metric"><span class="faculty-metric-label">${k}</span><strong class="faculty-metric-value">${esc(v)}</strong></div>`;
  }).join("\n");
  return `      <article class="faculty-card">
        <div class="portrait-crop faculty-photo">${src ? `<img src="${src}" alt="${esc(t.name)}" />` : ""}</div>
        <div class="faculty-panel">
          <div class="faculty-head"><h3>${esc(t.name)}</h3><span class="faculty-tag">${esc(t.tag)}</span></div>
          <p class="faculty-desc">${esc(t.desc)}</p>
          <div class="faculty-metrics">
${metrics}
          </div>
        </div>
      </article>`;
}

// 渲染一个 faculty-section（标题 + 卡片网格）。
export function renderFacultySection(title, list, opts = {}) {
  if (!list.length) return "";
  return `      <section class="faculty-section">
        <h3>${esc(title)}</h3>
        <div class="faculty-grid">
${list.map((t) => renderFacultyCard(t, opts)).join("\n")}
        </div>
      </section>`;
}

// 模板/报告用：按「授课老师 / 更多老师」分类渲染。
// teachingNames = 该学生的授课老师姓名数组；其余归入「更多老师」。
export function renderFacultyByRole(teachers, teachingNames = [], opts = {}) {
  const set = new Set(teachingNames);
  const teaching = teachers.filter((t) => set.has(t.name));
  const more = teachers.filter((t) => !set.has(t.name));
  return [
    renderFacultySection("授课老师", teaching, opts),
    renderFacultySection("更多老师", more, opts),
  ].filter(Boolean).join("\n");
}
