import assert from "node:assert/strict";
import { test } from "node:test";

import { ymdToMs } from "../src/domain/dates";
import { pageData, rehearse, runDaily } from "../src/server/service";
import type { BirthdayDeps } from "../src/server/service";
import { signPageToken } from "../src/server/token";

function fakeDeps(over: { generate?: BirthdayDeps["generate"]; listLessons?: BirthdayDeps["feishu"]["listLessons"]; nowMs?: number } = {}) {
  const sent: Array<{ to: string; card: string }> = [];
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  const teacher = {
    record_id: "recT",
    fields: { 姓名: "汤朔", 主学科: "物理", 在职: true, 生日: ymdToMs({ y: 1995, m: 10, d: 12 }), 入职时间: ymdToMs({ y: 2024, m: 9, d: 1 }), 照片: [{ file_token: "boxP" }] },
  };
  const wishes = [
    { record_id: "w1", fields: { 老师: "汤朔", 年份: 2026, 你的名字: "小王", 身份: "学生", "最想对 ta 说的话": "谢谢老师", "图片 / 表情包": [{ file_token: "boxW", type: "image/gif" }] } },
    { record_id: "w2", fields: { 老师: "汤朔", 年份: 2026, 你的名字: "捣乱", "最想对 ta 说的话": "不该显示", 隐藏: true } },
  ];
  const deps: BirthdayDeps = {
    now: () => over.nowMs ?? ymdToMs({ y: 2026, m: 10, d: 12 }) + 9 * 3600_000,
    config: {
      teacherAppToken: "app", teacherTableId: "tblT", wishTableId: "tblW", wishFormUrl: "https://f.feishu.cn/share/base/form/shrA",
      scheduleAppToken: "sch", scheduleTableId: "tblS", academicOpenIds: ["ou_jw"], groupChatId: "oc_g",
      pageBaseUrl: "https://app.jsjy.asia/birthday/", pepper: "p".repeat(32),
    },
    generate: over.generate ?? (async () => "AI 写的寄语"),
    feishu: {
      listTeachers: async () => [teacher],
      getTeacher: async (id) => (id === "recT" ? teacher : null),
      updateTeacher: async (recordId, fields) => { updates.push({ recordId, fields }); },
      listWishes: async (name, year) => wishes.filter((w) => w.fields.老师 === name && w.fields.年份 === year),
      listLessons: over.listLessons ?? (async () => [{ fields: { 上课时间: ymdToMs({ y: 2026, m: 9, d: 1 }), 课程单价: "800", 课程时长: 2, 学生: { link_record_ids: ["s1"] } } }]),
      tmpUrls: async (tokens) => new Map(tokens.map((t) => [t, `https://tmp/${t}`])),
      send: async (to, card) => { sent.push({ to, card: JSON.stringify(card) }); },
    },
  };
  return { deps, sent, updates };
}

test("runDaily 生日当天：补发问卷 + 群卡片，写回年份/统计/AI 寄语；重跑不重复", async () => {
  const { deps, sent, updates } = fakeDeps();
  const results = await runDaily(deps);
  assert.deepEqual(results.map((r) => [r.kind, r.ok]), [["ask", true], ["celebrate", true]]);
  assert.deepEqual(sent.map((s) => s.to), ["open_id:ou_jw", "chat_id:oc_g"]);
  const merged = Object.assign({}, ...updates.map((u) => u.fields));
  assert.equal(merged["问卷已发年份"], 2026);
  assert.equal(merged["祝福已发年份"], 2026);
  assert.equal(merged["AI 寄语"], "AI 写的寄语");
  assert.equal(merged["今年课节"], 1);
});

test("runDaily: AI 失败 → 模板寄语，群卡片照发", async () => {
  const { deps, sent, updates } = fakeDeps({ generate: async () => { throw new Error("EXCEED_TOKEN_QUOTA_LIMIT"); } });
  const results = await runDaily(deps);
  assert.ok(results.every((r) => r.ok));
  assert.equal(sent.length, 2);
  assert.equal(updates.some((u) => "AI 寄语" in u.fields), false);
});

test("rehearse: 立即发送、不写已发年份", async () => {
  const { deps, sent, updates } = fakeDeps();
  const result = await rehearse(deps, "汤朔", "all");
  assert.equal(sent.length, 2);
  assert.ok(result.pageUrl?.startsWith("https://app.jsjy.asia/birthday/?t=recT.2026."));
  assert.equal(updates.some((u) => "问卷已发年份" in u.fields || "祝福已发年份" in u.fields), false);
  await assert.rejects(rehearse(deps, "不存在", "ask"), /找不到老师/);
});

test("pageData: 校验 token，过滤隐藏祝福，只返回展示字段", async () => {
  const { deps } = fakeDeps();
  assert.equal(await pageData(deps, "recT.2026.bad"), null);
  const data = await pageData(deps, signPageToken("recT", 2026, "p".repeat(32)));
  assert.ok(data);
  assert.equal(data.name, "汤朔");
  assert.equal(data.photoUrl, "https://tmp/boxP");
  assert.deepEqual(data.wishes.map((w) => w.name), ["小王"]);
  assert.deepEqual(data.wishes[0].media, [{ url: "https://tmp/boxW", kind: "image" }]);
  assert.equal(JSON.stringify(data).includes("1995"), false);
});

test("runDaily: 课表统计失败不挡群卡片，只是不写统计字段", async () => {
  const { deps, sent, updates } = fakeDeps({ listLessons: async () => { throw new Error("InvalidFilter"); } });
  const results = await runDaily(deps);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(sent.map((s) => s.to), ["open_id:ou_jw", "chat_id:oc_g"]);
  assert.equal(updates.some((u) => "今年课节" in u.fields), false);
  assert.equal(Object.assign({}, ...updates.map((u) => u.fields))["祝福已发年份"], 2026);
});

test("runDaily: 生日后一天补发的群卡片写明生日日期，不说「今天」", async () => {
  const { deps, sent } = fakeDeps({ nowMs: ymdToMs({ y: 2026, m: 10, d: 13 }) + 9 * 3600_000 });
  await runDaily(deps);
  const card = sent.find((s) => s.to.startsWith("chat_id"))!.card;
  assert.match(card, /10\/12/);
  assert.doesNotMatch(card, /今天是/);
});
