import assert from "node:assert/strict";
import test from "node:test";

import * as L from "../src/server/logic";
import type { LessonDoc } from "../src/server/logic";

// 2026-10-15 13:30 上海 = 05:30 UTC
const START = Date.UTC(2026, 9, 15, 5, 30);
const HOUR_MS = 3_600_000;

const record = (fields: Record<string, unknown>) => ({ record_id: "recA", fields: { 上课时间: START, ...fields } });

test("课表记录 → Lesson：学生取自老师课程ID，下课时间优先，数字可为字符串", () => {
  const parsed = L.parseScheduleRecord(record({
    老师: "王老师",
    课程类型: "IG数学",
    上课地点: "线下 3 号教室",
    下课时间: START + 90 * 60_000,
    课程时长: { type: 2, value: ["1.5"] },
    老师课程ID: { type: 1, value: [{ type: "text", text: "13:30-15:00｜张浩然｜IG数学｜1v1" }] },
    学生: { link_record_ids: ["recStudent"] },
  }))!;
  assert.equal(parsed.student, "张浩然");
  assert.equal(parsed.cancelled, false);
  const lesson = L.toLesson(parsed, undefined, "https://x/report.html");
  assert.deepEqual(
    { date: lesson.date, start: lesson.start, end: lesson.end, title: lesson.title, topic: lesson.topic, status: lesson.status },
    { date: "2026-10-15", start: "13:30", end: "15:00", title: "IG数学 · 张浩然", topic: "线下 3 号教室", status: "upcoming" },
  );

  // 没有下课时间时用 课程时长（字符串）推算；请假前缀不影响学生名；临时取消非空 = cancelled
  const cancelled = L.parseScheduleRecord(record({ 上课时间: String(START), 课程时长: "2", 临时取消: "2h-50%", 老师课程ID: "请假 50%｜13:30-15:30｜小雨｜IG物理｜" }))!;
  assert.equal(cancelled.endAt, START + 2 * L.HOUR);
  assert.equal(cancelled.student, "小雨");
  assert.equal(L.toLesson(cancelled, undefined, "").status, "cancelled");
  assert.equal(L.studentFromLabel("20:00｜例会｜"), "");
  assert.equal(L.parseScheduleRecord(record({ 上课时间: null })), null);
});

test("数据库文档叠加：recording / processing / done，done 才给总结与报告链接（老师改过的优先）", () => {
  const schedule = L.parseScheduleRecord(record({ 课程类型: "IG数学", 临时取消: "0h-70%" }))!;
  const doc = (stage: L.Stage, extra: Partial<LessonDoc> = {}) => ({ stage, copied: false, ...extra }) as LessonDoc;
  assert.equal(L.toLesson(schedule, doc("recording"), "").status, "recording");
  for (const stage of ["queued", "transcribing", "summarizing", "failed"] as const) assert.equal(L.toLesson(schedule, doc(stage), "").status, "processing");
  const done = L.toLesson(schedule, doc("done", { summary: "AI 版", editedSummary: "老师版", reportToken: "tok", copied: true, report: { topic: "二次函数" } as L.ClassReport }), "https://app/report.html");
  assert.deepEqual(
    { status: done.status, summary: done.summary, reportUrl: done.reportUrl, copied: done.copied, topic: done.topic },
    { status: "done", summary: "老师版", reportUrl: "https://app/report.html?t=tok", copied: true, topic: "二次函数" },
  );
  assert.equal(L.toLesson(schedule, doc("queued", { summary: "x" }), "").summary, undefined);
});

test("转写格式：说话人从 1 开始、分钟不按小时回绕；ResultDetail 缺失时解析文本格式", () => {
  const text = L.formatTranscript([
    { StartMs: 0, EndMs: 14_200, SpeakerId: 0, FinalSentence: "今天讲二次函数。" },
    { StartMs: 3_661_000, EndMs: 3_665_000, SpeakerId: 1, FinalSentence: " " },
    { StartMs: 3_661_000, EndMs: 3_665_000, SpeakerId: 1, FinalSentence: "老师这里怎么配方？" },
  ]);
  assert.equal(text, "[说话人1 00:00-00:14] 今天讲二次函数。\n[说话人2 61:01-61:05] 老师这里怎么配方？");
  assert.equal(L.formatTranscript([], "[0:1.020,0:3.500,1]  好的"), "[说话人2 00:01-00:03] 好的");
  const chunks = L.chunkTranscript(["a".repeat(6), "b".repeat(6), "c".repeat(6)].join("\n"), 13);
  assert.deepEqual(chunks, ["aaaaaa\nbbbbbb", "cccccc"]);
});

