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

export function lessonAmountFromUnitPrice(unitPrice, duration, cancellationRate = 1) {
  return round(
    numericOrZero(unitPrice) * numericOrZero(duration) * numericOrZero(cancellationRate),
  );
}

export function actualLessonAmount(amount, multiplier) {
  return round(numericOrZero(amount) * numericOrZero(multiplier));
}

export function adjustedLessonAmounts(amount, multiplier) {
  return {
    teacherAmount: actualLessonAmount(amount, multiplier),
    commissionBaseAmount: round(numericOrZero(amount)),
  };
}
