import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import QRCode from "qrcode";

import { createServiceDb } from "../../functions/feedback-api/service-db";
import { buildPrefilledFormUrl } from "../../src/domain/form-url";
import { TASKS_TABLE } from "../../src/shared/rdb";

const [student, courseMonth, host] = process.argv.slice(2);
if (!student || !/^\d{4}-(0[1-9]|1[0-2])$/.test(courseMonth) || isIP(host) !== 4) {
  throw new Error("用法：serve-pilot.ts 学生姓名 YYYY-MM 本机局域网IPv4");
}

const { VITE_CLOUDBASE_ENV_ID: envId, VITE_FEISHU_FORM_URL: formUrl, CLOUDBASE_API_KEY: apiKey } = process.env;
if (!envId || !formUrl || !apiKey) throw new Error("缺少反馈应用环境配置");

const db = createServiceDb({
  envId,
  apiKey,
  fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(12_000) }),
});
const { data, error } = await db
  .from(TASKS_TABLE)
  .select("student_record_id,teacher_canonical_name,course_names,student_response_id,status")
  .eq("student_name", student)
  .eq("course_month", courseMonth)
  .order("teacher_canonical_name");

if (error) throw new Error("读取任务失败（HTTP " + error.code + "）");
const rows = (data ?? []).filter((row) => row.status !== "declined");
if (rows.length === 0 || new Set(rows.map((row) => row.student_record_id)).size !== 1) {
  throw new Error("试点需要匹配到唯一学生，且至少有一份反馈任务");
}

const pilot = {
  student,
  courseMonth,
  teachers: rows.map((row, index) => ({
    id: String(index),
    name: row.teacher_canonical_name,
    courses: (row.course_names ?? []).join("、"),
    submitted: Boolean(row.student_response_id),
    formUrl: buildPrefilledFormUrl({ baseUrl: formUrl, studentName: student, teacherName: row.teacher_canonical_name, courseMonth }),
  })),
};

const template = await readFile(new URL("./index.html", import.meta.url), "utf8");
const page = template.replace('type="application/json">null', () => 'type="application/json">' + JSON.stringify(pilot).replace(/</g, "\\u003c"));
const token = process.env.FEEDBACK_PILOT_TOKEN ?? randomBytes(24).toString("base64url");
if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error("无效的试点链接凭证");
const route = "/p/" + token;
const port = 4194;
const link = `http://${host}:${port}${route}`;
const output = resolve("outputs/student-feedback-pilot");
const qrPath = resolve(output, "mobile-qr.png");
await mkdir(output, { recursive: true, mode: 0o700 });
const png = await QRCode.toBuffer(link, { width: 256, margin: 3 });

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (request.method !== "GET" || request.url?.split("?")[0] !== route) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, host, resolveListen);
});
try {
  await writeFile(qrPath, png, { mode: 0o600 });
} catch (error) {
  server.close();
  throw error;
}
console.log(link);
console.log(qrPath);
console.log(`实际任务 ${pilot.teachers.length} 份，已提交 ${pilot.teachers.filter((teacher) => teacher.submitted).length} 份。局域网入口有效 12 小时。`);
setTimeout(() => server.close(), 12 * 60 * 60 * 1000).unref();
