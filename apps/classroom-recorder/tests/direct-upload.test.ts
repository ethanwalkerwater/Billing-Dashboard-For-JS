/**
 * 0.1.12 起 App 下课后整节课直传：签名接口只给自己的课签、对象名由服务端定；finish 核对大小；云端收尾找直传的录音。
 * 函数里的 fetch 全部换成假的（数据库 / Storage / 飞书都不碰真的），没认出来的请求直接报错。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { asr } from "tencentcloud-sdk-nodejs-asr";
import { CommonClient } from "tencentcloud-sdk-nodejs-common/tencentcloud/common";

import * as L from "../src/server/logic";

Object.assign(process.env, { CLOUDBASE_ENV_ID: "env", CLOUDBASE_API_KEY: "key", REPORT_BASE_URL: "https://x/report.html", API_BASE_URL: "https://x/api" });
const { main, sha256 } = await import("../functions/classroom-api/index");

type Call = { method: string; url: string; body?: string };
function fakeCloud(lesson: Record<string, unknown> | undefined, opts: { size?: number | null; finishUpdates?: number; pending?: string[] } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? init.body : undefined });
    const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
    if (url.includes("/rdb/rest/classroom_sessions")) return ok([{ _id: sha256("tok"), openId: "ou_me", name: "牛老师", scheduleName: "牛" }]);
    if (url.includes("/rdb/rest/classroom_segments")) return ok([]);
    if (url.includes("/rdb/rest/classroom_lessons") && method === "GET") {
      if (url.includes("attempts=lt.")) return ok((opts.pending ?? []).map((_id) => ({ _id })));
      return ok(lesson ? [lesson] : []);
    }
    if (url.includes("/rdb/rest/classroom_lessons") && method === "PATCH") {
      // finish 的条件更新：finishUpdates = 0 模拟「收尾已经在跑」；其余 PATCH（updatedAt、租约）照常
      if (url.includes("finish=is.null")) return ok(Array.from({ length: init.body?.toString().includes('"finish"') ? opts.finishUpdates ?? 1 : 1 }, () => ({ _id: lesson?._id })));
      if (url.includes("lockedUntil=lt.")) return ok([]); // 租约拿不到 = 别的实例在处理，测试里不真的去提交转写
      return ok(null, 204);
    }
    if (url.includes("/object/upload/sign/classroom/")) return ok({ fullUrl: `https://storage/${url.split("/upload/sign/classroom/")[1]}?token=t` });
    if (method === "HEAD") return opts.size == null ? ok(null, 404) : new Response(null, { status: 200, headers: { "content-length": String(opts.size) } });
    throw new Error(`没有预料到的请求 ${method} ${url}`);
  }) as typeof fetch;
  return calls;
}
const call = (path: string, query: Record<string, string> = {}, body?: unknown) =>
  main({ httpMethod: "POST", path: `/classroom-api${path}`, queryStringParameters: query, headers: { authorization: "Bearer tok", "x-device": "dev1" }, body: body === undefined ? undefined : JSON.stringify(body) });
const parse = (res: any) => ({ status: res.statusCode as number, body: JSON.parse(res.body) });
const mine = { _id: "recA", teacherOpenId: "ou_me", stage: "recording", attempts: 0, lockedUntil: 0, endAt: 0, updatedAt: 0, device: "dev1" };

test("录课请求按实例节流查询待办，SCF 异步推进且不运行过期清理", async (t) => {
  Object.assign(process.env, { TENCENTCLOUD_SECRETID: "id", TENCENTCLOUD_SECRETKEY: "key", TENCENTCLOUD_SESSIONTOKEN: "token" });
  t.after(() => {
    delete process.env.TENCENTCLOUD_SECRETID;
    delete process.env.TENCENTCLOUD_SECRETKEY;
    delete process.env.TENCENTCLOUD_SESSIONTOKEN;
  });
  const invoke = t.mock.method(CommonClient.prototype, "request", async () => ({ RequestId: "local" }));
  const calls = fakeCloud({ ...mine, stage: "done" }, { pending: ["recB"] });
  await call("/lessons/recA/upload-url", { kind: "final" });
  await call("/lessons/recA/upload-url", { kind: "final" });
  const checks = calls.filter((c) => c.url.includes("attempts=lt."));
  assert.equal(checks.length, 1);
  assert.match(checks[0].url, /earlyAt.lte./);
  assert.match(checks[0].url, /_id=not.eq.recA/);
  assert.equal(invoke.mock.callCount(), 1);
  const [action, request] = invoke.mock.calls[0].arguments;
  assert.equal(action, "Invoke");
  assert.equal(request.InvocationType, "Event");
  assert.deepEqual(JSON.parse(request.ClientContext), { action: "ride", lessonIds: ["recB"] });

  const rideCalls = fakeCloud(undefined);
  assert.deepEqual(await main({ action: "ride", lessonIds: ["recB", "recB", "invalid"] }), { ok: true });
  assert.equal(rideCalls.length, 1);
  assert.match(rideCalls[0].url, /_id=eq.recB.*lockedUntil=lt./);
});

test("签名直传：只给自己的课签，对象名由服务端定；已经在出报告的不再要录音", async () => {
  let calls = fakeCloud(mine);
  let res = parse(await call("/lessons/recA/upload-url", { kind: "final" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.url, "https://storage/recA/merged.mp3?token=t");
  assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/upload/sign/classroom/recA/merged.mp3")));
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.includes("_id=eq.recA") && c.body?.includes("finalUploadAt")), "记下 App 还活着");

  calls = fakeCloud(mine);
  assert.equal(parse(await call("/lessons/recA/upload-url", { kind: "early" })).body.url, "https://storage/recA/early.mp3?token=t");
  assert.ok(calls.some((c) => c.method === "PATCH" && JSON.parse(c.body!).earlyAt > 0));
  assert.ok(!calls.some((c) => c.url.includes("classroom_segments")));

  // 别的老师的课、别的电脑在录的课：不签
  calls = fakeCloud({ ...mine, teacherOpenId: "ou_other" });
  assert.equal(parse(await call("/lessons/recA/upload-url", { kind: "final" })).status, 403);
  assert.ok(!calls.some((c) => c.url.includes("/upload/sign/")));
  calls = fakeCloud({ ...mine, device: "dev2" });
  assert.equal(parse(await call("/lessons/recA/upload-url", { kind: "final" })).status, 409);
  assert.ok(!calls.some((c) => c.url.includes("/upload/sign/")));

  // 随时录制没有计划下课时间，不收 early；kind 乱填不收
  fakeCloud({ ...mine, _id: "adhoc-0123456789abcdef", kind: "adhoc" });
  assert.equal(parse(await call("/lessons/adhoc-0123456789abcdef/upload-url", { kind: "early" })).status, 400);
  fakeCloud(mine);
  assert.equal(parse(await call("/lessons/recA/upload-url", { kind: "../x" })).status, 400);

  // 云端已经用已有录音收尾了：告诉 App 不用传
  calls = fakeCloud({ ...mine, stage: "transcribing" });
  assert.deepEqual(parse(await call("/lessons/recA/upload-url", { kind: "final" })).body, { done: true });
  assert.ok(!calls.some((c) => c.url.includes("/upload/sign/")));
  // 收尾时什么都没找到（empty 且没有转写）：App 之后传上来还接着处理
  fakeCloud({ ...mine, stage: "empty", transcript: null });
  assert.ok(parse(await call("/lessons/recA/upload-url", { kind: "final" })).body.url);
});

test("直传的 finish：大小对不上让 App 重传；对上了才转入处理，正在收尾的不盖回去", async () => {
  const signed = { ...mine, finalUploadAt: 1 };
  const finish = { startedAt: "2026-11-12T08:00:00.000Z", endedAt: "2026-11-12T09:30:00.000Z", audio: { sha256: "a".repeat(64), bytes: 21_600_000 } };
  fakeCloud(signed, { size: null });
  assert.deepEqual(parse(await call("/lessons/recA/finish", {}, finish)).body, { missing: [], reupload: true });
  fakeCloud(signed, { size: 21_599_999 });
  assert.deepEqual(parse(await call("/lessons/recA/finish", {}, finish)).body, { missing: [], reupload: true });

  let calls = fakeCloud(signed, { size: 21_600_000, finishUpdates: 1 });
  assert.deepEqual(parse(await call("/lessons/recA/finish", {}, finish)).body, { missing: [] });
  const update = calls.find((c) => c.method === "PATCH" && c.url.includes("transcript=is.null"))!;
  assert.match(update.url, /stage=in\.\(recording,empty\)/);
  assert.equal(JSON.parse(update.body!).finish.audio.bytes, 21_600_000);
  assert.ok(calls.some((c) => c.url.includes("lockedUntil=lt.")), "对上了就立刻推进");

  calls = fakeCloud(signed, { size: 21_600_000, finishUpdates: 0 });
  assert.equal(parse(await call("/lessons/recA/finish", {}, finish)).status, 503, "锁冲突要重试，不能确认收到");

  // 云端已经在出报告：晚到的 finish 直接确认，不查对象
  calls = fakeCloud({ ...mine, stage: "done" }, { size: 1 });
  assert.deepEqual(parse(await call("/lessons/recA/finish", {}, finish)).body, { missing: [] });
  assert.ok(!calls.some((c) => c.method === "HEAD"));
  // 既没有分段也没有 audio：400
  fakeCloud(signed);
  assert.equal(parse(await call("/lessons/recA/finish", {}, { ...finish, audio: { sha256: "x", bytes: 1 } })).status, 400);
});

test("完整直传和保险收尾都只把 Storage 地址交给腾讯 ASR", async (t) => {
  Object.assign(process.env, { TENCENT_SECRET_ID: "test-id", TENCENT_SECRET_KEY: "test-key" });
  const submit = t.mock.method(asr.v20190614.Client.prototype, "CreateRecTask", async () => ({ Data: { TaskId: 42 } }));
  t.mock.method(asr.v20190614.Client.prototype, "DescribeTaskStatus", async () => ({ Data: { Status: 2, ResultDetail: [] } }));
  const requests: string[] = [];
  let row: Record<string, unknown> = { ...mine, earlyAt: 1, finalUploadAt: 2 };
  let deleted: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET";
    requests.push(`${method} ${url}`);
    if (url.includes("/classroom_sessions")) return Response.json([{ _id: sha256("tok"), openId: "ou_me" }]);
    if (url.includes("/rdb/rest/classroom_lessons")) {
      if (method === "PATCH") Object.assign(row, JSON.parse(String(init.body)));
      return Response.json([row]);
    }
    if (method === "HEAD") return new Response(null, { headers: { "content-length": "120000" } });
    if (url.includes("/object/sign/")) return Response.json({ fullSignedURL: url.replace("/object/sign/", "/signed/") });
    if (method === "DELETE" && url.endsWith("/object/classroom")) {
      deleted.push(...JSON.parse(String(init.body)).prefixes);
      return Response.json([]);
    }
    throw new Error(`意外的请求 ${method} ${url}`);
  });
  const finish = { startedAt: "2026-11-12T08:00:00Z", endedAt: "2026-11-12T08:00:30Z", audio: { sha256: "a".repeat(64), bytes: 120_000 } };
  assert.equal(parse(await call("/lessons/recA/finish", {}, finish)).status, 200);
  assert.equal(row.stage, "transcribing");
  assert.equal(row.mergedFileId, "recA/merged.mp3");
  assert.match(submit.mock.calls[0].arguments[0]!.Url!, /signed\/classroom\/recA\/merged.mp3$/);
  await call("/asr/callback", { lesson: "recA" });
  assert.equal(row.stage, "empty");
  assert.deepEqual(deleted, ["recA/early.mp3"]);

  row = { ...mine, earlyAt: 1 };
  deleted = [];
  assert.deepEqual(await main({ action: "ride", lessonIds: ["recA"] }), { ok: true });
  assert.equal(row.stage, "transcribing");
  assert.equal(row.mergedFileId, "recA/early.mp3");
  assert.match(submit.mock.calls[1].arguments[0]!.Url!, /signed\/classroom\/recA\/early.mp3$/);
  await call("/asr/callback", { lesson: "recA" });
  assert.equal(row.stage, "empty");
  assert.deepEqual(deleted, []);
  assert.ok(!requests.some((request) => /^(GET|PUT).*\/object\/authenticated|^PUT /.test(request)));
});

test("状态机：早传满 20 分钟才收尾；最近签过完整录音则优先等完整录音", () => {
  const endAt = Date.UTC(2026, 10, 12, 9, 30);
  const base = { stage: "queued" as const, attempts: 0, kind: "lesson" as const, endAt, updatedAt: endAt, segments: {} };
  const finish = { startedAt: "", endedAt: new Date(endAt).toISOString(), segments: [], audio: { sha256: "a".repeat(64), bytes: 100 } };
  assert.deepEqual(L.nextStep({ ...base, finish }, endAt), { action: "direct", files: ["merged.mp3"] });

  const orphan = { ...base, stage: "recording" as const, earlyAt: endAt };
  assert.deepEqual(L.nextStep(orphan, endAt + L.DIRECT_QUIET_MS - 1), { action: "none" });
  assert.deepEqual(L.nextStep(orphan, endAt + L.DIRECT_QUIET_MS), { action: "direct", files: ["early.mp3"] });
  const late = { ...orphan, finalUploadAt: endAt + 15 * 60_000 };
  assert.deepEqual(L.nextStep(late, endAt + L.DIRECT_QUIET_MS), { action: "none" });
  assert.deepEqual(L.nextStep(late, late.finalUploadAt + L.DIRECT_QUIET_MS), { action: "direct", files: ["merged.mp3", "early.mp3"] });
  const adhoc = { ...late, kind: "adhoc" as const, earlyAt: null, endAt: endAt + 3 * L.HOUR };
  assert.deepEqual(L.nextStep(adhoc, late.finalUploadAt + L.DIRECT_QUIET_MS), { action: "direct", files: ["merged.mp3"] });

  assert.ok(L.acceptsAudio({ stage: "recording" }) && L.acceptsAudio({ stage: "empty", transcript: null }));
  assert.ok(!L.acceptsAudio({ stage: "empty", transcript: "[说话人1 00:00-00:03] 嗯" }) && !L.acceptsAudio({ stage: "transcribing" }) && !L.acceptsAudio({ stage: "done" }));
});
