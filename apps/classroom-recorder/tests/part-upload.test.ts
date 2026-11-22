/**
 * 0.1.14 起 App 上课时每 5 分钟直传一块：签名不查库（第一块除外），云端整节到齐才拼起来转写，缺块等 2 小时后用已到的出报告并通知管理员。
 * 函数里的 fetch 全部换成假的，没认出来的请求直接报错。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { asr } from "tencentcloud-sdk-nodejs-asr";

import * as L from "../src/server/logic";
import { issueSession } from "../functions/classroom-api/session";

Object.assign(process.env, { CLOUDBASE_ENV_ID: "env", CLOUDBASE_API_KEY: "key", REPORT_BASE_URL: "https://x/report.html", API_BASE_URL: "https://x/api" });
const { main, sha256 } = await import("../functions/classroom-api/index");

const me = { _id: "a".repeat(64), openId: "ou_me", name: "牛老师", scheduleName: "牛" };
const token = issueSession(me as any, "key");
const dir = `recA/p-${sha256("ou_me|dev1").slice(0, 16)}`;
const mine = { _id: "recA", teacherOpenId: "ou_me", teacherName: "牛老师", course: "IG 物理", student: "小雨", stage: "recording", attempts: 0, lockedUntil: 0, startAt: 0, endAt: 0, updatedAt: 0, device: "dev1", partsAt: 1 };

type Call = { method: string; url: string; body?: string };
function fakeCloud(row: Record<string, any> | undefined, stored: Record<number, number> = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? init.body : undefined });
    if (url.includes("/rdb/rest/classroom_sessions")) return Response.json([me]);
    if (url.includes("/rdb/rest/classroom_lessons")) {
      if (method === "PATCH" && row) Object.assign(row, JSON.parse(String(init.body)));
      if (method === "GET" && url.includes("attempts=lt.")) return Response.json([]);
      return Response.json(row ? [row] : []);
    }
    if (url.includes("/object/upload/sign/classroom/")) return Response.json({ fullUrl: `https://storage/${url.split("/upload/sign/classroom/")[1]}?token=t` });
    if (url.endsWith("/object/list/classroom")) {
      const prefix = JSON.parse(String(init.body)).prefix;
      return Response.json({ objects: Object.entries(stored).map(([n, size]) => ({ name: `${prefix}${String(n).padStart(3, "0")}.mp3`, updated_at: new Date(0).toISOString(), metadata: { size } })) });
    }
    throw new Error(`没有预料到的请求 ${method} ${url}`);
  }) as typeof fetch;
  return calls;
}

/** concatObjects 用 https.request 把拼好的录音传上去：换成本机 http 服务，收下的内容放进 got */
async function fakePut(t: any) {
  const got: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    got.push(body);
    res.writeHead(200).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.mock.method(https, "request", (input: string, options: any, cb?: any) => request(new URL(new URL(input).pathname, origin), options, cb));
  return got;
}
const post = (path: string, query: Record<string, string> = {}, body?: unknown) =>
  main({ httpMethod: "POST", path: `/classroom-api${path}`, queryStringParameters: query, headers: { authorization: `Bearer ${token}`, "x-device": "dev1" }, body: body === undefined ? undefined : JSON.stringify(body) });
const parse = (res: any) => ({ status: res.statusCode as number, body: JSON.parse(res.body) });

test("分块地址：第一块查库建档记 partsAt，之后的块完全不碰数据库；目录按老师和电脑隔开", async () => {
  let row: any = { ...mine, partsAt: null };
  let calls = fakeCloud(row);
  const first = parse(await post("/lessons/recA/part-url", { n: "0", first: "1" }));
  assert.equal(first.body.url, `https://storage/${dir}/000.mp3?token=t`);
  assert.ok(row.partsAt > 0);

  calls = fakeCloud(row);
  const next = parse(await post("/lessons/recA/part-url", { n: "7", fails: "1", last: "part6-direct-timeout" }));
  assert.equal(next.body.url, `https://storage/${dir}/007.mp3?token=t`);
  assert.ok(!calls.some((c) => c.url.includes("/rdb/")), "之后的块不查库");

  // 别人的课：第一块就拒；别的老师用同一个课程编号也只能签到自己的目录
  calls = fakeCloud({ ...mine, teacherOpenId: "ou_other" });
  assert.equal(parse(await post("/lessons/recA/part-url", { n: "0", first: "1" })).status, 403);
  assert.equal(parse(await post("/lessons/recA/part-url", { n: "1000" })).status, 400);
  // 云端已经在出报告：第一块就告诉 App 不用传了
  fakeCloud({ ...mine, stage: "transcribing" });
  assert.deepEqual(parse(await post("/lessons/recA/part-url", { n: "0", first: "1" })).body, { done: true });
  // 合并反馈没有录音
  fakeCloud(mine);
  assert.equal(parse(await post("/lessons/merged-0123456789abcdef/part-url", { n: "0" })).status, 404);
});