const validJson = () => ({
  parentSummary: "浩然家长您好，今天（10月15日）的IG数学课向您汇报一下：\n\n【今天学了什么】\n1. 配方法\n\n【课堂表现】\n**很好**\n\n【课后建议】\n练习\n\n有任何问题欢迎随时联系我～",
  report: {
    topic: "二次函数", lead: "配方熟练", content: ["1. 三种形式", "配方法"],
    mastery: [{ name: "配方法", status: "基本掌握", evidence: "独立完成" }],
    performance: "进步明显", issue: { title: "漏看条件", fix: "圈出条件" }, homework: "作业", review: "复习", next: "二次不等式",
  },
});

test("大模型 JSON：容忍代码块、去掉 markdown 和编号；缺字段或状态越界报错", () => {
  const parsed = L.parseSummary("```json\n" + JSON.stringify(validJson()) + "\n```");
  assert.ok(parsed.parentSummary.includes("很好") && !parsed.parentSummary.includes("**"));
  assert.deepEqual(parsed.report.content, ["三种形式", "配方法"]);
  assert.equal(parsed.report.mastery[0].status, "基本掌握");

  const badStatus = validJson();
  badStatus.report.mastery[0].status = "4/5";
  assert.throws(() => L.parseSummary(JSON.stringify(badStatus)), /status/);
  const noHeading = validJson();
  noHeading.parentSummary = "家长您好";
  assert.throws(() => L.parseSummary(JSON.stringify(noHeading)), /【今天学了什么】/);
  const noIssue = validJson() as any;
  delete noIssue.report.issue;
  assert.throws(() => L.parseSummary(JSON.stringify(noIssue)), /issue/);
  assert.throws(() => L.parseSummary("抱歉，我无法完成"), /JSON/);
});

// 一节 2 小时的课：课前 5 分钟、闲聊、课间 20 分钟，时间是录音里的秒
const seg = (start: string, end: string, kind: string, title = kind) => ({ start, end, kind, title, detail: `${title}的说明` });
const archiveJson = () => ({
  segments: [
    seg("00:00", "05:00", "课前"),
    seg("05:00", "20:00", "学习规划", "试卷分析"),
    seg("20:00", "40:00", "讲题", "第 1 题"),
    seg("39:00", "50:00", "课堂交流", "聊游戏"), // 和上一段重叠 1 分钟
    seg("50:30", "60:00", "讲解", "配方法"), // 和上一段空 30 秒
    seg("60:00", "80:00", "课间休息"),
    seg("80:00", "100:00", "练习", "第 2 题"),
    seg("100:00", "125:00", "复习总结", "总结"),
    seg("125:00", "126:00", "课后"),
    seg("130:00", "129:00", "讲题", "坏时间"),
  ],
  moments: [{ time: "21:00", type: "答对", text: "X=3" }, { time: "45:00", type: "提问", text: "你玩什么游戏？" }, { time: "?", type: "答错", text: "" }],
  facts: [
    { time: "59:00", type: "下节课", text: "下半节讲应用题" },
    { time: "110:00", type: "作业", text: "第 3 题再做一遍" },
    { time: "120:00", type: "下节课", text: "下次讲二次不等式" },
  ],
});

test("课堂时间档案：重叠截断、小空当并进前一段、类别不认识算闲聊；空当太多报错重试；统计只算第一句到最后一句", () => {
  const a = L.parseArchive("```json\n" + JSON.stringify(archiveJson()) + "\n```");
  assert.deepEqual(a.segments.map((s) => [s.start / 60, s.end / 60, s.kind]), [
    [0, 5, "课前"], [5, 20, "学习规划"], [20, 40, "讲题"], [40, 50.5, "课堂交流"], [50.5, 60, "讲解"],
    [60, 80, "课间休息"], [80, 100, "练习"], [100, 125, "复习总结"], [125, 126, "课后"],
  ]);
  assert.deepEqual(a.stats, { first: 300, last: 7500, learn: 5370, brk: 1200, chat: 630, share: 5370 / 6000 });
  assert.equal(a.moments.length, 2);
  assert.deepEqual(L.archiveFacts(a), { homework: ["第 3 题再做一遍"], next: ["下次讲二次不等式"] }); // 「下半节」在最后 30 分钟之前，不算

  const gappy = archiveJson();
  gappy.segments.splice(2, 1); // 漏掉 20 分钟
  assert.throws(() => L.parseArchive(JSON.stringify(gappy)), /20 分钟没有归进/);
  // 空当里没人说话（安静做题、课间）不算漏切，并进前一段
  const quiet = L.parseArchive(JSON.stringify(gappy), "[老师 05:00-05:10] 先看试卷\n[学生 50:40-50:45] 配方");
  assert.deepEqual(quiet.segments.slice(1, 3).map((s) => [s.start / 60, s.end / 60]), [[5, 39], [39, 50.5]]);
  assert.throws(() => L.parseArchive(JSON.stringify(gappy), "[老师 25:00-25:10] 第 1 题"), /19 分钟没有归进/);
  const odd = archiveJson();
  odd.segments[1].kind = "开场";
  assert.equal(L.parseArchive(JSON.stringify(odd)).segments[1].kind, "课堂交流");
  // 超长的课分段抽：各段直接拼起来
  const [x, y] = [archiveJson(), archiveJson()];
  x.segments = x.segments.slice(0, 4);
  y.segments = y.segments.slice(4);
  assert.equal(L.parseArchive([JSON.stringify(x), JSON.stringify(y)]).segments.length, 9);
});

