import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diagnoseUnlinked } from "../src/web/diagnose-unlinked";
import type { StoredFeedbackTask } from "../src/server/tasks/types";
import type { UnlinkedResponse } from "../src/web/useWorkbenchData";

function task(student: string, teacher: string): StoredFeedbackTask {
  return {
    taskId: `ft_202608_${student}_${teacher}`,
    courseMonth: "2026-08",
    collectionMonth: "2026-09",
    studentRecordId: `rec_${student}`,
    studentName: student,
    teacherSourceName: teacher,
    teacherCanonicalName: teacher,
    courseNames: ["IG数学"],
    scheduleRecordIds: ["lesson-1"],
    status: "sent",
    publicToken: "token",
    responseRecordIds: [],
    validationIssues: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function response(student: string, teacher: string): UnlinkedResponse {
  return {
    responseRecordId: `rec_${student}_${teacher}`,
    studentName: student,
    teacherName: teacher,
    identity: "student",
    submittedAt: "2026-09-05T02:00:00.000Z",
  };
}

const tasks = [
  task("顾子言Tina", "朱毅博"),
  task("顾子言Tina", "应雁心"),
  task("姚若澜Arwen", "李寅鑫"),
  task("杨呈悦Joy", "Kevin Liu"),
  task("沈佑一", "蓝浪"),
];

/**
 * 顶部横幅要能直接告诉教务下一步做什么，而不是只说"对不上"。
 * 三种情况都来自 2026-09 的真实数据。
 */
describe("unlinked diagnosis", () => {
  it("spots a teacher name variant and suggests that student's teachers", () => {
    const [item] = diagnoseUnlinked([response("顾子言Tina", "朱老师")], tasks);
    assert.equal(item.kind, "teacher-alias");
    assert.equal(item.aliasKind, "teacher");
    // 候选只给这个学生当月的老师，不是全部 32 位老师
    assert.deepEqual(item.candidates, ["应雁心", "朱毅博"]);
    assert.match(item.reason, /朱老师/);
  });

  it("spots a student name variant and suggests that teacher's students", () => {
    const [item] = diagnoseUnlinked([response("Arwen姚若澜", "李寅鑫")], tasks);
    assert.equal(item.kind, "student-alias");
    assert.equal(item.aliasKind, "student");
    assert.deepEqual(item.candidates, ["姚若澜Arwen"]);
  });

  it("says an alias will not help when both names exist but the pair was never scheduled", () => {
    const [item] = diagnoseUnlinked([response("杨呈悦Joy", "蓝浪")], tasks);
    assert.equal(item.kind, "pair-missing");
    assert.equal(item.aliasKind, undefined);
    assert.deepEqual(item.candidates, []);
    assert.match(item.reason, /没排过/);
  });

  it("falls back to manual review when neither name is known", () => {
    const [item] = diagnoseUnlinked([response("查无此人", "查无此师")], tasks);
    assert.equal(item.kind, "both-unknown");
    assert.deepEqual(item.candidates, []);
  });

  it("ignores spacing and case when deciding whether a name is known", () => {
    const [item] = diagnoseUnlinked([response("沈佑一", "蓝 浪")], tasks);
    // "蓝 浪" 规范化后等于 "蓝浪"，两个名字都认识，所以不是别名问题
    assert.equal(item.kind, "pair-missing");
  });
});
