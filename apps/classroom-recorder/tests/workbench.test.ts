import assert from "node:assert/strict";
import { test } from "node:test";

import * as W from "../src/server/workbench";

const HOUR = 3_600_000;
const sh = (iso: string) => Date.parse(`${iso}+08:00`);

test("月份按上海时间切，窗口是往前 3 个月到下个月", () => {
  assert.equal(W.monthOf(sh("2026-10-31T23:30:00")), "2026-10");
  assert.equal(W.monthOf(sh("2026-11-01T00:10:00")), "2026-11");
  assert.deepEqual(W.monthRange("2026-12"), [sh("2026-12-01T00:00:00"), sh("2027-01-01T00:00:00")]);
  assert.equal(W.addMonths("2026-01", -1), "2025-12");
  assert.deepEqual(W.windowMonths(sh("2026-10-30T14:00:00")), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
  const now = sh("2026-10-30T14:00:00");
  assert.equal(W.staleAfter("2026-10", now), 10 * 60_000);
  assert.equal(W.staleAfter("2026-11", now), 10 * 60_000);
  assert.equal(W.staleAfter("2026-08", now), 24 * HOUR);
  assert.equal(W.staleAfter("2026-08", now, true), 60_000);
});

test("课表记录：关联学员、课程多选、试听、取消", () => {
  const row = W.parseLesson({ record_id: "rec1", fields: {
    学生: { link_record_ids: ["recA", "recB"] }, 老师课程ID: { type: 1, value: [{ text: "15:30-16:30｜张三｜IG数学｜班课" }] }, 课程类型: ["IG数学"],
    老师: "牛", 上课时间: sh("2026-10-20T15:30:00"), 下课时间: sh("2026-10-20T16:30:00"), 上课地点: "滨江", 授课类型: "班课", 临时取消: "2h-50%", 价格优惠: "试听-80%",
  } });
  assert.deepEqual(row, ["rec1", sh("2026-10-20T15:30:00"), sh("2026-10-20T16:30:00"), ["recA", "recB"], "张三", "IG数学", "牛", "滨江", "班课", "2h-50%", 1]);
  // 没有下课时间按课程时长；没有上课时间不算课
  const noEnd = W.parseLesson({ record_id: "rec2", fields: { 上课时间: sh("2026-10-21T10:00:00"), 课程时长: "2", 课程类型: ["IG物理"] } });
  assert.equal(noEnd![2] - noEnd![1], 2 * HOUR);
  assert.equal(W.parseLesson({ record_id: "rec3", fields: {} }), null);
  // 排课占位和整天的空行不算课
  assert.equal(W.parseLesson({ record_id: "rec4", fields: { 上课时间: sh("2026-10-21T00:00:00"), 课程类型: ["空出"], 老师: "牛" } }), null);
  assert.equal(W.parseLesson({ record_id: "rec5", fields: { 上课时间: sh("2026-10-21T00:00:00") } }), null);
  // 开会、考试、取消的课不算老师给他上过课
  assert.equal(W.isTeaching(row!), false);
  assert.equal(W.isTeaching([...row!.slice(0, 9), "", 0] as W.LessonRow), true);
  assert.equal(W.isTeaching([...row!.slice(0, 5), "申请规划跟进会议", ...row!.slice(6, 9), "", 0] as W.LessonRow), false);
});

test("学员信息：年级按学制显示，老师看不到提成字段，阶段从排课提醒里取", () => {
  const s = W.parseRoster({ record_id: "recA", fields: { 学生姓名: "张三", 学制: "13 年制", 当前学员年级: { type: 2, value: [12] }, "归属老师(20%)": "牛", 渠道信息: "转介绍", 在读: "在读" } });
  assert.equal(s.grade, "Year 12");
  assert.equal("ownerTeacher" in W.forTeacher(s) || "channel" in W.forTeacher(s), false);
  assert.equal(W.stageOf({ remind: "🤔试听安排", status: "" }, null, false), "试听");
  assert.equal(W.stageOf({ remind: "暂时结课🍵", status: "在读" }, null, true), "暂停");
  assert.equal(W.stageOf({ remind: "结课🔚", status: "" }, null, false), "结课");
  assert.equal(W.stageOf({ remind: "✅ 完成排课", status: "" }, null, true), "在读");
  assert.equal(W.stageOf({ remind: "结课🔚", status: "" }, "在读", false), "在读"); // 工作台里改过的优先
  assert.deepEqual(W.rosterFields({ name: "李四", grade: "Year 10", system: "13 年制", school: "惠立" }), { 学生姓名: "李四", 在读: "在读", 所读学校: "惠立", 学制: "13 年制", "学生年级-初始记录": 10 });
});

const report = (mastery: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
  topic: "圆周运动", lead: "", content: [], mastery: mastery.map(([name, status]) => ({ name, status, evidence: "" })),
  performance: "很投入", issue: { title: "把向心力当成独立的力。", fix: "先画受力图" }, homework: "练习 1", review: "", next: "讲万有引力", questions: [{ time: 1, text: "为什么？", answer: "" }], ...extra,
}) as any;

