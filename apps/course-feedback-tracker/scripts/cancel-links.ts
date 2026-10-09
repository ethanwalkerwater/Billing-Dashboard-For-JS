/**
 * 为课表里的学生生成「取消课程」专属链接（已有有效链接的学生沿用原链接）。
 *
 *   npm run cancel-links                      # 课表里所有学生
 *   npm run cancel-links -- --students 张三,李四  # 只生成这几位（按学生名匹配）
 *   npm run cancel-links -- --revoke 张三        # 停用张三的旧链接并重新生成
 *
 * 读 cancel.env（课表、学员信息表、飞书应用）和 server.env（数据库），结果写到仓库根目录
 * outputs/lesson-cancellation/cancel-links.csv，由教务发给学生或家长。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceDb } from "../functions/feedback-api/service-db";
import { FeishuClient } from "../src/server/feishu/client";
import { CANCEL_LINKS_TABLE } from "../src/server/cancellation/store";

const PAGE_ORIGIN = "https://app.jsjy.asia/cancel/";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv(file: string): Record<string, string> {
  const path = resolve(root, file);
  if (!existsSync(path)) throw new Error(`找不到 ${path}`);
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

function argList(flag: string): string[] {
  const index = process.argv.indexOf(flag);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1].split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
}

const cancel = readEnv("cancel.env");
const server = readEnv("server.env");
const client = new FeishuClient({ appId: cancel.FEISHU_APP_ID, appSecret: cancel.FEISHU_APP_SECRET });
const db = createServiceDb({ envId: server.CLOUDBASE_ENV_ID, apiKey: server.CLOUDBASE_API_KEY });

// 学生直接取学员信息表：记录 ID 就是课表「学生」关联里的 ID
const studentRecords = await client.searchRecords({
  appToken: cancel.CANCEL_SCHEDULE_APP_TOKEN,
  tableId: cancel.CANCEL_STUDENT_TABLE_ID,
  fieldNames: ["学生姓名", "在读"],
  filter: { conjunction: "and", conditions: [] },
});
const plain = (value: unknown): string =>
  Array.isArray(value) ? value.map(plain).join("") : value && typeof value === "object" ? String((value as { text?: string }).text ?? "") : String(value ?? "");
const students = new Map<string, string>();
for (const record of studentRecords) {
  const name = plain(record.fields["学生姓名"]).trim();
  // 默认只给在读学生生成；指定 --students 时不看在读状态
  if (name && (plain(record.fields["在读"]) !== "毕业" || argList("--students").length)) students.set(record.record_id, name);
}

const only = argList("--students");
const revoke = new Set(argList("--revoke"));
const targets = [...students].filter(([, name]) => !only.length || only.includes(name) || revoke.has(name));
if (!targets.length) throw new Error("课表里没有匹配的学生");

const existing = await db.from(CANCEL_LINKS_TABLE).select<{ token: string; student_key: string }>("token,student_key").eq("active", true);
if (existing.error) throw new Error(`读取已有链接失败：${existing.error.message}`);
const activeByStudent = new Map((existing.data ?? []).map((row) => [row.student_key, row.token]));

const rows: Array<[string, string]> = [];
for (const [key, name] of targets) {
  let token = activeByStudent.get(key);
  if (token && revoke.has(name)) {
    const result = await db.from(CANCEL_LINKS_TABLE).update({ active: false }).eq("token", token);
    if (result.error) throw new Error(`停用 ${name} 的旧链接失败：${result.error.message}`);
    token = undefined;
  }
  if (!token) {
    token = randomBytes(12).toString("base64url");
    const result = await db.from(CANCEL_LINKS_TABLE).insert([{ token, student_key: key, student_name: name }]);
    if (result.error) throw new Error(`保存 ${name} 的链接失败：${result.error.message}`);
  }
  rows.push([name, `${PAGE_ORIGIN}?t=${token}`]);
}

const outDir = resolve(root, "../../outputs/lesson-cancellation");
mkdirSync(outDir, { recursive: true });
const csv = ["学生,取消课程链接", ...rows.sort((a, b) => a[0].localeCompare(b[0], "zh-CN")).map(([name, url]) => `"${name.replace(/"/g, '""')}",${url}`)].join("\n");
writeFileSync(resolve(outDir, "cancel-links.csv"), `﻿${csv}\n`);
console.log(`已生成 ${rows.length} 位学生的取消链接 → outputs/lesson-cancellation/cancel-links.csv`);
