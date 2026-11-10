import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { FEEDBACK_ADMIN_NAMES, claimsAllowFeedbackAdmin } from "../src/domain/admin-allowlist";

function feishuClaims(name: string, provider: string | string[] = "feishu") {
  const providers = Array.isArray(provider) ? provider : [provider];
  return {
    name,
    app_metadata: { provider: providers[0], providers },
    user_metadata: { name },
  };
}

describe("feedback admin allowlist", () => {
  it("admits only the three named Feishu accounts", () => {
    for (const name of FEEDBACK_ADMIN_NAMES) {
      assert.equal(claimsAllowFeedbackAdmin(feishuClaims(name)), true, name);
    }
  });

  it("accepts a Feishu name with extra spaces", () => {
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims(" 包天翊 ")), true);
  });

  it("rejects everyone else, including a password account using an admin name", () => {
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims("其他人")), false);
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims("包天翊", "password")), false);
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims("黄钢", "anonymous")), false);
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims("徐翰超", "username")), false);
    assert.equal(claimsAllowFeedbackAdmin({ name: "包天翊" }), false);
    assert.equal(claimsAllowFeedbackAdmin(null), false);
    assert.equal(claimsAllowFeedbackAdmin({ app_metadata: { provider: "feishu" } }), false);
  });

  it("accepts Feishu when it is one of several linked providers", () => {
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims("徐翰超", ["password", "feishu"])), true);
    assert.equal(claimsAllowFeedbackAdmin(feishuClaims("黄钢", "Lark")), true);
  });

  it("keeps the same three names in the database migration", () => {
    const sql = readFileSync(new URL("../migrations/202609170005_feishu_admin_allowlist.sql", import.meta.url), "utf8");
    for (const name of FEEDBACK_ADMIN_NAMES) {
      assert.match(sql, new RegExp(name));
    }
    assert.match(sql, /grant execute on function public\.feedback_uid_is_admin\(text\) to service_role/);
    assert.match(sql, /revoke all on function public\.feedback_uid_is_admin\(text\) from public, anon, authenticated/);
    assert.doesNotMatch(sql, /grant execute on function public\.feedback_uid_is_admin\(text\) to authenticated/);
  });
});
