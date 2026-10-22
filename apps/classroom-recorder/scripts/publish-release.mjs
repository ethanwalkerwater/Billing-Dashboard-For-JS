#!/usr/bin/env node
/**
 * 把 GitHub Actions 打好的安装包发布给老师（自动更新的「上线开关」）。
 *
 *   node apps/classroom-recorder/scripts/publish-release.mjs classroom-v0.1.3
 *
 * 1. 找到这个 tag 触发的 Actions 构建，下载 Mac / Windows 安装包和更新包（含签名）；
 * 2. 改成英文文件名，传到 CloudBase 静态托管 https://app.jsjy.asia/downloads/classroom/<版本>/（国内 CDN，老师下载快）；
 * 3. 首次安装用的固定链接也更新：jingshi-classroom-mac.dmg / jingshi-classroom-windows-setup.exe；
 * 4. 最后才传 latest.json —— 传完这一步，老师的 App 在一小时内（空闲时）自动更新；
 * 5. 在 GitHub 建一个 Release 留档（附同样的文件）。
 *
 * 需要本机 gh 登录的是仓库管理员账号（ethanwalkerwater），以及 tcb login。CloudBase 密钥不进 GitHub。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "ethanwalkerwater/Billing-Dashboard-For-JS";
const ENV = "jingshi-test-d5gp401i44a0fa7a7";
const BASE = "https://app.jsjy.asia/downloads/classroom";

const tag = process.argv[2];
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const version = tag?.replace(/^classroom-v/, "");
if (!tag?.startsWith("classroom-v")) throw new Error(`用法：publish-release.mjs classroom-v${conf.version}`);

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();

// ---- 1. 下载这个 tag 的构建产物 ----
const runs = JSON.parse(run("gh", ["run", "list", "-R", REPO, "--workflow", "classroom-recorder-release.yml", "--branch", tag, "--json", "databaseId,status,conclusion", "--limit", "5"]));
const ok = runs.find((r) => r.conclusion === "success");
if (!ok) throw new Error(`${tag} 还没有成功的构建：${JSON.stringify(runs)}`);
const dir = mkdtempSync(join(tmpdir(), "classroom-release-"));
run("gh", ["run", "download", String(ok.databaseId), "-R", REPO, "-D", dir]);
const all = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? all(join(d, f)) : [join(d, f)]));
const files = all(dir);
const find = (suffix) => {
  const hit = files.filter((f) => f.endsWith(suffix));
  if (hit.length !== 1) throw new Error(`构建产物里应有 1 个 *${suffix}，实际 ${hit.length} 个`);
  return hit[0];
};

// ---- 2. 改英文名，拼 latest.json ----
const out = join(dir, "out", version);
mkdirSync(out, { recursive: true });
const pick = { "classroom-mac.app.tar.gz": ".app.tar.gz", "classroom-windows-setup.exe": "-setup.exe", "classroom-mac.dmg": ".dmg" };
for (const [name, suffix] of Object.entries(pick)) copyFileSync(find(suffix), join(out, name));
if (!find("-setup.exe").includes(`_${version}_`)) throw new Error(`安装包版本和 ${version} 对不上：${find("-setup.exe")}，检查 tauri.conf.json`);
const sig = (suffix) => readFileSync(find(`${suffix}.sig`), "utf8").trim();
const mac = { signature: sig(".app.tar.gz"), url: `${BASE}/${version}/classroom-mac.app.tar.gz` };
const latest = {
  version,
  notes: `菁仕课堂 ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": mac,
    "darwin-x86_64": mac, // 通用版，一个包两种芯片都能用
    "windows-x86_64": { signature: sig("-setup.exe"), url: `${BASE}/${version}/classroom-windows-setup.exe` },
  },
};
writeFileSync(join(out, "latest.json"), JSON.stringify(latest, null, 2)); // 每个版本留一份，回滚时重传它

// ---- 3–4. 传 CloudBase，latest.json 最后传 ----
const deploy = (local, remote) => run("tcb", ["hosting", "deploy", local, remote, "-e", ENV]);
deploy(out, `downloads/classroom/${version}`);
deploy(join(out, "classroom-mac.dmg"), "downloads/classroom/jingshi-classroom-mac.dmg");
deploy(join(out, "classroom-windows-setup.exe"), "downloads/classroom/jingshi-classroom-windows-setup.exe");
deploy(join(out, "latest.json"), "downloads/classroom/latest.json");

// ---- 5. GitHub Release 留档 ----
const assets = readdirSync(out).map((f) => join(out, f));
run("gh", ["release", "create", tag, ...assets, "-R", REPO, "--title", `菁仕课堂 ${version}`, "--notes", "老师端录课 App（macOS 通用版 / Windows）。国内下载与自动更新走 app.jsjy.asia。"]);

const online = await (await fetch(`${BASE}/latest.json?t=${Date.now()}`)).json().catch(() => null);
console.log(`\n已发布 ${version}（线上 latest.json：${online?.version ?? "暂未读到，CDN 可能有几分钟缓存"}）。老师的 App 空闲时一小时内自动更新。`);
console.log(`首次安装：${BASE}/jingshi-classroom-mac.dmg  ${BASE}/jingshi-classroom-windows-setup.exe`);
