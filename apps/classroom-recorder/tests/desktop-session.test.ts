import assert from "node:assert/strict";
import test from "node:test";
import { issueSession, readSession } from "../functions/classroom-api/session";
import { DAY } from "../src/server/logic";

const key = "test-signing-key";
Object.assign(process.env, {
  CLOUDBASE_ENV_ID: "env", CLOUDBASE_API_KEY: key, REPORT_BASE_URL: "https://x/report.html",
  FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "test-feishu-key", SCHEDULE_APP_TOKEN: "schedule", SCHEDULE_TABLE_ID: "table",
});
const { main, sha256 } = await import("../functions/classroom-api/index");
const teacher = { _id: sha256("legacy"), openId: "ou_me", name: "王老师", scheduleName: "王" };

test("桌面签名会话校验签名与 30 天有效期", () => {
  const now = Date.now();
  const token = issueSession(teacher, key, now);
  assert.deepEqual(readSession(token, key, now + DAY), { ...teacher, exp: now + 30 * DAY });
  assert.equal(readSession(token, key, now + 30 * DAY), undefined);
  assert.equal(readSession(token, "other-key", now), undefined);
  const [version, payload, sig] = token.split(".");
  assert.equal(readSession(`${version}.${payload}.${sig[0] === "a" ? "b" : "a"}${sig.slice(1)}`, key), undefined);
});

test("旧版照常读会话，新版首次升级；后台续期只读飞书，前台仍接受行级吊销", async (t) => {
  const calls: string[] = [];
  let sessionExists = true;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("tenant_access_token")) {
      return Response.json({ code: 0, tenant_access_token: "fake" });
    }
    if (url.includes("/records/search")) {
      return Response.json({ code: 0, data: { items: [{ record_id: "recA", fields: {
        上课时间: Date.now(), 下课时间: Date.now() + 3_600_000, 老师: "王", 课程类型: "数学",
        老师课程ID: "10:00-11:00｜小雨｜数学｜",
      } }] } });
    }
    if (url.includes("/classroom_sessions")) return Response.json(sessionExists ? [teacher] : []);
    if (url.includes("/classroom_lessons")) {
      return Response.json(url.includes("_id=in.") ? [{ _id: "recA", stage: "done", summary: "总结", reportToken: "report" }] : []);
    }
    throw new Error(`意外调用 ${url}`);
  });

  const get = async (path: string, token: string, upgrade = false) => {
    const response = await main({
      httpMethod: "GET", path, headers: { authorization: `Bearer ${token}`, ...(upgrade ? { "x-classroom-signed-session": "1" } : {}) },
    });
    assert.ok("statusCode" in response);
    return response;
  };
  const legacy = await get("/lessons", "legacy");
  assert.equal(legacy.statusCode, 200);
  assert.equal(JSON.parse(legacy.body).lessons[0].summary, "总结");
  assert.ok(!("x-classroom-session" in legacy.headers));

  const upgrade = await get("/schedule", "legacy", true);
  assert.equal(upgrade.statusCode, 200);
  assert.equal(JSON.parse(upgrade.body).lessons[0].status, "upcoming");
  assert.ok("x-classroom-session" in upgrade.headers);
  assert.ok(readSession(String(upgrade.headers["x-classroom-session"]), key));

  calls.length = 0;
  const nearExpiry = issueSession(teacher, key, Date.now() - 24 * DAY);
  const schedule = await get("/schedule", nearExpiry);
  assert.equal(schedule.statusCode, 200);
  assert.ok("x-classroom-session" in schedule.headers);
  assert.ok(readSession(String(schedule.headers["x-classroom-session"]), key)!.exp >= Date.now() + 29 * DAY);
  assert.deepEqual(calls.map((url) => new URL(url).host), ["open.feishu.cn"]);

  calls.length = 0;
  sessionExists = false;
  assert.equal((await get("/lessons", nearExpiry)).statusCode, 401);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /classroom_sessions/);

  calls.length = 0;
  process.env.CLASSROOM_REVOKED_OPEN_IDS = teacher.openId;
  try {
    assert.equal((await get("/schedule", nearExpiry)).statusCode, 401);
    assert.deepEqual(calls, []);
  } finally {
    delete process.env.CLASSROOM_REVOKED_OPEN_IDS;
  }
});
