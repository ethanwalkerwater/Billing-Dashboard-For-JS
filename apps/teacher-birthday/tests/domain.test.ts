import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseBlessing, templateBlessing } from "../src/domain/blessing";
import { askCard, celebrateCard, wishFormUrl } from "../src/domain/cards";
import { ymdToMs } from "../src/domain/dates";
import { parseTeacher, parseWish, WISH_FIELDS } from "../src/domain/records";
import { scheduleStats } from "../src/domain/stats";
import { signPageToken, verifyPageToken } from "../src/server/token";

test("parseTeacher: 文本段落数组、日期、人员、复选框、课表名回退", () => {
  const row = parseTeacher({
    record_id: "recA",
    fields: {
      姓名: [{ type: "text", text: "Jack Hou（侯东淳）" }],
      课表名: "Jack Hou",
      主学科: "英语",
      生日: ymdToMs({ y: 1990, m: 3, d: 4 }),
      在职: true,
      飞书账号: [{ id: "ou_x", name: "侯东淳" }],
      问卷已发年份: 2026,
      照片: [{ file_token: "boxA", name: "a.webp" }],
    },
  });
  assert.equal(row.name, "Jack Hou（侯东淳）");
  assert.equal(row.scheduleName, "Jack Hou");
  assert.equal(row.openId, "ou_x");
  assert.equal(row.askedYear, 2026);
  assert.equal(row.celebratedYear, null);
  assert.equal(row.photoToken, "boxA");
  assert.equal(parseTeacher({ record_id: "r", fields: { 姓名: "汤朔" } }).scheduleName, "汤朔");
  assert.equal(parseTeacher({ record_id: "r", fields: { 姓名: "汤朔" } }).active, false);
});

test("parseWish: 隐藏或无正文 → null；附件保留 token 与类型", () => {
  assert.equal(parseWish({ 你的名字: "小王", "最想对 ta 说的话": "生日快乐", 隐藏: true }), null);
  assert.equal(parseWish({ 你的名字: "小王", "最想对 ta 说的话": "  " }), null);
  const wish = parseWish({
    你的名字: "小王", 身份: "学生", "最想对 ta 说的话": "谢谢老师",
    "图片 / 表情包": [{ file_token: "boxB", name: "猫.gif", type: "image/gif" }],
  });
  assert.deepEqual(wish, { name: "小王", role: "学生", text: "谢谢老师", files: [{ token: "boxB", name: "猫.gif", mime: "image/gif" }] });
});

test("scheduleStats: 只算有单价、时长>0、非临时取消、一年内的课；学生按关联 ID 去重", () => {
  const today = ymdToMs({ y: 2026, m: 10, d: 12 });
  const lesson = (over: Record<string, unknown>) => ({
    fields: { 上课时间: today - 10 * 86_400_000, 课程单价: "1000", 课程时长: { type: 2, value: [2] }, 学生: { link_record_ids: ["s1"] }, ...over },
  });
  const stats = scheduleStats(
    [
      lesson({}),
      lesson({ 学生: { link_record_ids: ["s1", "s2"] }, 课程时长: { type: 2, value: [1.5] } }),
      lesson({ 临时取消: "6h-30%" }),
      lesson({ 课程单价: "" }),
      lesson({ 上课时间: today - 400 * 86_400_000 }),
      lesson({ 上课时间: today + 86_400_000 }),
    ],
    today,
  );
  assert.deepEqual(stats, { lessons: 2, students: 2, hours: 3.5 });
});

test("token: 往返、篡改年份或签名都失败", () => {
  const token = signPageToken("recA", 2026, "p".repeat(32));
  assert.deepEqual(verifyPageToken(token, "p".repeat(32)), { recordId: "recA", year: 2026 });
  assert.equal(verifyPageToken(token.replace(".2026.", ".2027."), "p".repeat(32)), null);
  assert.equal(verifyPageToken(`${token}x`, "p".repeat(32)), null);
  assert.equal(verifyPageToken("garbage", "p".repeat(32)), null);
});

test("寄语：手写优先，其次 AI，再次模板", () => {
  assert.equal(chooseBlessing({ name: "汤朔", handwritten: "手写", aiBlessing: "AI" }), "手写");
  assert.equal(chooseBlessing({ name: "汤朔", handwritten: " ", aiBlessing: "AI" }), "AI");
  assert.equal(chooseBlessing({ name: "汤朔", handwritten: "", aiBlessing: "" }), templateBlessing("汤朔"));
  assert.match(templateBlessing("汤朔"), /汤朔/);
});

test("问卷链接只预填并隐藏老师；祝福字段不依赖年份；卡片带链接与 @", () => {
  const url = new URL(wishFormUrl("https://x.feishu.cn/share/base/form/shrA", "汤朔"));
  assert.deepEqual(Object.fromEntries(url.searchParams), { prefill_老师: "汤朔", hide_老师: "1" });
  assert.equal(Object.values(WISH_FIELDS).join(",").includes("年份"), false);
  const ask = JSON.stringify(askCard({ teacherName: "汤朔", date: { y: 2026, m: 10, d: 12 }, daysLeft: 3, formUrl: url.href, wishCount: 0 }));
  assert.match(ask, /10\/12/);
  assert.ok(ask.includes(url.href));
  const celebration = JSON.stringify(celebrateCard({ teacherName: "汤朔", openId: "ou_x", pageUrl: "https://p" }));
  assert.match(celebration, /<at id=ou_x><\/at>/);
  assert.match(celebration, /专属生日礼物/);
  assert.doesNotMatch(celebration, /\d+.*(?:条祝福|位同学)/);
  assert.doesNotMatch(JSON.stringify(celebrateCard({ teacherName: "汤朔", openId: null, pageUrl: "https://p" })), /<at/);
});

test("parseTeacher: 飞书数字字段返回字符串（实测单条 GET 为 \"267\"）也要读成数字，否则已发年份失效会每天重复发送", () => {
  const row = parseTeacher({
    record_id: "recS",
    fields: { 姓名: "汤朔", 在职: true, 问卷已发年份: "2026", 祝福已发年份: "2026", 今年课节: "267", 今年学生: "30", 今年课时: "515.5", 生日: "1791216000000" },
  });
  assert.equal(row.askedYear, 2026);
  assert.equal(row.celebratedYear, 2026);
  assert.deepEqual(row.stats, { lessons: 267, students: 30, hours: 515.5 });
  assert.equal(row.birthMs, 1791216000000);
  assert.equal(parseTeacher({ record_id: "r", fields: { 姓名: "x", 问卷已发年份: "" } }).askedYear, null);
});