test("写报告只拿学习环节：闲聊、课前课后、闲聊里的提问都不交给模型；作业和下节课由程序填", () => {
  const a = L.parseArchive(JSON.stringify(archiveJson()));
  const [, user] = L.reportMessages({ student: "浩然", course: "IG数学", teacher: "王芳", monthDay: "10月15日" }, a);
  assert.match(user.content, /第 1 题/);
  assert.doesNotMatch(user.content, /聊游戏|你玩什么游戏|课前的说明|课间休息的说明/);
  assert.match(user.content, /作业：第 3 题再做一遍\n下节课：下次讲二次不等式/);
  const parsed = L.parseSummary(JSON.stringify(validJson()));
  const r = L.assembleReport(parsed.report, a, "坏输出");
  assert.equal(r.homework, "第 3 题再做一遍");
  assert.equal(r.next, "下次讲二次不等式");
  const none = L.assembleReport(parsed.report, { ...a, facts: [] }, "");
  assert.deepEqual([none.homework, none.next], ["课上没有明确布置作业", "具体内容待老师安排"]);
});

test("章节：不合格说清原因让模型重试；仍不合格由程序修正（接上编号、跨课间拆开、类别兜底、多于 12 章合并）", () => {
  const a = L.parseArchive(JSON.stringify(archiveJson()));
  const ch = (chapters: unknown[]) => JSON.stringify({ chapters });
  // 学习环节 0 试卷分析、1 第 1 题、2 配方法 | 课间 | 3 第 2 题、4 总结：共 5 个，章数 5–5
  const good = ch([
    { from: 0, to: 0, cat: "学习规划", title: "试卷分析", point: "随便" },
    { from: 1, to: 1, cat: "错题讲评", title: "第 1 题", point: "配方法" },
    { from: 2, to: 2, cat: "新知讲解", title: "配方法", point: "不在列表" },
    { from: 3, to: 3, cat: "当堂练习", title: "第 2 题", point: "判别式" },
    { from: 4, to: 4, cat: "方法总结", title: "总结", point: "配方法" },
  ]);
  assert.equal(L.chapterProblem(good, a), "");
  assert.match(L.chapterPrompt(a, ["配方法", "判别式"]), /2. 50:30–60:00 讲解｜配方法｜配方法的说明\n—— 课间休息 ——\n3. 80:00/);
  const built = L.buildChapters(good, a, ["配方法", "判别式"]);
  assert.deepEqual(built.map((c) => [c.start / 60, c.end / 60, c.real / 60, c.cat, c.point]), [
    [5, 20, 15, "学习规划", "试卷分析与学习规划"],
    [20, 50.5, 20, "错题讲评", "配方法"], // 闲聊并进前一章
    [50.5, 60, 9.5, "新知讲解", "配方法"], // 知识点不认识，沿用上一章的；课间不单列，停在课间开始
    [80, 100, 20, "当堂练习", "判别式"],
    [100, 125, 25, "方法总结", "配方法"],
  ]);

  // 闲聊多的课：每章就是学习环节的真实起止，不挂闲聊
  const chatty = { ...a, stats: { ...a.stats, share: 0.5 } };
  assert.deepEqual(L.buildChapters(good, chatty, ["配方法"]).slice(0, 2).map((c) => [c.start / 60, c.end / 60]), [[5, 20], [20, 40]]);

  const crossing = ch([{ from: 0, to: 4, cat: "上课", title: "整节课", point: "配方法" }]);
  assert.match(L.chapterProblem(crossing, a), /必须是 5–5 章/);
  const fixed = L.buildChapters(crossing, a, ["配方法"]);
  assert.deepEqual(fixed.map((c) => [c.start / 60, c.end / 60, c.cat]), [[5, 60, "例题精讲"], [80, 125, "例题精讲"]]);
  assert.equal(L.buildChapters("不是 JSON", a, ["配方法"]).length, 2);

  // 40 个学习环节归成 20 章：程序把最短的并进相邻较长的，直到 12 章
  const many = { segments: Array.from({ length: 40 }, (_, i) => seg(`${i * 3}:00`, `${i * 3 + 3}:00`, "讲题", `题${i}`)), moments: [], facts: [] };
  const big = L.parseArchive(JSON.stringify(many));
  const twenty = ch(Array.from({ length: 20 }, (_, i) => ({ from: i * 2, to: i * 2 + 1, cat: "例题精讲", title: `章${i}`, point: "配方法" })));
  assert.match(L.chapterProblem(twenty, big), /20 章，必须是 8–12 章/);
  const merged = L.buildChapters(twenty, big, ["配方法"]);
  assert.equal(merged.length, 12);
  assert.equal(merged.reduce((sum, c) => sum + c.real, 0), 40 * 180);
});

