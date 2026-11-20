import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, decode, batches } from "../functions/classroom-api/review/analyze.cjs";
test("按行号核对同秒不同发言，原话和时间由原转写生成", () => {
  const lines = parseTranscript("[老师 60:10-60:13] 学生甲先说。\n[学生 60:10-60:14] 好。");
  const item = { category: "施压言语", priority: "一般", title: "待核实", check: "回听", evidence: [1] };
  assert.deepEqual(decode(JSON.stringify({ findings: [item] }), lines, new Set([0, 1]))[0].evidence, [
    { line: 1, speaker: "学生", start: 3610, end: 3614, text: "好。" },
  ]);
  assert.throws(() => decode(JSON.stringify({ findings: [item] }), lines, new Set([0])));
  assert.ok(!batches(lines, ["学生甲"])[0].includes("学生甲"));
  assert.throws(() => parseTranscript("没有时间戳"));
  assert.deepEqual(decode('{"findings":[]}', lines, new Set()), []);
});
test("复盘内部事件缺少签名时拒绝，在读库前返回", async () => {
  const { main } = await import("../functions/classroom-api/index");
  assert.deepEqual(await main({ action: "classroomReview", lessonId: "recExample" }), {
    ok: false,
    error: "UNAUTHORIZED",
  });
});
