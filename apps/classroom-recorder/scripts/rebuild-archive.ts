/**
 * 课堂时间档案上线：按新流程重出已完成课程的学情报告（家长总结已经发给家长，不动）。本地直接调云函数的 rebuild，读 server.env。
 *
 *   npx tsx scripts/rebuild-archive.ts [rec… …]            试跑：用新版提示词生成，不写库；结果和预览网页放 outputs/classroom-rebuild/。不给编号 = 全部
 *   npx tsx scripts/rebuild-archive.ts --pages             不调模型，只用已有结果重出预览网页（改了报告网页之后）
 *   npx tsx scripts/rebuild-archive.ts --publish-prompts   发布新版提示词：「学情报告」去掉 homework / next / timeline（改由程序填）
 *   npx tsx scripts/rebuild-archive.ts --write [rec… …]    把试跑看过的那份结果原样写库（不再调模型）；老师在网页上改过的报告跳过
 *
 * 只处理 10 分钟以上、有转写的课；会议不处理。上线顺序：迁移 → 部署云函数和网页 → 发布提示词 → --write。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Prompts } from "../src/server/logic";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(resolve(root, "server.env"), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trim().startsWith("#")) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
}
const { main } = await import("../functions/classroom-api/index");

const args = process.argv.slice(2);
const ids = args.filter((a) => /^(rec[A-Za-z0-9]+|adhoc-[0-9a-f]{16})$/.test(a));
const db = async (path: string, init?: RequestInit) => {
  const res = await fetch(`https://${process.env.CLOUDBASE_ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest/${path}`, {
    ...init, headers: { authorization: `Bearer ${process.env.CLOUDBASE_API_KEY}`, "content-type": "application/json", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`数据库 ${path} 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
};

/** 新版「学情报告」提示词：作业、下节课、时间轴改由程序按档案填，这三行删掉，复习方法单独一行 */
const v5 = (p: Prompts): Prompts => ({
  ...p,
  report: p.report.split("\n")
    .filter((line) => !/^- (next|timeline)：/.test(line))
    .map((line) => (/^- homework：/.test(line) ? "- review：复习方法，1–2 句" : line))
    .join("\n"),
});
const [live] = await db("classroom_prompts?select=version,rules,parent,report,meeting&order=version.desc&limit=1") as Array<Prompts & { version: number }>;

if (args.includes("--publish-prompts")) {
  const next = v5(live);
  if (next.report === live.report) {
    console.log(`线上 v${live.version} 已是新版，不用发布`);
  } else {
    await db("classroom_prompts", { method: "POST", body: JSON.stringify([{ ...next, version: live.version + 1, createdAt: Date.now(), createdBy: "课堂时间档案上线" }]) });
    console.log(`已发布提示词 v${live.version + 1}：\n${next.report}`);
  }
  process.exit(0);
}

const out = resolve(root, "../../outputs/classroom-rebuild");
const results = () => readdirSync(out).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(resolve(out, f), "utf8")));

if (args.includes("--write")) {
  for (const { row, archive, reportData } of results().filter((x) => x.ok && (!ids.length || ids.includes(x.row._id)))) {
    const [doc] = await db(`classroom_lessons?_id=eq.${row._id}&select=stage,rawReport`);
    if (doc?.stage !== "done" || doc.rawReport != null) {
      console.log(`${row._id} ${row.student} 跳过：${doc?.rawReport != null ? "老师改过报告" : "不是已完成"}`);
      continue;
    }
    await db(`classroom_lessons?_id=eq.${row._id}`, { method: "PATCH", body: JSON.stringify({ report: reportData.report, archive, promptVersion: live.version, updatedAt: Date.now() }) });
    console.log(`${row._id} ${row.student} 已写库`);
  }
  process.exit(0);
}

const rows = await db(`classroom_lessons?select=_id,student,course,reportToken,startAt&stage=eq.done&kind=neq.meeting&audioSec=gte.600&order=startAt.desc${ids.length ? `&_id=in.(${ids.join(",")})` : ""}`) as Array<{ _id: string; student: string; course: string; reportToken: string; startAt: number }>;
mkdirSync(out, { recursive: true });
console.log(`试跑 ${rows.length} 节课`);

for (let i = 0; i < (args.includes("--pages") ? 0 : rows.length); i += 3) { // 3 节一起跑，每节 3–4 次模型调用
  await Promise.all(rows.slice(i, i + 3).map(async (row) => {
    const t0 = Date.now();
    const result = await main({ action: "rebuild", lessonId: row._id, prompts: v5(live) }).catch((error: Error) => ({ ok: false, error: error.message })) as any;
    writeFileSync(resolve(out, `${row._id}.json`), JSON.stringify({ row, ...result }, null, 2));
    const r = result.reportData?.report;
    console.log(`${row._id} ${row.student} ${result.ok ? `✓ ${Math.round((Date.now() - t0) / 1000)}s ${r.chapters.length} 章 · ${result.reportData.clock?.total} 分钟${result.reportData.clock?.full ? "" : "（闲聊多，只算学习时间）"}` : `✗ ${result.error}`}`);
  }));
}

// 预览网页：线上报告网页的同一份代码（JS、CSS 内联，双击就能开），数据塞进 localStorage 走它的 #preview 模式
const dist = resolve(root, "dist-report");
if (!existsSync(resolve(dist, "report.html"))) throw new Error("先 npm run build:report");
const asset = (name: string) => readFileSync(resolve(dist, name), "utf8");
const shell = asset("report.html")
  .replace(/<link rel="modulepreload"[^>]*>\n?/, "")
  .replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/, (_, js) => `<script type="module">${asset(js).replace(/^import"[^"]+";/, "")}</script>`)
  .replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/, (_, css) => `<style>${asset(css)}</style>`);
// 对比页列出目录里所有跑过的课（只重跑几节时，之前的结果还在）
const all = results();
for (const { row, ...result } of all.filter((x) => x.ok)) {
  const data = JSON.stringify(result.reportData).replace(/</g, "\\u003c");
  writeFileSync(resolve(out, `${row._id}.html`), shell.replace("<head>", () => `<head>\n<script>localStorage.setItem("classroom-preview:${row._id}", ${JSON.stringify(data)});if(!location.hash)location.hash="preview=${row._id}"</script>`));
}
const online = process.env.REPORT_BASE_URL;
writeFileSync(resolve(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>课堂时间档案 · 重出报告对比</title>
<style>body{font:15px/1.8 -apple-system,"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 16px}td{padding:6px 12px 6px 0;border-bottom:1px solid #eee}</style>
<h1>重出报告对比</h1><table>${all.sort((a, b) => b.row.startAt - a.row.startAt).map(({ row, ...result }) => `<tr><td>${new Date(row.startAt + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ")}</td><td>${row.student || row.course}</td>
<td>${result.ok ? `<a href="${row._id}.html#preview=${row._id}">新报告</a>` : `失败：${result.error}`}</td><td><a href="${online}?t=${row.reportToken}">线上旧报告</a></td></tr>`).join("")}</table>`);
console.log(`\n对比页：${resolve(out, "index.html")}`);