test("家长页时间：学习占比够 70% 按课堂时长摊开、否则只算学习时间（课间照样摊）；比计划多 3 分钟以上才显示；分钟数加起来不差", () => {
  const a = L.parseArchive(JSON.stringify(archiveJson()));
  const chapters = L.buildChapters(JSON.stringify({ chapters: [
    { from: 0, to: 0, cat: "学习规划", title: "试卷分析", point: "" },
    { from: 1, to: 2, cat: "错题讲评", title: "第 1 题", point: "配方法" },
    { from: 3, to: 4, cat: "当堂练习", title: "第 2 题", point: "判别式" },
  ] }), a, ["配方法", "判别式"]);
  const doc = { archive: a, report: { chapters } as L.ClassReport, startAt: START, endAt: START + 115 * 60_000, finish: { startedAt: new Date(START - 5 * 60_000).toISOString(), endedAt: "", segments: [] } };
  const c = L.lessonClock(doc)!;
  assert.deepEqual([c.full, c.total, c.over], [true, 120, 5]); // 05:00–125:00，比计划 115 分钟多 5
  assert.deepEqual(c.cats, [["错题讲评", 40], ["当堂练习", 60], ["学习规划", 20]]);
  assert.equal(c.points.reduce((sum, [, n]) => sum + n, 0), 120);
  const data = L.reportData({ ...doc, student: "浩然", course: "IG数学", teacherName: "王芳" } as unknown as LessonDoc);
  assert.deepEqual([data.time, data.mins], ["13:30–15:30", 120]);

  const chatty = { ...a, stats: { ...a.stats, share: 0.45 } };
  const low = L.lessonClock({ ...doc, archive: chatty })!;
  assert.deepEqual([low.full, low.total, low.over], [false, Math.round((a.stats.learn + a.stats.brk) / 60), 0]);
  assert.equal(L.lessonClock({ ...doc, endAt: START + 118 * 60_000 })!.over, 0);
  assert.equal(L.lessonClock({ ...doc, archive: null }), undefined);
  assert.deepEqual(L.apportion([["a", 1], ["b", 1], ["c", 1]], 10), [["a", 4], ["b", 3], ["c", 3]]);
});

test("学生提问：只收像问题的（6 字以上、带问号或疑问词）", () => {
  const out = validJson() as any;
  out.report.questions = [{ time: "12:05", text: "为什么要配方？", answer: "顶点式能直接看出顶点" }, { time: "13:00", text: "选 dog" }, { time: "?", text: "这个忘记除 2 了" }];
  assert.deepEqual(L.parseSummary(JSON.stringify(out)).report.questions, [{ time: 725, text: "为什么要配方？", answer: "顶点式能直接看出顶点" }]);
  assert.deepEqual(L.parseSummary(JSON.stringify(validJson())).report.questions, []);
});

