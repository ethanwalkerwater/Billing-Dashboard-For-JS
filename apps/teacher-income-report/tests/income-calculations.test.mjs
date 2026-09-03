import test from "node:test";
import assert from "node:assert/strict";

import {
  adjustedLessonAmounts,
  actualLessonAmount,
  discountedLessonAmount,
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
