import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, parseTranscript, decode, batches } from "../functions/classroom-api/review/analyze.cjs";
test("按行号核对同秒不同发言，原话和时间由原转写生成", () => {
  const lines = parseTranscript("[老师 60:10-60:13] 学生甲先说。\n[学生 60:10-60:14] 好。");
  const item = { code: "G4", impact: "待回听", title: "待核实", check: "回听", evidence: [1] };
  assert.deepEqual(decode(JSON.stringify({ findings: [item] }), lines, new Set([0, 1]))[0].evidence, [
    { line: 1, speaker: "学生", start: 3610, end: 3614, text: "好。" },
  ]);
  assert.throws(() => decode(JSON.stringify({ findings: [item] }), lines, new Set([0])));
  for (const fields of [{code:"U7"}, {code:"G6"}, {impact:""}, {code:"录音与转写"}]) {
    assert.throws(() => decode(JSON.stringify({findings:[{...item,...fields}]}),lines,new Set([0,1])));
  }
  assert.equal(decode(JSON.stringify({findings:[{...item,code:"U4"}]}),lines,new Set([1]))[0].priority, "紧急");
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
test("拟列紧急的奖励条件经独立复查移除，明确胁迫保留原话", async (t) => {
  const previous = process.env.AI_BASE_URL;
  process.env.AI_BASE_URL = "https://api.deepseek.com";
  t.after(() => {
    if (previous === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = previous;
  });
  const candidate = { code: "U4", title: "要求撤回意见", impact: "学生被要求撤回", check: "核对后果", evidence:[0] };
  const evidence = ["写完可以挑一本书。", "不撤回意见就取消你的实验分组资格。"];
  const responses = [
    {findings:[candidate]}, {decisions:[{index:0,code:"omit"}]},
    {findings:[candidate]}, {decisions:[{...candidate,index:0}]},
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices:[{finish_reason:"stop",message:{content:JSON.stringify(responses.shift())}}],
    usage:{prompt_tokens:12,completion_tokens:5},
  }));
  for (const [i, text] of evidence.entries()) {
    const out = await analyze({transcript:"[老师 00:00-00:04] " + text});
    assert.equal(out.usage.calls,2);
    assert.equal(out.usage.urgentChecked,1);
    assert.equal(out.findings.length,i);
    if (i) assert.equal(out.findings[0].evidence[0].text,text);
  }
});