test("流水线推进：齐了就合并；缺段等到下课 2 小时后带缺失时长继续；App 不传了云端收尾；失败最多重试 3 次", () => {
  const seg = (seq: number) => ({ seq, sha256: `h${seq}`, bytes: 100 });
  const stored = { "0": { sha256: "h0", bytes: 100, fileId: "f0" }, "2": { sha256: "h2", bytes: 100, fileId: "f2" } };
  const endedAt = Date.UTC(2026, 9, 15, 7, 0);
  const queued = { stage: "queued" as const, attempts: 0, endAt: endedAt, updatedAt: endedAt, segments: stored, finish: { startedAt: "", endedAt: new Date(endedAt).toISOString(), segments: [seg(0), seg(1), seg(2), seg(3), seg(4)] } };

  assert.deepEqual(L.missingSeqs(queued.finish.segments, stored), [1, 3, 4]);
  assert.deepEqual(L.nextStep(queued, endedAt + L.MISSING_GRACE_MS - 1), { action: "wait" });
  assert.deepEqual(L.nextStep(queued, endedAt + L.MISSING_GRACE_MS), { action: "merge", seqs: [0, 2], gapMinutes: 2 });
  const complete = { ...queued, finish: { ...queued.finish, segments: [seg(0), seg(2)] } };
  assert.deepEqual(L.nextStep(complete, endedAt), { action: "merge", seqs: [0, 2], gapMinutes: 0 });
  // 同一序号内容变了也算缺
  assert.deepEqual(L.missingSeqs([{ seq: 0, sha256: "other", bytes: 1 }], stored), [0]);

  assert.deepEqual(L.nextStep({ ...queued, stage: "transcribing" }, 0), { action: "poll" });
  assert.deepEqual(L.nextStep({ ...queued, stage: "summarizing" }, 0), { action: "summarize" });
  assert.deepEqual(L.nextStep({ ...queued, stage: "recording" }, 0), { action: "none" });
  // App 没发 finish（合盖睡着、关机、退出）：课表里的课下课后、分段停传 15 分钟，用已收到的分段出报告
  const orphan = { ...queued, stage: "recording" as const, kind: "lesson" as const, finish: undefined, updatedAt: endedAt - 60_000 };
  assert.deepEqual(L.nextStep(orphan, endedAt - 1), { action: "none" }); // 下课前不判断：上课中途断网，App 会补传
  assert.deepEqual(L.nextStep(orphan, orphan.updatedAt + L.ORPHAN_QUIET_MS - 1), { action: "none" });
  assert.deepEqual(L.nextStep(orphan, orphan.updatedAt + L.ORPHAN_QUIET_MS), { action: "merge", seqs: [0, 2], gapMinutes: 0 });
  // 拖堂还在传：最近有分段到达就不抢
  const dragging = { ...orphan, updatedAt: endedAt + 20 * 60_000 };
  assert.deepEqual(L.nextStep(dragging, endedAt + 30 * 60_000), { action: "none" });
  assert.deepEqual(L.nextStep(dragging, dragging.updatedAt + L.ORPHAN_QUIET_MS), { action: "merge", seqs: [0, 2], gapMinutes: 0 });
  // 随时录制没有计划下课时间：30 分钟没分段就算结束（建档时的占位下课时间不管）
  const adhoc = { ...orphan, kind: "adhoc" as const, endAt: endedAt + 3 * L.HOUR };
  assert.deepEqual(L.nextStep(adhoc, adhoc.updatedAt + L.ADHOC_QUIET_MS - 1), { action: "none" });
  assert.deepEqual(L.nextStep(adhoc, adhoc.updatedAt + L.ADHOC_QUIET_MS), { action: "merge", seqs: [0, 2], gapMinutes: 0 });
  assert.deepEqual(L.nextStep({ ...queued, stage: "done" }, 0), { action: "none" });
  assert.deepEqual(L.nextStep({ ...queued, stage: "failed", failedStage: "summarizing", attempts: 2 }, 0), { action: "retry", stage: "summarizing" });
  assert.deepEqual(L.nextStep({ ...queued, stage: "failed", failedStage: "summarizing", attempts: 3 }, 0), { action: "none" });
});

test("上海时区的 7 天窗口与报告数据", () => {
  // 上海 10-15 00:30 = UTC 10-14 16:30，窗口仍以上海 10-15 为今天
  const { from, to } = L.lessonWindow(Date.UTC(2026, 9, 14, 16, 30));
  assert.equal(L.shDate(from), "2026-10-08");
  assert.equal(L.shTime(from), "00:00");
  assert.equal(L.shDate(to), "2026-10-17");
  assert.equal(L.shMonthDay(START), "10月15日");

  const data = L.reportData({
    student: "张浩然", course: "IG数学", teacherName: "王芳", startAt: START, endAt: START + 90 * 60_000, gapMinutes: 3,
    finish: { startedAt: new Date(START - 3 * 60_000).toISOString(), endedAt: new Date(START + 95 * 60_000).toISOString(), segments: [] },
  } as unknown as LessonDoc);
  assert.deepEqual(
    { date: data.date, time: data.time, mins: data.mins, gapMinutes: data.gapMinutes },
    { date: "2026-10-15", time: "13:30–15:00", mins: 98, gapMinutes: 3 },
  );
});

test("提示词：占位符换成本课信息；标题校验跟着家长总结提示词走", () => {
  const meta = { student: "浩然", course: "IG数学", teacher: "徐翰超", monthDay: "10月15日" };
  const [system, user] = L.reportMessages(meta, L.parseArchive(JSON.stringify(archiveJson())));
  assert.match(system.content, /说话人N/);
  assert.match(user.content, /今天（10月15日）的IG数学课/);
  assert.match(user.content, /「浩然家长您好」/);
  assert.match(user.content, /\{称呼\}/);
  assert.deepEqual(L.promptHeadings(L.DEFAULT_PROMPTS), ["【今天学了什么】", "【课堂表现】", "【课后建议】"]);

  const custom = { ...L.DEFAULT_PROMPTS, parent: "分两段：【本课收获】【回家练习】" };
  const out = validJson();
  out.parentSummary = "家长您好\n\n【本课收获】\n配方\n\n【回家练习】\n练习";
  assert.equal(L.parseSummary(JSON.stringify(out), L.promptHeadings(custom)).parentSummary, out.parentSummary);
  assert.throws(() => L.parseSummary(JSON.stringify(out)), /【今天学了什么】/);
});

