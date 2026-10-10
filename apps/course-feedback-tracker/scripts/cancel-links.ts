/**
 * 为学员信息表里的在读学生生成「取消课程」专属链接（已有有效链接的学生沿用原链接）。
 * 日常由教务在工作台「取消课程」页点「为新学生生成链接」完成，这个脚本用于批量初始化或重发。
 *
 *   npm run cancel-links                        # 所有在读学生
 *   npm run cancel-links -- --students 张三,李四  # 只处理这几位（不看在读状态）
 *   npm run cancel-links -- --revoke 张三         # 停用张三的旧链接并重新生成
 *
 * 读 cancel.env（课表所在多维表格、学员信息表、飞书应用）和 server.env（数据库），
 * 名单导出到仓库根目录 outputs/lesson-cancellation/cancel-links.csv。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServiceDb } from "../functions/feedback-api/service-db";
import { cancelLinkUrl } from "../src/cancellation/links";
import { ensureLinks, listStudents } from "../src/server/cancellation/links";
import { CANCEL_LINKS_TABLE } from "../src/server/cancellation/store";
import { FeishuClient } from "../src/server/feishu/client";

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

const only = argList("--students");
const revoke = argList("--revoke");
const all = await listStudents(client, {
  appToken: cancel.CANCEL_SCHEDULE_APP_TOKEN,
  studentTableId: cancel.CANCEL_STUDENT_TABLE_ID,
  includeGraduated: only.length > 0 || revoke.length > 0,
});
const wanted = [...only, ...revoke];
const students = new Map([...all].filter(([, name]) => !wanted.length || wanted.includes(name)));
if (!students.size) throw new Error("学员信息表里没有匹配的学生");

const revokeKeys = new Set([...students].filter(([, name]) => revoke.includes(name)).map(([key]) => key));
const result = await ensureLinks(db, students, { revokeKeys });

const links = await db.from(CANCEL_LINKS_TABLE).select<{ token: string; student_key: string; student_name: string }>("token,student_key,student_name").eq("active", true);
if (links.error) throw new Error(links.error.message);
const rows = (links.data ?? []).filter((row) => students.has(row.student_key)).sort((a, b) => a.student_name.localeCompare(b.student_name, "zh-CN"));
const outDir = resolve(root, "../../outputs/lesson-cancellation");
mkdirSync(outDir, { recursive: true });
const csv = ["学生,取消课程链接", ...rows.map((row) => `"${row.student_name.replace(/"/g, '""')}",${cancelLinkUrl(row.token)}`)].join("\n");
writeFileSync(resolve(outDir, "cancel-links.csv"), `﻿${csv}\n`);
console.log(`新生成 ${result.created.length} 个，沿用 ${result.existing} 个 → outputs/lesson-cancellation/cancel-links.csv`);
