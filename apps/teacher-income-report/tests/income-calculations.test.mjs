import test from "node:test";
import assert from "node:assert/strict";

import {
  adjustedLessonAmounts,
  actualLessonAmount,
  effectiveLessonMultiplier,
  lessonAmountFromUnitPrice,
} from "../web/assets/income-calculations.js";

test("lesson multiplier applies to the adjusted lesson amount", () => {
  assert.equal(actualLessonAmount(800, 1.3), 1040);
});

test("editable unit price recalculates normal and cancelled lesson amounts", () => {
  assert.equal(lessonAmountFromUnitPrice(280, 2), 560);
  assert.equal(lessonAmountFromUnitPrice(280, 2, 0.5), 280);
});

test("multiplier changes teacher income but not the student commission base", () => {
  assert.deepEqual(adjustedLessonAmounts(800, 1.3), {
    teacherAmount: 1040,
    commissionBaseAmount: 800,
  });
});

test("invalid amount or multiplier safely produces zero", () => {
  assert.equal(actualLessonAmount("", 1.3), 0);
  assert.equal(actualLessonAmount(1000, ""), 0);
});

test("lesson multiplier defaults to the teacher's monthly feedback rate", () => {
  assert.equal(effectiveLessonMultiplier("", 0.62), 0.62);
  assert.equal(effectiveLessonMultiplier(null, 0.47), 0.47);
  assert.equal(effectiveLessonMultiplier("0.7", 0.62), 0.7);
});
