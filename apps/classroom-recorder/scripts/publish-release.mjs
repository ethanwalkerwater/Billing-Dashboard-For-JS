#!/usr/bin/env node
/**
 * 把 GitHub Actions 打好的草稿版本发布给老师（自动更新的「上线开关」）。
 *
 *   node apps/classroom-recorder/scripts/publish-release.mjs classroom-v0.1.1
 *
 * 1. gh 下载草稿 Release 里的安装包、更新包和 latest.json；
 * 2. 改成英文文件名，传到 CloudBase 静态托管 https://app.jsjy.asia/downloads/classroom/<版本>/（国内 CDN，老师下载快）；
 * 3. 首次安装用的固定链接也更新：jingshi-classroom-mac.dmg / jingshi-classroom-windows-setup.exe；
 * 4. 最后才传 latest.json —— 传完这一步，老师的 App 在一小时内会自动更新；
 * 5. 把 GitHub 草稿转成正式 Release（留档）。
 *
 * 需要本机已登录 gh（对仓库有写权限的账号）和 tcb。CloudBase 密钥不进 GitHub。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "ethanwalkerwater/Billing-Dashboard-For-JS";
const ENV = "jingshi-test-d5gp401i44a0fa7a7";
const BASE = "https://app.jsjy.asia/downloads/classroom";

const tag = process.argv[2];
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
if (tag !== `classroom-v${conf.version}`) throw new Error(`用法：publish-release.mjs classroom-v${conf.version}（tauri.conf.json 里的版本）`);
const version = conf.version;

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const dir = mkdtempSync(join(tmpdir(), "classroom-release-"));
run("gh", ["release", "download", tag, "-R", REPO, "-D", dir, "--clobber"]);
const files = readdirSync(dir);
console.log("下载：", files.join("  "));

// 原文件名带中文和版本号，换成固定的英文名，URL 里不用转义
const RENAME = [
  [/\.app\.tar\.gz$/, "classroom-mac.app.tar.gz"],
  [/x64-setup\.exe$/, "classroom-windows-setup.exe"],
  [/\.dmg$/, "classroom-mac.dmg"],
];
const out = join(dir, "out", version);
mkdirSync(out, { recursive: true });
const renamed = new Map();
for (const file of files) {
  const hit = RENAME.find(([pattern]) => pattern.test(file));
  if (!hit) continue;
  copyFileSync(join(dir, file), join(out, hit[1]));
  renamed.set(file, hit[1]);
}
for (const need of ["classroom-mac.app.tar.gz", "classroom-windows-setup.exe", "classroom-mac.dmg"]) {
  if (![...renamed.values()].includes(need)) throw new Error(`Release 里缺少 ${need} 对应的文件，CI 可能有一端没打包成功`);
}

const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
if (latest.version.replace(/^v/, "") !== version) throw new Error(`latest.json 版本 ${latest.version} 和 ${version} 对不上`);
for (const [platform, entry] of Object.entries(latest.platforms)) {
  const name = renamed.get(decodeURIComponent(entry.url.split("/").pop()));
  if (!name) throw new Error(`${platform} 的更新包 ${entry.url} 没找到`);
  if (!entry.signature) throw new Error(`${platform} 没有签名，检查 TAURI_SIGNING_PRIVATE_KEY`);
  entry.url = `${BASE}/${version}/${name}`;
}
const latestPath = join(dir, "out", "latest.json");
writeFileSync(latestPath, JSON.stringify(latest, null, 2));
copyFileSync(latestPath, join(out, "latest.json")); // 每个版本留一份，回滚时重传它
console.log("平台：", Object.keys(latest.platforms).join("  "));

const deploy = (local, remote) => run("tcb", ["hosting", "deploy", local, remote, "-e", ENV]);
deploy(out, `downloads/classroom/${version}`);
deploy(join(out, "classroom-mac.dmg"), "downloads/classroom/jingshi-classroom-mac.dmg");
deploy(join(out, "classroom-windows-setup.exe"), "downloads/classroom/jingshi-classroom-windows-setup.exe");
deploy(latestPath, "downloads/classroom/latest.json"); // 上线开关，必须最后传

run("gh", ["release", "edit", tag, "-R", REPO, "--draft=false", "--latest"]);
console.log(`\n已发布 ${version}。老师的 App 空闲时一小时内自动更新。`);
console.log(`首次安装：${BASE}/jingshi-classroom-mac.dmg  ${BASE}/jingshi-classroom-windows-setup.exe`);
