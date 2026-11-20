import assert from "node:assert/strict";
import { test } from "node:test";
import { issueReviewSession, readReviewSession } from "../functions/classroom-api/review/access";

const teacher = "ou_synthetic_supervisor";
const grant = "10382a7d-1652-4155-aeed-046d06b7df30";
const now = 1_800_000_000_000;
test("签名会话绑定飞书身份和一次授权，到八小时截止即失效", () => {
  const auth = "Bearer " + issueReviewSession(teacher, grant, "test-key", now);
  assert.deepEqual(readReviewSession(auth, "test-key", now + 1), { openId: teacher, grant });
  assert.equal(readReviewSession(auth, "test-key", now + 8 * 3600_000), undefined);
  assert.equal(readReviewSession(auth.replace(teacher, "ou_different_person"), "test-key", now), undefined);
  assert.equal(readReviewSession(auth.replace(grant, grant.toUpperCase()), "test-key", now), undefined);
  assert.equal(readReviewSession(auth, "another-key", now), undefined);
  assert.equal(readReviewSession("Bearer ordinary-admin-token", "test-key", now), undefined);
});

test("HTTP 入口逐次复查主管名单，普通后台会话、过期授权和模拟身份均不能读取实课", async () => {
  const { main } = await import("../functions/classroom-api/index");
  const request = (path: string, token: string, origin = "https://app.jsjy.asia") => main({
    httpMethod: path === "/decision" || path === "/teachers:create" ? "POST" : "GET",
    path: "/classroom-api/fupan" + path.replace(":create", ""),
    headers: {cookie:"__Secure-fupan_session=" + token, origin, "x-fupan-request":"1", "x-view-as":teacher}
  });
  const original = globalThis.fetch;
  const previous = [process.env.CLOUDBASE_ENV_ID, process.env.CLOUDBASE_API_KEY, process.env.REPORT_BASE_URL];
  process.env.CLOUDBASE_ENV_ID = "unit-test";
  process.env.CLOUDBASE_API_KEY = "fixture-service-key";
  process.env.REPORT_BASE_URL = "https://app.jsjy.asia/classroom/report.html";
  let activeGrant = "";
  const urls: string[] = [];
  globalThis.fetch = async url => {
    const u = new URL(String(url));
    urls.push(u.pathname);
    assert.equal(u.pathname, "/v1/rdb/rest/fupan_supervisors");
    assert.equal(u.searchParams.get("open_id"), "eq." + teacher);
    return Response.json(activeGrant ? [{open_id:teacher,name:"测试主管",grant_id:activeGrant}] : []);
  };
  try {
    for (const path of ["/me","/inbox","/lesson","/audio","/teachers","/teacher","/decision","/teachers:create","/notes"]) {
      assert.equal((await request(path, "ordinary-staff-session") as {statusCode:number}).statusCode, 401);
    }
    assert.equal(urls.length, 0);
    const token = issueReviewSession(teacher, grant, "fixture-service-key");
    for (const path of ["/inbox", "/audio", "/decision", "/notes"]) {
      assert.equal((await request(path,token) as {statusCode:number}).statusCode, 403);
    }
    activeGrant = grant;
    assert.equal((await request("/decision",token,"https://different.test") as {statusCode:number}).statusCode,403);
    const allowed = await request("/me", token) as {statusCode:number,body:string};
    assert.equal(allowed.statusCode,200);
    assert.deepEqual(JSON.parse(allowed.body), { name:"测试主管" });
    activeGrant = "eeeeeeee-1111-4111-8111-111111111111";
    assert.equal((await request("/audio",token) as {statusCode:number}).statusCode, 403);
  } finally {
    globalThis.fetch = original;
    for (const [i,key] of ["CLOUDBASE_ENV_ID","CLOUDBASE_API_KEY","REPORT_BASE_URL"].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  }
});

test("飞书回调仅接受发起登录的浏览器，允许和拒绝均不把会话放进网址", async (t) => {
  const { main } = await import("../functions/classroom-api/index");
  const settings = {REPORT_BASE_URL:"https://app.jsjy.asia/classroom/report.html",API_BASE_URL:"https://app.jsjy.asia/classroom-api",
    FEISHU_APP_ID:"fixture-app",FEISHU_APP_SECRET:"fixture-secret",CLOUDBASE_ENV_ID:"fixture",CLOUDBASE_API_KEY:"fixture"};
  const previous = new Map(Object.keys(settings).map(k => [k,process.env[k]]));
  Object.assign(process.env,settings);
  t.after(() => { for(const [k,v] of previous) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } });
  type Reply = {statusCode:number,headers: Record<string,string>};
  let pending: Record<string,unknown> | undefined;
  let authorized = false;
  t.mock.method(globalThis,"fetch", async (input:string, init:RequestInit) => {
    const u = new URL(input);
    if (u.pathname.endsWith("/classroom_auth")) {
      if (init.method==="POST") { [pending]=JSON.parse(String(init.body)); return new Response(null,{status:201}); }
      if (init.method==="DELETE") { const consumed=pending;pending=undefined;return Response.json(consumed?[consumed]:[]); }
      return Response.json(pending?[pending]:[]);
    }
    if (u.pathname.endsWith("/oauth/token")) return Response.json({code:0,access_token:"synthetic"});
    if (u.pathname.endsWith("/user_info")) return Response.json({code:0,data:{open_id:teacher,name:"测试账号"}});
    if (u.pathname.endsWith("/fupan_supervisors")) return Response.json(authorized?[{open_id:teacher,name:"测试主管",grant_id:grant}]:[]);
    throw new Error("不应访问其他内部服务");
  });
  for (authorized of [false,true]) {
    const start = await main({path:"/classroom-api/fupan/login",httpMethod:"GET"}) as Reply;
    const cookie = start.headers["set-cookie"].split(";")[0];
    const state = new URL(start.headers.location).searchParams.get("state")!;
    assert.match(start.headers["set-cookie"], /HttpOnly; Secure; SameSite=Lax/);
    const callback = (c:string) => main({path:"/classroom-api/auth/callback",httpMethod:"GET",headers:{cookie:c},
      queryStringParameters:{state,code:"test"}}) as Promise<Reply>;
    assert.equal((await callback("")).statusCode,403);
    const result = await callback(cookie);
    assert.equal(result.statusCode,302);
    assert.equal(result.headers.location, "https://app.jsjy.asia/fupan/" + (authorized?"":"#denied"));
    assert.match(result.headers["set-cookie"], /Path=\/classroom-api\/fupan; HttpOnly; Secure; SameSite=Strict/);
    if(!authorized) assert.match(result.headers["set-cookie"], /Max-Age=0;/);
    assert.equal((await callback(cookie)).statusCode,400);
  }
});
