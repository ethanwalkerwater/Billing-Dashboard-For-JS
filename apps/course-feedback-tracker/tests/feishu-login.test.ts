import assert from "node:assert/strict";
import test from "node:test";

import { customUserId, loginRedirect, parseOrigins, safeNext, seal, unseal } from "../src/server/feishu-login";

const SECRET = "x".repeat(32);

test("seal / unseal 往返，过期和被改过的都拒绝", () => {
  const now = 1_000_000;
  const token = seal({ next: "https://app.jsjy.asia/feedback/" }, SECRET, now);
  assert.equal(unseal<{ next: string }>(token, SECRET, now + 1000)?.next, "https://app.jsjy.asia/feedback/");
  assert.equal(unseal(token, SECRET, now + 11 * 60_000), null);
  assert.equal(unseal(token, "y".repeat(32), now), null);
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ next: "https://evil.example/", exp: now + 60_000 })).toString("base64url");
  assert.equal(unseal(`${forged}.${signature}`, SECRET, now), null);
  assert.equal(unseal(`${payload}.${signature}.x`, SECRET, now), null);
  assert.equal(unseal("garbage", SECRET, now), null);
});

test("safeNext 只放行白名单域名，并去掉 #", () => {
  const origins = parseOrigins("https://app.jsjy.asia, http://localhost:4176/");
  assert.equal(safeNext("https://app.jsjy.asia/feedback/?a=1#/scores", origins), "https://app.jsjy.asia/feedback/?a=1");
  assert.equal(safeNext("http://localhost:4176/feedback/", origins), "http://localhost:4176/feedback/");
  assert.equal(safeNext("https://app.jsjy.asia.evil.example/", origins), null);
  assert.equal(safeNext("javascript:alert(1)", origins), null);
  assert.equal(safeNext(undefined, origins), null);
  assert.deepEqual(parseOrigins(undefined), ["https://app.jsjy.asia"]);
});

test("customUserId 稳定且符合 CloudBase 4–32 位规则", () => {
  const id = customUserId("ou_0123456789abcdef0123456789abcdef");
  assert.equal(id, customUserId("ou_0123456789abcdef0123456789abcdef"));
  assert.notEqual(id, customUserId("ou_fedcba9876543210fedcba9876543210"));
  assert.match(id, /^[a-zA-Z0-9_\-#@~=*(){}[\]:.,<>+]{4,32}$/);
});

test("loginRedirect 把 ticket 放在 # 后，不进服务器日志", () => {
  const url = new URL(loginRedirect("https://app.jsjy.asia/feedback/", "t+k/=", "b.c"));
  assert.equal(url.search, "");
  const hash = new URLSearchParams(url.hash.slice(1));
  assert.equal(hash.get("feishu_ticket"), "t+k/=");
  assert.equal(hash.get("feishu_bind"), "b.c");
});