test("区分老师：只认转写里存在的编号，判成全员老师等于没判断，标签按编号替换", () => {
  const t = "[说话人1 00:00-00:14] 今天讲二次函数。\n[说话人2 00:15-00:20] 好的。\n[说话人3 00:21-00:30] 先看顶点式。";
  assert.deepEqual([...L.speakerStats(t)].map(([id, s]) => [id, s.secs, s.lines]), [[1, 14, 1], [2, 5, 1], [3, 9, 1]]);
  assert.deepEqual(L.parseTeacher('```json\n{"teacher":[1,3,9]}\n```', t), [1, 3]);
  assert.deepEqual(L.parseTeacher('{"teacher":[1,2,3]}', t), []);
  assert.deepEqual(L.parseTeacher("不是 JSON", t), []);
  assert.equal(L.labelSpeakers(t, [1, 3]), "[老师 00:00-00:14] 今天讲二次函数。\n[学生 00:15-00:20] 好的。\n[老师 00:21-00:30] 先看顶点式。");
  assert.equal(L.labelSpeakers(t, []), t);
  assert.match(L.teacherPrompt(t), /说话人1：1 句/);
});

test("随时录制：编号格式、列表里按主题显示、会议纪要必须有三段", () => {
  assert.ok(L.isAdhocId("adhoc-0123456789abcdef"));
  assert.ok(!L.isAdhocId("adhoc-xyz") && !L.isAdhocId("recA"));
  const doc = { _id: "adhoc-0123456789abcdef", course: "教研周会", kind: "meeting", startAt: START, endAt: START + 30 * 60_000, stage: "done", copied: false, summary: "纪要" } as LessonDoc;
  assert.deepEqual(
    (({ title, start, end, status, kind, summary, reportUrl }) => ({ title, start, end, status, kind, summary, reportUrl }))(L.adhocLesson(doc, "https://x/report.html")),
    { title: "教研周会", start: "13:30", end: "14:00", status: "done", kind: "meeting", summary: "纪要", reportUrl: undefined },
  );
  assert.equal(L.adhocLesson({ ...doc, kind: "adhoc", course: "", stage: "queued" }, "").title, "随时录制");
  assert.ok(!L.isAdhocId("adhoc-xyz"));
});

test("会议纪要：议题时间转秒、丢掉坏议题和空板块、缺字段给默认；纯文本由同一份数据拼出", () => {
  const raw = "```json\n" + JSON.stringify({
    title: "教研周会", lead: "定了试讲时间",
    sections: [
      { title: "招聘", items: [{ title: "数学老师", start: "01:00", end: "05:30", conclusion: "下周三试讲" }, { title: "坏时间", start: "9:00", end: "8:00" }] },
      { title: "空板块", items: [] },
    ],
    decisions: [{ text: "下周三试讲", time: "04:10" }, { text: " " }],
    todos: [{ task: "安排教室", owner: "", due: "下周二", time: "x" }],
  }) + "\n```";
  const r = L.parseMeetingReport(raw, L.meetingSpeakers("[说话人1 00:00-00:10] 好\n[说话人2 00:10-00:40] 嗯"));
  assert.deepEqual(r.sections, [{ title: "招聘", items: [{ title: "数学老师", start: 60, end: 330, conclusion: "下周三试讲" }] }]);
  assert.deepEqual([r.decisions, r.todos, r.followups], [[{ text: "下周三试讲", time: 250 }], [{ task: "安排教室", owner: "", due: "下周二", time: null }], []]);
  assert.deepEqual(r.speakers, [["说话人2", 30], ["说话人1", 10]]);
  assert.equal(L.meetingText(r, "10月15日"), "教研周会 · 10月15日 会议纪要\n\n定了试讲时间\n\n【决定】\n1. 下周三试讲\n\n【待办】\n1. 安排教室（下周二）\n\n【待跟进】\n无");
  assert.throws(() => L.parseMeetingReport(JSON.stringify({ title: "a", lead: "b", sections: [] })), /sections/);
});

