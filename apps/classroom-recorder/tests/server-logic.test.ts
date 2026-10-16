import assert from "node:assert/strict";
import test from "node:test";

import * as L from "../src/server/logic";
import type { LessonDoc } from "../src/server/logic";

// 2026-10-15 13:30 上海 = 05:30 UTC
const START = Date.UTC(2026, 9, 15, 5, 30);

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

test("时间轴与学生提问：时间转成秒、重叠截断、未知知识点和环节类型被纠正；旧提示词没输出也能出报告", () => {
  const out = validJson() as any;
  out.report.timeline = [
    { phase: "讲解", title: "配方法", start: "05:00", end: "20:00", points: ["配方法", "不存在的知识点"] },
    { phase: "开场", title: "寒暄", start: "00:00", end: "05:30", points: [] },
    { phase: "练习", title: "真题", start: "18:00", end: "65:10", points: ["配方法"] },
    { phase: "练习", title: "坏时间", start: "30:00", end: "29:00", points: [] },
  ];
  out.report.questions = [{ time: "12:05", text: "为什么要配方？", answer: "顶点式能直接看出顶点" }, { time: "?", text: "  " }];
  const r = L.parseSummary(JSON.stringify(out)).report;
  assert.deepEqual(r.timeline, [
    { phase: "其他", title: "寒暄", start: 0, end: 330, points: [] },
    { phase: "讲解", title: "配方法", start: 330, end: 1200, points: ["配方法"] },
    { phase: "练习", title: "真题", start: 1200, end: 3910, points: ["配方法"] },
  ]);
  assert.deepEqual(r.questions, [{ time: 725, text: "为什么要配方？", answer: "顶点式能直接看出顶点" }]);
  const old = L.parseSummary(JSON.stringify(validJson())).report;
  assert.deepEqual([old.timeline, old.questions], [[], []]);
});

test("流水线推进：齐了就合并；缺段等到下课 2 小时后带缺失时长继续；失败最多重试 3 次", () => {
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
  // App 没发 finish：课表下课 2 小时后用已收到的分段出报告
  const orphan = { ...queued, stage: "recording" as const, finish: undefined };
  assert.deepEqual(L.nextStep(orphan, endedAt + L.MISSING_GRACE_MS - 1), { action: "none" });
  assert.deepEqual(L.nextStep(orphan, endedAt + L.MISSING_GRACE_MS), { action: "merge", seqs: [0, 2], gapMinutes: 0 });
  // 断网很久的 App 正在补传（最近有分段到达）：先不抢着出报告
  const uploading = { ...orphan, updatedAt: endedAt + L.MISSING_GRACE_MS + 60_000 };
  assert.deepEqual(L.nextStep(uploading, endedAt + L.MISSING_GRACE_MS + 120_000), { action: "none" });
  assert.deepEqual(L.nextStep(uploading, uploading.updatedAt + L.ORPHAN_QUIET_MS), { action: "merge", seqs: [0, 2], gapMinutes: 0 });
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
  const [system, user] = L.summaryMessages(meta, "[说话人1 00:00-00:05] 你好", false);
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
