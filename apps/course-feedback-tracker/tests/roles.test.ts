import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_ACTIONS, allowedPages, canViewDetail } from "../src/shared/roles";

test("teacher 能看老师评分但看不到评分明细；只有 super 有管理员设置", () => {
  assert.ok(allowedPages("teacher").includes("scores") && !allowedPages("teacher").includes("admin"));
  assert.equal(canViewDetail("teacher"), false);
  assert.equal(canViewDetail(undefined), false);
  assert.ok(canViewDetail("admin") && !allowedPages("admin").includes("admin"));
  assert.ok(allowedPages("super").includes("admin"));
  assert.ok(ADMIN_ACTIONS.has("export-feedback-csv"));
});