test("matchTeacher：先认飞书账号，没绑的按唯一姓名认，同名或已绑不认", () => {
  const rows = [
    { name: "郑唯梓", scheduleName: "郑唯梓", openId: "ou_zheng" },
    { name: "包天翊", scheduleName: "包天翊", openId: null },
    { name: "Jack Hou（侯东淳）", scheduleName: "Jack Hou", openId: null },
    { name: "王老师", scheduleName: "王老师", openId: null },
    { name: "王老师", scheduleName: "物理王老师", openId: null },
  ];
  assert.deepEqual(L.matchTeacher(rows, "ou_zheng", "改了名"), { teacher: rows[0], bind: false });
  assert.deepEqual(L.matchTeacher(rows, "ou_bao", " 包天翊 "), { teacher: rows[1], bind: true });
  assert.deepEqual(L.matchTeacher(rows, "ou_hou", "Jack Hou"), { teacher: rows[2], bind: true });
  assert.equal(L.matchTeacher(rows, "ou_x", "王老师"), null);
  assert.equal(L.matchTeacher(rows, "ou_fake", "郑唯梓"), null);
  assert.equal(L.matchTeacher(rows, "ou_x", ""), null);
  assert.equal(L.matchTeacher(rows, "ou_x", "陌生人"), null);
});

test("网页改报告：只改文字；清空必填项保留原文，清空列表项删掉；知识点改名同步到章节", () => {
  const old: L.ClassReport = {
    topic: "二次函数", lead: "能求顶点", content: ["配方法", "判别式"],
    mastery: [{ name: "配方", status: "基本掌握", evidence: "会配" }, { name: "判别式", status: "需要巩固", evidence: "不熟" }],
    performance: "积极", issue: { title: "符号", fix: "多练" }, homework: "作业", review: "复习", next: "下节",
    chapters: [{ start: 0, end: 60, real: 50, cat: "新知讲解", title: "讲配方", point: "配方" }, { start: 60, end: 90, real: 30, cat: "当堂练习", title: "练判别式", point: "判别式" }],
    questions: [{ time: 5, text: "为什么", answer: "因为" }], gapMinutes: 3,
  };
  const out = L.applyReportEdits("lesson", old, {
    topic: "  ", lead: "**能**求顶点", content: ["配方法", ""],
    mastery: [{ name: "completing the square", status: "已掌握", evidence: "" }, { name: "" }],
    chapters: [{ title: "讲 completing the square", start: 99, cat: "学习规划" }], questions: [{ text: "为什么？", answer: "" }],
  }) as L.ClassReport;
  assert.equal(out.topic, "二次函数");
  assert.equal(out.lead, "**能**求顶点");
  assert.deepEqual(out.content, ["配方法"]);
  assert.deepEqual(out.mastery, [{ name: "completing the square", status: "基本掌握", evidence: "会配" }]);
  assert.deepEqual(out.chapters, [
    { start: 0, end: 60, real: 50, cat: "新知讲解", title: "讲 completing the square", point: "completing the square" },
    { start: 60, end: 90, real: 30, cat: "当堂练习", title: "练判别式", point: "判别式" }, // 知识点删了，章节归属不丢时间
  ]);
  assert.deepEqual(out.questions, [{ time: 5, text: "为什么？", answer: "" }]);
  assert.equal(out.gapMinutes, 3);
  assert.equal(out.homework, "作业");
});

test("暂停：暂停的时段从档案里挖出来标成「暂停 N 分钟」，算上课时间不算学习时间；不到 30 秒的不管", () => {
  const a = L.parseArchive(JSON.stringify(archiveJson()));
  const p = L.applyPauses(a, [[45 * 60, 55 * 60]]);
  assert.deepEqual(p.segments.slice(3, 6).map((s) => [s.start / 60, s.end / 60, s.kind, s.title]), [
    [40, 45, "课堂交流", "聊游戏"], [45, 55, "课堂交流", "暂停 10 分钟"], [55, 60, "讲解", "配方法"],
  ]);
  assert.deepEqual([p.stats.learn, p.stats.chat, p.stats.first, p.stats.last], [5370 - 270, 300 + 600, 300, 7500]);
  assert.equal(L.applyPauses(a, [[100, 120]]), a);
  // 课前等学生、课后和家长单聊时的暂停不撑长课堂时长
  assert.equal(L.applyPauses(a, [[0, 280]]), a);
  assert.equal(L.applyPauses(a, [[125 * 60, 200 * 60]]), a);
  // 暂停到录音结束之后：只挖到最后一个环节为止
  assert.equal(L.applyPauses(a, [[124 * 60, 200 * 60]]).segments.at(-1)!.end, 126 * 60);
});