test("分块 finish：缺的块报给 App 补传；齐了马上拼好核对校验值再转写", async (t) => {
  Object.assign(process.env, { TENCENT_SECRET_ID: "id", TENCENT_SECRET_KEY: "key" });
  const finish = { startedAt: "2026-11-22T08:00:00Z", endedAt: "2026-11-22T08:12:00Z", parts: [{ n: 0, bytes: 3 }, { n: 1, bytes: 3 }, { n: 2, bytes: 2 }], audio: { sha256: sha256(Buffer.from("aaabbbcc")), bytes: 8 } };
  let row: any = { ...mine };
  fakeCloud(row, { 0: 3, 2: 2 });
  assert.deepEqual(parse(await post("/lessons/recA/finish", {}, finish)).body, { missing: [1] });
  assert.equal(row.stage, "queued");
  assert.deepEqual(row.finish.parts, finish.parts);

  // 补齐后再 finish：拼起来、核对、提交转写
  const submit = t.mock.method(asr.v20190614.Client.prototype, "CreateRecTask", async () => ({ Data: { TaskId: 7 } }));
  row = { ...mine };
  const body: Record<string, string> = { "000": "aaa", "001": "bbb", "002": "cc" };
  const deleted: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET";
    if (url.includes("/rdb/rest/classroom_sessions")) return Response.json([me]);
    if (url.includes("/rdb/rest/classroom_lessons")) {
      if (method === "PATCH") Object.assign(row, JSON.parse(String(init.body)));
      if (url.includes("attempts=lt.")) return Response.json([]);
      return Response.json([row]);
    }
    if (url.endsWith("/object/list/classroom")) return Response.json({ objects: Object.entries(body).map(([n, s]) => ({ name: `${dir}/${n}.mp3`, metadata: { size: s.length } })) });
    if (url.includes("/object/authenticated/classroom/")) return new Response(body[url.match(/(\d{3})\.mp3$/)![1]]);
    if (url.includes("/object/sign/")) return Response.json({ fullSignedURL: "https://signed/merged" });
    if (method === "DELETE") return deleted.push(...JSON.parse(String(init.body)).prefixes), Response.json([]);
    throw new Error(`意外的请求 ${method} ${url}`);
  });
  const got = await fakePut(t);
  assert.deepEqual(parse(await post("/lessons/recA/finish", {}, finish)).body, { missing: [] });
  assert.deepEqual(got, ["aaabbbcc"]);
  assert.equal(row.stage, "transcribing", row.error);
  assert.equal(row.gapMinutes, 0);
  assert.equal(submit.mock.callCount(), 1);

  // 拼出来对不上老师电脑上的整节：不交给转写
  row = { ...mine };
  body["001"] = "bbX";
  await post("/lessons/recA/finish", {}, finish);
  assert.equal(row.stage, "failed");
  assert.match(row.error, /校验值不一致/);
  assert.equal(submit.mock.callCount(), 1);
  assert.deepEqual(deleted, []);
});

