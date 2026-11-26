import assert from "node:assert/strict";
import test from "node:test";
import type { PostgrestLike } from "../src/shared/rdb";
import { countValue, loadRecords, updateStatuses, type ThanksRecord } from "../src/thanks-admin/data";

test("感谢记录按课程月用唯一任务号翻页，汇总包含超过 1000 条的月份", async () => {
  const source = Array.from({ length: 1102 }, (_, i) => ({
    task_id: String(1102 - i).padStart(4, "0"),
    course_month: i === 3 ? "2026-10" : "2026-11",
    created_at: new Date(2026, 9, 1, 0, i).toISOString(),
    gift_value: 0.1,
  }));
  let reads = 0;
  const db = { from(table: string) {
    assert.equal(table, "feedback_thanks_records");
    let page = source;
    let limit = 0;
    return {
      select() { return this; },
      eq(col: string, month: string) { assert.equal(col, "course_month"); page = page.filter(r => r.course_month === month); return this; },
      order(col: string, options: { ascending: boolean }) { assert.equal(col, "task_id"); assert.equal(options.ascending, false); return this; },
      lt(col: string, cursor: string) { assert.equal(col, "task_id"); page = page.filter(r => r.task_id < cursor); return this; },
      limit(n: number) { limit = n; return this; },
      then(resolve: (result: unknown) => void) { reads++; resolve({ data: page.slice(0, limit) }); },
    };
  }} as unknown as PostgrestLike;
  const rows = await loadRecords(db, "2026-11");
  assert.equal(reads, 3);
  assert.equal(rows.length, 1101);
  assert.equal(new Set(rows.map(r => r.task_id)).size, rows.length);
  assert.equal(rows[0].task_id, "0001");
  assert.equal(countValue(rows as ThanksRecord[]), 110.1);
});

test("保存状态要求 RLS 返回全部受影响的记录", async () => {
  const db = { from() { return {
    update() { return this; }, eq() { return this; }, in() { return this; },
    select() { return Promise.resolve({ data: [], error: null }); },
  }; }} as unknown as PostgrestLike;
  await assert.rejects(updateStatuses(db, "2026-11", ["a"], "done"), /没有处理权限/);
});
