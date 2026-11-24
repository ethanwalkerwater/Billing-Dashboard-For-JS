import test from "node:test";
import assert from "node:assert/strict";

import { buildPayrollReport } from "../web/assets/payroll-core.js";
import {
  expandRecurringAdjustments,
  recurringAdjustmentRows,
} from "../web/assets/income-calculations.js";

const key = (month, teacher = "测试老师") => JSON.stringify([month, teacher]);
const september = [
  { description: "补贴", amount: "500" },
  { description: "扣款", amount: "-100" },
];

test("September adjustments carry into future months and years, but not earlier months or other teachers", () => {
  const entries = { [key("2026-09")]: september };
  for (const month of ["2026-09", "2026-10", "2026-11", "2027-01"]) {
    assert.deepEqual(recurringAdjustmentRows(entries, month, "测试老师"), september);
  }
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-08", "测试老师"), []);
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-10", "另一位老师"), []);
  assert.equal(Object.keys(entries).length, 1, "viewing an inherited month must not save a snapshot");
});

test("the latest explicit month wins regardless of save order, including existing records", () => {
  const october = [{ description: "调整补贴", amount: "700" }];
  const entries = { [key("2026-10")]: october, [key("2026-09")]: september };
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-09", "测试老师"), september);
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-11", "测试老师"), october);
  entries[key("2026-09")] = [{ description: "补改九月", amount: "900" }];
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-11", "测试老师"), october);
});

test("deleting all entries stops carry-forward after storage round-trip without changing earlier months", () => {
  const entries = JSON.parse(JSON.stringify({
    [key("2026-09")]: september,
    [key("2026-10")]: [],
  }));
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-09", "测试老师"), september);
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-10", "测试老师"), []);
  assert.deepEqual(recurringAdjustmentRows(entries, "2026-11", "测试老师"), []);
});

test("inherited entries reach payroll totals and export details even with only a later month uploaded", () => {
  const report = {
    months: ["2026-11"],
    views: { teacher: { "2026-11": {} }, student: { "2026-11": {} } },
  };
  const payroll = buildPayrollReport(report, {
    baseSalaries: [{ teacher: "测试老师", employmentType: "partTime", baseSalary: 0 }],
    extraAdjustments: expandRecurringAdjustments({ [key("2026-09")]: september }, report.months),
  });
  const row = payroll.byMonth["2026-11"]["测试老师"];
  assert.equal(row.extraAdjustmentTotal, 400);
  assert.equal(row.lessonBonus, 400);
  assert.deepEqual(row.extraAdjustments, [
    { description: "补贴", amount: 500 },
    { description: "扣款", amount: -100 },
  ]);
});
