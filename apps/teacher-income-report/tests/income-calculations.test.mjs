import test from "node:test";
import assert from "node:assert/strict";

import {
  adjustedLessonAmounts,
  actualLessonAmount,
  discountedLessonAmount,
  effectiveLessonMultiplier,
} from "../web/assets/income-calculations.js";

test("lesson multiplier applies after percentage discount", () => {
  assert.equal(discountedLessonAmount(1000, 80), 800);
  assert.equal(actualLessonAmount(1000, 80, 1.3), 1040);
});

test("multiplier changes teacher income but not the student commission base", () => {
  assert.deepEqual(adjustedLessonAmounts(1000, 80, 1.3), {
    teacherAmount: 1040,
    commissionBaseAmount: 800,
  });
});

test("invalid discount or multiplier safely produces zero", () => {
  assert.equal(actualLessonAmount(1000, "", 1.3), 0);
  assert.equal(actualLessonAmount(1000, 80, ""), 0);
});

test("lesson multiplier defaults to the teacher's monthly feedback rate", () => {
  assert.equal(effectiveLessonMultiplier("", 0.62), 0.62);
  assert.equal(effectiveLessonMultiplier(null, 0.47), 0.47);
  assert.equal(effectiveLessonMultiplier("0.7", 0.62), 0.7);
});
