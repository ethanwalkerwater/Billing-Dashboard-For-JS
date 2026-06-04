// 把 data/teachers.json 渲染成师资卡（授课老师 / 更多老师），注入 outputs/parent_reports/模板.html。
// 维护流程：改 老师卡片.txt / 头像 → 本流程（npm run build:faculty）会先解析再注入。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFacultyByRole } from "../src/render-faculty.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const DATA = path.resolve(APP_ROOT, "data/teachers.json");
const TPL = path.resolve(REPO_ROOT, "outputs/parent_reports/模板.html");

// 模板示例学生（Ivy）的授课老师；批量生成时由各学生的实际课程决定。
const TEACHING = ["应雁心", "李品轩"];

const { teachers } = JSON.parse(fs.readFileSync(DATA, "utf8"));
// 模板在 outputs/parent_reports/ → 头像相对路径回到 apps/parent-report/assets/teacher/
const photoBase = "../../apps/parent-report/assets/teacher/";
const sections = renderFacultyByRole(teachers, TEACHING, { photoBase });

let html = fs.readFileSync(TPL, "utf8");
const re = /(<h2>师资团队<\/h2>[\s\S]*?<\/header>)[\s\S]*?(\n\s*<\/section>\s*\n\s*<section class="page closing")/;
if (!re.test(html)) throw new Error("未定位到师资页区块，请检查模板结构");
html = html.replace(re, (_m, head, tail) => `${head}\n${sections}\n${tail}`);

fs.writeFileSync(TPL, html, "utf8");
console.log(`注入师资页：授课老师 ${TEACHING.length} 位 + 更多老师 ${teachers.length - TEACHING.length} 位 → ${path.relative(REPO_ROOT, TPL)}`);
