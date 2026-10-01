import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSamples,
  groupTally,
  legacySamples,
  parseLesson,
  parseScoreRecord,
  positiveRate,
  subjectsOf,
  tally,
  teachersOf,
} from "@/domain/progress";
import type { Lesson, ScoreRecord } from "@/domain/progress";

test("subjectsOf：课程类型 → 科目", () => {
  assert.deepEqual(subjectsOf("雅思"), ["听力", "阅读", "写作", "口语"]);
  assert.deepEqual(subjectsOf("雅思写作"), ["写作"]);
  assert.deepEqual(subjectsOf("雅思提高班-阅读"), ["阅读"]);
  assert.deepEqual(subjectsOf("雅思冲刺班-口语"), ["口语"]);
  assert.deepEqual(subjectsOf("雅思听力&口语"), ["听力", "口语"]);
  for (const excluded of ["雅思提高班-刷题", "雅思冲刺班-刷题", "自习刷题（雅思）", "雅思刷题班", "雅思试听", "雅思口语试听", "雅思考试", "雅思模考", "雅思笔考", "IG英语", ""]) {
    assert.deepEqual(subjectsOf(excluded), [], excluded);
  }
  assert.equal(subjectsOf("雅思英语"), null);
});

// 2026-09-22 00:00 +08:00，飞书日期字段的真实值
const SEP22 = 1790006400000;
const DAY = 86_400_000;

test("parseScoreRecord 读飞书真实字段形状", () => {
  const record = parseScoreRecord("rec1", {
    写作: "6",
    听力: "6.5",
    学生: [{ record_ids: ["recStu"], table_id: "tblQGkH5DweXpOW8", text: "王雅妮-", text_arr: ["王雅妮-"], type: "text" }],
    已核验: true,
    成绩类型: "实考",
    成绩单: [{ file_token: "x", name: "a.png" }],
    提交人: { email: "", en_name: "排课机器人", id: "ou_x", name: "排课机器人" },
    编号: "1",
    考试日期: SEP22,
  });
  assert.deepEqual(record, {
    id: "rec1",
    no: "1",
    studentId: "recStu",
    studentName: "王雅妮",
    kind: "exam",
    date: "2026-09-22",
    scores: { 听力: 6.5, 写作: 6 },
    attachments: 1,
    verified: true,
    submitter: "排课机器人",
    problems: [],
  });
  assert.deepEqual(parseScoreRecord("rec2", { 听力: "65" }).problems, ["没选学生", "没选成绩类型", "没填考试日期", "听力分数「65」不合法"]);
  assert.deepEqual(parseScoreRecord("rec3", { 学生: [{ record_ids: ["a"] }], 成绩类型: "基线", 考试日期: SEP22 }).problems, ["四科都没填分数"]);
});

test("parseLesson：取消、刷题、无学生不计入；识别不出科目单独报", () => {
  const fields = {
    上课时间: SEP22 + 10 * 3600_000,
    学生: [{ record_ids: ["recA", "recB"], text: "A-" }],
    老师: "王储君",
    课程类型: "雅思提高班-阅读",
  };
  assert.deepEqual(parseLesson(fields), { studentIds: ["recA", "recB"], teacher: "王储君", subjects: ["阅读"], date: "2026-09-22" });
  assert.equal(parseLesson({ ...fields, 临时取消: "2h-50%" }), null);
  assert.equal(parseLesson({ ...fields, 课程类型: "雅思提高班-刷题" }), null);
  assert.equal(parseLesson({ ...fields, 学生: undefined }), null);
  assert.deepEqual(parseLesson({ ...fields, 课程类型: "雅思英语" }), { unknownType: "雅思英语" });
});

let seq = 0;
function score(partial: Partial<ScoreRecord> & Pick<ScoreRecord, "date" | "kind" | "scores">): ScoreRecord {
  seq += 1;
  return { id: `r${seq}`, no: String(seq), studentId: "s1", studentName: "小明", attachments: 1, verified: true, submitter: "", problems: [], ...partial };
}
const lesson = (date: string, teacher: string, subjects: Lesson["subjects"], studentIds = ["s1"]): Lesson => ({ date, teacher, subjects, studentIds });