test("合并反馈：几节的档案接成一条时间线（两节之间 5 分钟），时长按各节相加；跨天时列出日期；提示词分节", () => {
  const a = L.parseArchive(JSON.stringify(archiveJson()));
  const recA = START - 5 * 60_000; // 第一句 05:00 = 13:30
  const items = (recB: number) => [
    { lessonId: "recA", archive: a, recStart: recA, plan: 115 * 60 },
    { lessonId: "recB", archive: a, recStart: recB, plan: 115 * 60 },
  ];
  const m = L.mergeArchives(items(START + 175 * 60_000)); // 第二节第一句 16:30
  assert.deepEqual(m.parts!.map((p) => [p.lessonId, p.start, p.end]), [["recA", 0, 7200], ["recB", 7500, 14700]]);
  assert.equal(m.segments.length, 7 + 1 + 7); // 去掉课前课后，中间一段「两节之间」
  assert.deepEqual(m.segments[7], { start: 7200, end: 7500, kind: "课间休息", title: "两节之间", detail: "" });
  assert.deepEqual(m.stats, { first: 0, last: 14700, learn: 2 * 5370, brk: 2 * 1200, chat: 2 * 630, share: 5370 / 6000 });
  assert.deepEqual(L.archiveFacts(m).homework, ["第 3 题再做一遍", "第 3 题再做一遍"]);

  const chapters = L.buildChapters("坏输出", m, ["配方法"]);
  assert.equal(chapters.length, 4); // 课间、两节之间都拆开
  const doc = { student: "浩然", course: "IG数学", teacherName: "王芳", kind: "merged", startAt: START, endAt: START, archive: m, report: { chapters } as L.ClassReport } as unknown as LessonDoc;
  const c = L.lessonClock(doc)!;
  assert.deepEqual([c.total, c.over, c.recStart], [240, 10, START]);
  assert.deepEqual(c.parts!.map((p) => (p.recStart + p.start * 1000 - START) / 60_000), [0, 180]);
  const data = L.reportData(doc);
  assert.deepEqual([data.date, data.time, data.mins], ["2026-10-15", "13:30–15:30、16:30–18:30", 240]);

  const [, user] = L.reportMessages({ student: "浩然", course: "IG数学", teacher: "王芳", monthDay: "10月15日", merged: { labels: L.partLabels(m.parts!, true, true), days: ["10月15日"] } }, m);
  assert.match(user.content, /这是 2 节课合并的一份反馈（10月15日 13:30–15:30、10月15日 16:30–18:30）/);
  assert.doesNotMatch(user.content, /这两次课/);
  assert.match(user.content, /—— 第 2 节 ——\n5\. /);
  assert.match(L.chapterPrompt(m, ["配方法"]), /—— 第 1 节 ——\n0\. [\s\S]*—— 课间休息 ——\n3\. [\s\S]*—— 第 2 节 ——\n5\. /);

  const twoDays = L.mergeArchives(items(START + 24 * 3_600_000 - 5 * 60_000));
  assert.equal(L.reportData({ ...doc, archive: twoDays }).time, "10.15 13:30–15:30、10.16 13:30–15:30");
  const [, user2] = L.reportMessages({ student: "浩然", course: "IG数学", teacher: "王芳", monthDay: "10月16日", merged: { labels: L.partLabels(twoDays.parts!, true), days: ["10月15日", "10月16日"] } }, twoDays);
  assert.match(user2.content, /第一行写成「\{称呼\}，这两次课（10月15日、10月16日）的IG数学课向您汇报一下：」/);

  const row = L.mergedLesson({ _id: "merged-0123456789abcdef", student: "浩然", course: "IG数学", startAt: START, endAt: START + HOUR_MS, stage: "done", sources: ["recA", "recB"], summary: "总结", reportToken: "tok" } as unknown as LessonDoc, "https://x/report.html");
  assert.deepEqual([row.title, row.kind, row.sources, row.status, row.reportUrl], ["浩然 · 合并反馈", "merged", ["recA", "recB"], "done", "https://x/report.html?t=tok"]);
  assert.ok(L.isMergedId(row.id) && !L.isAdhocId(row.id));
});

test("不算录制：不到 5 分钟且说话不到 100 字；失败重试用完才显示「没能生成」", () => {
  const tx = (text: string) => `[说话人1 00:01-00:04] ${text}`;
  assert.equal(L.spokenChars(tx("呵呵。")), 2);
  assert.equal(L.isEmptyRecording(272, tx("呵呵")), true);
  assert.equal(L.isEmptyRecording(299, tx("好".repeat(99))), true);
  assert.equal(L.isEmptyRecording(299, tx("好".repeat(100))), false); // 短但真在讲
  assert.equal(L.isEmptyRecording(300, ""), false); // 5 分钟以上照常处理
  const schedule = { id: "rec1", cancelled: false } as L.ScheduleLesson;
  assert.equal(L.lessonStatus(schedule, { stage: "empty", attempts: 0 }), "empty");
  assert.equal(L.lessonStatus(schedule, { stage: "failed", attempts: 2 }), "processing");
  assert.equal(L.lessonStatus(schedule, { stage: "failed", attempts: L.MAX_ATTEMPTS }), "failed");
});
