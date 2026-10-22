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

export function recurringAdjustmentRows(entries, month, teacher) {
  let latestMonth = "";
  let rows = [];
  for (const [key, value] of Object.entries(entries)) {
    const [savedMonth, savedTeacher] = JSON.parse(key);
    if (savedTeacher === teacher && savedMonth <= month && savedMonth > latestMonth) {
      latestMonth = savedMonth;
      rows = value;
    }
  }
  return rows;
}

export function expandRecurringAdjustments(entries, months) {
  const teachers = new Set(Object.keys(entries).map((key) => JSON.parse(key)[1]));
  return months.flatMap((month) => [...teachers].flatMap((teacher) =>
    recurringAdjustmentRows(entries, month, teacher).map((row) => ({ month, teacher, ...row })),
  ));
}