test("planParts：到齐才拼；缺块等 2 小时，之后用已到的并估算缺了几分钟；App 没回来时按空洞算", () => {
  const parts = [{ n: 0, bytes: 1_200_000 }, { n: 1, bytes: 1_200_000 }, { n: 2, bytes: 400_000 }];
  const t0 = Date.UTC(2026, 10, 22, 9);
  const full = new Map([[0, 1_200_000], [1, 1_200_000], [2, 400_000]]);
  assert.deepEqual(L.planParts(parts, full, t0, t0), { ready: true, use: [0, 1, 2], missing: [], gapMinutes: 0 });
  const half = new Map([[0, 1_200_000], [1, 999], [2, 400_000]]); // 大小不对也算没到
  assert.equal(L.planParts(parts, half, t0 + L.PARTS_GRACE_MS - 1, t0).ready, false);
  assert.deepEqual(L.planParts(parts, half, t0 + L.PARTS_GRACE_MS, t0), { ready: true, use: [0, 2], missing: [1], gapMinutes: 5 });
  assert.deepEqual(L.planParts(undefined, new Map([[0, 1], [3, 1]]), t0, 0), { ready: true, use: [0, 3], missing: [1, 2], gapMinutes: 10 });
});

test("状态机：分块课有 finish 就按块拼；App 没回来的课表课下课 2 小时、随时录制第一块 2 小时后才收尾", () => {
  const endAt = Date.UTC(2026, 10, 22, 9, 30);
  const base = { attempts: 0, kind: "lesson" as const, endAt, updatedAt: endAt, segments: {}, partsAt: endAt - L.HOUR };
  const finish = { startedAt: "", endedAt: new Date(endAt).toISOString(), segments: [], parts: [{ n: 0, bytes: 1 }], audio: { sha256: "a".repeat(64), bytes: 1 } };
  assert.deepEqual(L.nextStep({ ...base, stage: "queued", finish }, endAt), { action: "parts" });
  const orphan = { ...base, stage: "recording" as const, finalUploadAt: endAt + 60_000 };
  assert.deepEqual(L.nextStep(orphan, endAt + L.PARTS_GRACE_MS - 1), { action: "none" });
  assert.deepEqual(L.nextStep(orphan, endAt + L.PARTS_GRACE_MS), { action: "parts" });
  const adhoc = { ...orphan, kind: "adhoc" as const, endAt: endAt + 3 * L.HOUR };
  assert.deepEqual(L.nextStep(adhoc, base.partsAt + L.PARTS_GRACE_MS), { action: "parts" });
});

test("App 没回来：最后一块还新就接着等，过了 2 小时用已到的块出报告并私信管理员", async (t) => {
  Object.assign(process.env, { TENCENT_SECRET_ID: "id", TENCENT_SECRET_KEY: "key", ADMIN_OPEN_IDS: "ou_admin" });
  t.after(() => delete process.env.ADMIN_OPEN_IDS);
  t.mock.method(asr.v20190614.Client.prototype, "CreateRecTask", async () => ({ Data: { TaskId: 9 } }));
  const now = Date.now();
  const row: any = { ...mine, kind: "adhoc", partsAt: now - 3 * L.HOUR, endAt: now };
  let newest = now - 30 * 60_000;
  const messages: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET";
    if (url.includes("/rdb/rest/classroom_lessons")) {
      if (method === "PATCH") Object.assign(row, JSON.parse(String(init.body)));
      return Response.json([row]);
    }
    if (url.endsWith("/object/list/classroom")) return Response.json({ objects: [0, 2].map((n) => ({ name: `${dir}/00${n}.mp3`, updated_at: new Date(newest).toISOString(), metadata: { size: 4 } })) });
    if (url.includes("/object/authenticated/classroom/")) return new Response("abcd");
    if (url.includes("/object/sign/")) return Response.json({ fullSignedURL: "https://signed/merged" });
    if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "t", expire: 7200 });
    if (url.includes("/im/v1/messages")) return messages.push(JSON.parse(JSON.parse(String(init.body)).content).text), Response.json({ code: 0, data: {} });
    throw new Error(`意外的请求 ${method} ${url}`);
  });
  await fakePut(t);
  Object.assign(process.env, { FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "s" });
  await main({ action: "tick", lessonId: "recA" });
  assert.equal(row.stage, "recording", "最后一块 30 分钟前才传上来，接着等");
  newest = now - L.PARTS_GRACE_MS - 1;
  await main({ action: "tick", lessonId: "recA" });
  assert.equal(row.stage, "transcribing", row.error);
  assert.equal(row.gapMinutes, 5);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /下课 2 小时录音还没传完/);
});