test("学情报告：掌握情况和单节学情", () => {
  assert.equal(W.masteryKey(report([["a", "基本掌握"], ["b", "本课已学习"]])), "g");
  assert.equal(W.masteryKey(report([["a", "需要巩固"], ["b", "基本掌握"]])), "a");
  assert.equal(W.masteryKey(report([["a", "需要巩固"], ["b", "需要巩固"], ["c", "基本掌握"]])), "r");
  const rep = W.repOf(report([["a", "需要巩固"], ["b", "基本掌握"]]));
  assert.deepEqual(rep.kps, [["a", "需要巩固"], ["b", "已掌握"]]);
  assert.equal(rep.issue, "把向心力当成独立的力。先画受力图。");
  assert.deepEqual(rep.qs, ["为什么？"]);
});

test("月报：好和要巩固按每个知识点最后一次的状态，模型只写两句", () => {
  const lessons = [
    { date: "10/26", report: report([["受力分析", "基本掌握"], ["临界速度", "需要巩固"]]) },
    { date: "10/19", report: report([["受力分析", "需要巩固"], ["周期", "基本掌握"]]) },
  ];
  assert.deepEqual(W.monthPoints(lessons), { good: ["受力分析", "周期"], weak: ["临界速度"] });
  const prompt = W.monthPrompt({ student: "张三", course: "物理", month: "2026-10", lessons, total: 4, cancelled: 1 });
  assert.match(prompt.user, /取消 1 节/);
  const rep = W.parseMonthRep('```json\n{"sum":"讲了圆周运动—受力分析。","adv":"先练受力图。","good":["乱写"]}\n```', prompt);
  assert.equal(rep.sum, "讲了圆周运动，受力分析。");
  assert.deepEqual(rep.good, ["受力分析", "周期"]);
  assert.throws(() => W.parseMonthRep('{"sum":""}', prompt));
});

test("画像建议：只收词表里的、两节课以上证据的、没忽略过的", () => {
  const input = { lessons: [], persona: { 学习偏好: { tags: ["例子先行"] } }, ignored: [{ key: "沟通注意", tag: "慢热" }] };
  const raw = JSON.stringify({ items: [
    { key: "学习偏好", tag: "专注 40 分钟左右", why: "10/22、10/26 两节课都在 40 分钟后变慢" },
    { key: "学习偏好", tag: "例子先行", why: "10/22、10/26" },              // 已经有了
    { key: "沟通注意", tag: "慢热", why: "10/22、10/26" },                  // 30 天内忽略过
    { key: "沟通注意", tag: "答错时会沉默", why: "10/26 一次" },             // 只有一节课
    { key: "家长沟通", tag: "微信", why: "10/22、10/26" },                  // 课上看不出来的不提
    { key: "沟通注意", tag: "情绪低落", why: "10/22、10/26" },               // 不在词表
  ] });
  assert.deepEqual(W.parseSuggestions(raw, input), [{ key: "学习偏好", tag: "专注 40 分钟左右", why: "10/22、10/26 两节课都在 40 分钟后变慢" }]);
  assert.equal(W.suggestBasis(["rec2", "rec1"]), "2:rec2");
});

test("成绩单识别：只留有科目和成绩的行，日期不对就空着", () => {
  const rows = W.parseGradeRows(JSON.stringify({ rows: [
    { date: "2026-10-15", exam: "期中考试", subject: "IG物理", score: "A*" },
    { date: "10/15", exam: "期中考试", subject: "IG数学", score: 7 },
    { date: "", exam: "", subject: "出勤", score: "" },
  ] }));
  assert.deepEqual(rows, [
    { date: "2026-10-15", exam: "期中考试", subject: "IG物理", score: "A*" },
    { date: "", exam: "期中考试", subject: "IG数学", score: "7" },
  ]);
});

test("家长收集表：只收三块里词表的标签，和老师写的合在一起", () => {
  const persona = { 家长沟通: { tags: ["微信"], text: "妈妈管学习", src: "教务 小周 10/02" } };
  const out = W.mergeForm(persona, {
    家长沟通: { tags: ["微信", "对考试焦虑", "乱写的"], text: "晚上九点后方便" },
    沟通注意: { tags: ["慢热"], text: "不该由家长填" },
    辅导经历: { tags: [], text: "" },
  }, "妈妈填的收集表 10/30");
  assert.deepEqual(out.家长沟通, { tags: ["微信", "对考试焦虑"], text: "妈妈管学习；家长：晚上九点后方便", src: "妈妈填的收集表 10/30" });
  assert.equal("沟通注意" in out, false);
  assert.equal("辅导经历" in out, false);
});