test("buildSamples：每次实考和上一次比（C 规则），授课窗口 [上次, 本次)", () => {
  const baseline = score({ kind: "baseline", date: "2026-06-01", scores: { 听力: 5, 写作: 5.5 } });
  const exam1 = score({ kind: "exam", date: "2026-07-01", scores: { 听力: 6, 写作: 5.5 } });
  const exam2 = score({ kind: "exam", date: "2026-08-01", scores: { 听力: 5.5 } });
  const lessons = [
    lesson("2026-06-01", "甲", ["听力"]), // 基线当天，算
    lesson("2026-07-01", "乙", ["听力"]), // 实考 1 当天：不算实考 1，算实考 2
    lesson("2026-06-15", "丙", ["听力", "阅读", "写作", "口语"]), // 课程类型「雅思」，全科
    lesson("2026-06-20", "丁", ["写作"], ["s2"]), // 别的学生
  ];
  const { samples, issues } = buildSamples([exam2, baseline, exam1], lessons);
  assert.deepEqual(issues, []);
  const view = samples.map((s) => [s.subject, s.date, s.before, s.after, s.outcome, s.teachers.map((t) => t.name).sort().join("")]);
  assert.deepEqual(view, [
    ["听力", "2026-07-01", 5, 6, "up", "丙甲"],
    ["听力", "2026-08-01", 6, 5.5, "down", "乙"],
    ["写作", "2026-07-01", 5.5, 5.5, "flat", "丙"],
  ]);
});

test("buildSamples：未核验 / 缺成绩单不计入，也不当作下一次的上一次成绩", () => {
  const baseline = score({ kind: "baseline", date: "2026-06-01", scores: { 口语: 5 }, attachments: 0, verified: false });
  const pending = score({ kind: "exam", date: "2026-07-01", scores: { 口语: 7 }, verified: false });
  const noFile = score({ kind: "exam", date: "2026-07-15", scores: { 口语: 7 }, attachments: 0, verified: true });
  const exam = score({ kind: "exam", date: "2026-08-01", scores: { 口语: 6 } });
  const { samples, issues } = buildSamples([baseline, pending, noFile, exam], [lesson("2026-06-10", "甲", ["口语"])]);
  assert.deepEqual(issues.map((i) => [i.kind, i.recordId]), [["待核验", pending.id], ["缺成绩单", noFile.id]]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]!.before, 5, "跳过未核验的实考，直接和基线比");
});

test("buildSamples：各类待处理", () => {
  const bad = score({ kind: "exam", date: "2026-07-01", scores: {}, problems: ["没选学生"] });
  const dupA = score({ kind: "baseline", date: "2026-06-01", scores: { 听力: 5 }, studentId: "s9" });
  const dupB = score({ kind: "baseline", date: "2026-06-01", scores: { 听力: 5.5 }, studentId: "s9" });
  const orphan = score({ kind: "exam", date: "2026-07-01", scores: { 阅读: 6 }, studentId: "s3" });
  const base = score({ kind: "baseline", date: "2026-06-01", scores: { 写作: 5 }, studentId: "s4" });
  const noTeacher = score({ kind: "exam", date: "2026-07-01", scores: { 写作: 6 }, studentId: "s4" });
  const { samples, issues } = buildSamples([bad, dupA, dupB, orphan, base, noTeacher], [lesson("2026-06-10", "甲", ["阅读"], ["s4"])]);
  assert.equal(samples.length, 0);
  assert.deepEqual(issues.map((i) => i.kind).sort(), ["录入有误", "无授课老师", "疑似重复", "疑似重复", "缺少上一次成绩"].sort());
});

test("多位老师各算一次，整体按样本去重", () => {
  const { samples } = buildSamples(
    [score({ kind: "baseline", date: "2026-06-01", scores: { 写作: 5, 口语: 6 } }), score({ kind: "exam", date: "2026-07-01", scores: { 写作: 6, 口语: 5.5 } })],
    [lesson("2026-06-10", "甲", ["写作"]), lesson("2026-06-11", "乙", ["写作"]), lesson("2026-06-12", "甲", ["口语"])],
  );
  const overall = tally(samples);
  assert.deepEqual([overall.n, overall.up, overall.down], [2, 1, 1]);
  const byTeacher = groupTally(samples, teachersOf);
  assert.equal(byTeacher.get("甲")!.n, 2);
  assert.equal(positiveRate(byTeacher.get("甲")!), 0.5);
  assert.equal(byTeacher.get("乙")!.n, 1);
  assert.equal(positiveRate(byTeacher.get("乙")!), 1);
});

test("legacySamples：按学生科目分数合并老师，别名统一，未知老师报错", () => {
  const row = { studentName: "张惟枝", subject: "写作", baselineScore: "5.5", finalScore: "5", createdAt: "2026-09-09 10:33:06" };
  const known = new Set(["陈依依", "Kevin Liu", "Valentina Lin"]);
  const aliases = { Kevin: "Kevin Liu", "Valentina 林": "Valentina Lin" };
  const samples = legacySamples(
    [
      { ...row, teacher: "陈依依" },
      { ...row, teacher: "Valentina 林" },
      { ...row, teacher: "Kevin", createdAt: "2026-08-05 16:09:28" },
    ],
    aliases,
    known,
  );
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0]!.teachers.map((t) => t.name), ["陈依依", "Valentina Lin", "Kevin Liu"]);
  assert.equal(samples[0]!.date, "2026-08-05");
  assert.equal(samples[0]!.outcome, "down");
  assert.throws(() => legacySamples([{ ...row, teacher: "路人" }], aliases, known), /路人/);
});
