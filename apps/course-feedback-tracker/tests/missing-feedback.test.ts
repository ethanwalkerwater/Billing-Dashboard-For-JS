import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredFeedbackTask } from "../src/server/tasks/types";
import { missingStudentsForTeacher, studentCourseTrend } from "../src/web/missing-feedback";
import type { DetailRow } from "../src/web/report-types";

function task(partial: Partial<StoredFeedbackTask> & Pick<StoredFeedbackTask, "studentName">): StoredFeedbackTask {
  const teacher = partial.teacherCanonicalName ?? "应雁心";
  return {
    taskId: partial.taskId ?? `${teacher}-${partial.studentName}`,
    courseMonth: partial.courseMonth ?? "2026-10",
    collectionMonth: partial.collectionMonth ?? "2026-11",
    studentRecordId: partial.studentRecordId ?? "rec",
    studentName: partial.studentName,
    teacherSourceName: teacher,
    teacherCanonicalName: teacher,
    courseNames: partial.courseNames ?? ["IG数学"],
    scheduleRecordIds: [],
    lessons: partial.lessons ?? [{ 课程时长: "2" }],
    status: partial.status ?? "sent",
    publicToken: "t",
    studentResponseId: partial.studentResponseId,
    parentResponseId: partial.parentResponseId,
    responseRecordIds: [],
    validationIssues: [],
    createdAt: "",
    updatedAt: "",
  };
}

function detail(student: string, matched = true): DetailRow {
  return {
    teacher: "应雁心",
    student,
    identity: "student",
    sourceIdentities: "student",
    submittedAt: "2026-11-01",
    matched,
    weight: 1,
    scores: {},
    texts: {},
  };
}

describe("missingStudentsForTeacher", () => {
  it("lists schedule students without matched feedback, heaviest hours first", () => {
    const missing = missingStudentsForTeacher({
      teacher: "应雁心",
      tasks: [
        task({ studentName: "顾子言 Tina", lessons: [{ 课程时长: "2" }] }),
        task({ studentName: "张以宁", lessons: [{ 课程时长: "6" }] }),
        task({ studentName: "李雨桐", lessons: [{ 课程时长: "4" }], studentResponseId: "r1" }),
        task({ studentName: "旁听生", teacherCanonicalName: "其他老师" }),
      ],
      detail: [detail("李雨桐"), detail("路人", false)],
    });
    assert.deepEqual(
      missing.map((row) => [row.student, row.hours]),
      [
        ["张以宁", 6],
        ["顾子言 Tina", 2],
      ],
    );
  });

  it("skips permanently excluded students and marks declined", () => {
    const missing = missingStudentsForTeacher({
      teacher: "应雁心",
      tasks: [
        task({ studentName: "内部试听", lessons: [{ 课程时长: "2" }] }),
        task({ studentName: "拒绝的", status: "declined", lessons: [{ 课程时长: "1" }] }),
      ],
      detail: [],
      excludedStudents: ["内部试听"],
    });
    assert.deepEqual(
      missing.map((row) => [row.student, row.declined]),
      [["拒绝的", true]],
    );
  });
});

describe("studentCourseTrend", () => {
  it("按同一学生和老师统计当月与次月课程数，未同步不当成 0", () => {
    const current = task({ studentName: "顾子言 Tina", lessons: [{ 课程时长: "2" }, { 课程时长: "2" }, { 课程时长: "2" }] });
    const next = task({ studentName: "顾子言Tina", lessons: [{ 课程时长: "2" }], courseMonth: "2026-11", collectionMonth: "2026-12" });
    assert.deepEqual(
      studentCourseTrend({
        courseMonth: "2026-10",
        teacher: "应雁心",
        student: "顾子言 Tina",
        currentTasks: [current, task({ studentName: "其他学生" })],
        nextTasks: [next, task({ studentName: "顾子言 Tina", teacherCanonicalName: "其他老师" })],
      }),
      { currentMonth: "2026-10", currentLessons: 3, nextMonth: "2026-11", nextLessons: 1 },
    );
    assert.equal(
      studentCourseTrend({ courseMonth: "2026-10", teacher: "应雁心", student: "顾子言 Tina", currentTasks: [current], nextTasks: null }).nextLessons,
      null,
    );
  });
});
