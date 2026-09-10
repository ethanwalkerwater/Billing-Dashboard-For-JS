function round(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function numericOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function effectiveLessonMultiplier(value, feedbackRate) {
  return String(value ?? "").trim() === ""
    ? numericOrZero(feedbackRate)
    : numericOrZero(value);
}

export function discountedLessonAmount(amount, discountPercent) {
  return round(numericOrZero(amount) * numericOrZero(discountPercent) / 100);
}

export function actualLessonAmount(amount, discountPercent, multiplier) {
  return round(discountedLessonAmount(amount, discountPercent) * numericOrZero(multiplier));
}

export function adjustedLessonAmounts(amount, discountPercent, multiplier) {
  return {
    teacherAmount: actualLessonAmount(amount, discountPercent, multiplier),
    commissionBaseAmount: discountedLessonAmount(amount, discountPercent),
  };
}
