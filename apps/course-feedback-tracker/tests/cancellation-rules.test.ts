import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellationTier,
  listCancellableLessons,
  validateCancellation,
} from "../src/cancellation/rules";
import type { CancellableLesson } from "../src/cancellation/rules";

const HOUR = 3_600_000;
const start = Date.parse("2026-10-09T19:30:00+08:00");
const lesson: CancellableLesson = {
  recordId: "rec1",
  studentRecordIds: ["stuA"],
  teacherName: "黄钢",
  teacherOpenId: "ou_teacher",
  courseName: "IG英语",
  startMs: start,
  endMs: start + 2 * HOUR,
  cancellation: "",
};

test("tier follows how long before class the questionnaire is submitted", () => {
  const at = (hoursBefore: number) => cancellationTier(lesson, start - hoursBefore * HOUR, "personal");
  assert.equal(at(-0.5).tier, "0h-70%", "class already started");
  assert.equal(at(0).tier, "0h-70%", "exactly at start");
  assert.equal(at(1.5).tier, "2h-50%");
  assert.equal(at(2).tier, "2h-50%", "exactly 2h before counts as 50%");
  assert.equal(at(2.01).tier, "6h-30%");
  assert.equal(at(6).tier, "6h-30%", "exactly 6h before counts as 30%");
  assert.equal(at(6.01).tier, "提前取消-0%");
  assert.equal(at(48).rate, 0);
  assert.equal(cancellationTier(lesson, start - 1 * HOUR, "sick").tier, "学生病假-0%");
});

test("only this student's unfinished, uncancelled single-student lessons in the window are listed", () => {
  const now = start - 3 * HOUR;
  const lessons: CancellableLesson[] = [
    lesson,
    { ...lesson, recordId: "ended", startMs: now - 3 * HOUR, endMs: now - HOUR },
    { ...lesson, recordId: "ongoing", startMs: now - HOUR, endMs: now + HOUR },
    { ...lesson, recordId: "other", studentRecordIds: ["stuB"] },
    { ...lesson, recordId: "cancelled", cancellation: "6h-30%" },
    { ...lesson, recordId: "far", startMs: now + 15 * 24 * HOUR, endMs: now + 15 * 24 * HOUR + HOUR },
    { ...lesson, recordId: "group", studentRecordIds: ["stuA", "stuB"] },
  ];
  const listed = listCancellableLessons(lessons, "stuA", now);
  assert.deepEqual(listed.map((item) => [item.lesson.recordId, item.status]), [
    ["ongoing", "available"],
    // 同一时间按记录 ID 排序
    ["cancelled", "cancelled"],
    ["group", "group"],
    ["rec1", "available"],
  ]);
  assert.equal(listed[3].preview.tier, "6h-30%");
});

test("submission is rejected when the lesson no longer belongs to, or can be cancelled by, the student", () => {
  const ok = validateCancellation({ lesson, studentRecordId: "stuA", submittedMs: start - HOUR });
  assert.equal(ok.ok, true);
  const reasons = [
    validateCancellation({ lesson, studentRecordId: "stuB", submittedMs: start - HOUR }),
    validateCancellation({ lesson: { ...lesson, cancellation: "2h-50%" }, studentRecordId: "stuA", submittedMs: start - HOUR }),
    validateCancellation({ lesson, studentRecordId: "stuA", submittedMs: lesson.endMs }),
    validateCancellation({ lesson: { ...lesson, studentRecordIds: ["stuA", "stuB"] }, studentRecordId: "stuA", submittedMs: start - HOUR }),
  ].map((result) => (result.ok ? "ok" : result.code));
  assert.deepEqual(reasons, ["NOT_OWN_LESSON", "ALREADY_CANCELLED", "LESSON_ENDED", "GROUP_LESSON"]);
});
