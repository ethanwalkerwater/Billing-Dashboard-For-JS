import assert from "node:assert/strict";
import { it } from "node:test";

import { createServiceDb } from "../functions/feedback-api/service-db";

it("filters scoring history before the current month in one ordered request", async () => {
  let calls = 0;
  const rows = [{ course_month: "2026-01", detail: [] }];
  const db = createServiceDb({ envId: "example", apiKey: "example", fetchImpl: async (input) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("select"), "course_month,detail");
    assert.equal(url.searchParams.get("course_month"), "lt.2026-09");
    assert.equal(url.searchParams.get("order"), "course_month.asc");
    return new Response(JSON.stringify(rows));
  } });
  const result = await db.from("feedback_score_results").select("course_month,detail").lt("course_month", "2026-09").order("course_month");
  assert.equal(calls, 1);
  assert.equal(result.error, null);
  assert.deepEqual(result.data, rows);
});
