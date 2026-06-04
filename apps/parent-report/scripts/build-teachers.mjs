// 解析 assets/teacher/老师卡片.txt（+ 头像）→ data/teachers.json
// 你只维护「老师卡片.txt」和头像图片。改完运行：
//   npm run build:faculty -w @jingshi/parent-report   （会顺带把模板师资页也更新）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const TEACHER_DIR = path.resolve(APP_ROOT, "assets/teacher");
const SRC = path.resolve(TEACHER_DIR, "老师卡片.txt");
const OUT = path.resolve(APP_ROOT, "data/teachers.json");

const SUBJECT_ORDER = ["数学", "物理", "化学", "经济", "英语"];
const FIELD = { 姓名: "name", 学科: "subject", 头像: "photo", 标签: "tag", 简介: "desc", 学习提升: "improve", 责任心: "responsibility", 个人魅力: "charisma" };

const photoFiles = fs.readdirSync(TEACHER_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));

const raw = fs.readFileSync(SRC, "utf8");
const blocks = raw.split(/^---\s*$/m)
  .map((b) => b.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").trim())
  .filter(Boolean);

const score = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n.toFixed(1) : null; };

const teachers = [];
for (const block of blocks) {
  const o = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!m) continue;
    const key = FIELD[m[1].trim()];
    if (key) o[key] = m[2].trim();
  }
  if (!o.name) continue;
  let photo = o.photo;
  if (!photo) photo = photoFiles.find((f) => f.replace(/\.[^.]+$/, "") === `${o.subject}-${o.name}`);
  if (!photo) photo = photoFiles.find((f) => f.includes(o.name)); // 兜底按姓名
  teachers.push({
    name: o.name,
    subject: o.subject || "",
    photo: photo || null,
    tag: o.tag || o.subject || "",
    desc: o.desc || "",
    scores: { 学习提升: score(o.improve), 责任心: score(o.responsibility), 个人魅力: score(o.charisma) },
  });
}

teachers.sort((a, b) => {
  const sa = SUBJECT_ORDER.indexOf(a.subject), sb = SUBJECT_ORDER.indexOf(b.subject);
  if (sa !== sb) return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb);
  return a.name.localeCompare(b.name, "zh");
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), teachers }, null, 2), "utf8");

const noPhoto = teachers.filter((t) => !t.photo).map((t) => t.name);
const noScore = teachers.filter((t) => !t.scores.学习提升).length;
console.log(`解析 ${teachers.length} 位老师 → ${path.relative(APP_ROOT, OUT)}`);
if (noPhoto.length) console.warn("⚠ 未匹配到头像:", noPhoto.join(", "));
if (noScore) console.log(`ℹ ${noScore} 位老师暂无评分（卡片显示“—”，填入后重新运行即可）`);
