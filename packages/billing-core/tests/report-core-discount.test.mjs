import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOUNT_EFFECTIVE_DATE,
  DISCOUNT_RATES,
  ISSUE_LABELS,
  aggregateRecords,
  buildReportData,
  buildReportFromCsv,
  normalizeRow,
  parseCancellationRate,
  parseDiscountRate,
} from "../src/report-core.js";

// 演示数据登记表：L-雅思 800×2，L-模考 280×3.5，L-试听 520×1，L-数学 800×2，L-零头 333×1.5
const LESSONS = {
  雅思: { 老师: "林老师（演示）", 学生: "演示甲-901", 课程类型: "雅思", 课程单价: "800", 课程时长: "2" },
  模考: { 老师: "林老师（演示）", 学生: "演示甲-901", 课程类型: "雅思模考", 课程单价: "280", 课程时长: "3.5" },
  试听: { 老师: "吴老师（演示）", 学生: "演示甲-901", 课程类型: "英语试听", 课程单价: "520", 课程时长: "1" },
  数学: { 老师: "周老师（演示）", 学生: "演示乙-902", 课程类型: "IG数学", 课程单价: "800", 课程时长: "2" },
  零头: { 老师: "周老师（演示）", 学生: "演示乙-902", 课程类型: "IG数学", 课程单价: "333", 课程时长: "1.5" },
};

function lesson(name, overrides = {}) {
  return {
    "学员课程ID": "demo-1",
    "授课类型": "1v1",
    "上课时间": "2026/11/03 10:00",
    "下课时间": "2026/11/03 12:00",
    "临时取消": "",
    "价格优惠": "",
    "上课地点": "文定",
    ...LESSONS[name],
    ...overrides,
  };
}

const codes = (record) => record.issues.map((issue) => issue.code);

test("exports discount table, effective date and parseDiscountRate", () => {
  assert.deepEqual(DISCOUNT_RATES, { "赠课-免费": 0, "试听-80%": 0.8, "模拟考试-0%": 0 });
  assert.equal(DISCOUNT_EFFECTIVE_DATE, "2026-11-01");
  assert.equal(ISSUE_LABELS.unknown_discount, "未知优惠标记");
  assert.equal(parseDiscountRate("试听-80%"), 0.8);
  assert.equal(parseDiscountRate(" 赠课-免费 "), 0);
  assert.equal(parseDiscountRate("模拟考试-0%"), 0);
  assert.equal(parseDiscountRate("老带新-90%"), null);
  assert.equal(parseDiscountRate(""), null);
  assert.equal(parseDiscountRate("constructor"), null);
});

test("T-A01 赠课-免费 单独状态、金额 0、不报问题", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 课程总价格: "0" }), 2);
  assert.equal(record.statusLabel, "赠课-免费");
  assert.equal(record.discountStatus, "赠课-免费");
  assert.equal(record.discountRate, 0);
  assert.equal(record.isDiscounted, true);
  assert.equal(record.discountApplies, true);
  assert.equal(record.chargeRate, 0);
  assert.equal(record.cancellationStatus, "正常上课");
  assert.equal(record.isCancelled, false);
  assert.equal(record.amount, 0);
  assert.equal(record.expectedAmount, 0);
  assert.deepEqual(codes(record), []);
});

test("T-A02 试听-80% 金额 416 不报问题", () => {
  const record = normalizeRow(lesson("试听", { 价格优惠: "试听-80%", 课程总价格: "416" }), 2);
  assert.equal(record.statusLabel, "试听-80%");
  assert.equal(record.chargeRate, 0.8);
  assert.equal(record.expectedAmount, 416);
  assert.equal(record.amount, 416);
  assert.deepEqual(codes(record), []);
});

test("T-A04 模拟考试-0% 金额 0 不报问题", () => {
  const record = normalizeRow(lesson("模考", { 价格优惠: "模拟考试-0%", 课程总价格: "0" }), 2);
  assert.equal(record.statusLabel, "模拟考试-0%");
  assert.equal(record.amount, 0);
  assert.deepEqual(codes(record), []);
});

function demoJiaNovember() {
  return [
    lesson("雅思", { 课程总价格: "1600", 上课时间: "2026/11/02 10:00" }),
    lesson("雅思", { 课程总价格: "1600", 上课时间: "2026/11/09 10:00" }),
    lesson("雅思", { 课程总价格: "0", 价格优惠: "赠课-免费", 上课时间: "2026/11/16 10:00" }),
    lesson("试听", { 课程总价格: "416", 价格优惠: "试听-80%", 上课时间: "2026/11/04 10:00" }),
    lesson("模考", { 课程总价格: "0", 价格优惠: "模拟考试-0%", 上课时间: "2026/11/21 10:00" }),
  ];
}

test("T-A05 正常课和三种优惠各成一行，合计 3616；T-A08 林老师 3200", () => {
  const records = demoJiaNovember().map((row, index) => normalizeRow(row, index + 2));
  const result = aggregateRecords(records, "student", "2026-11", "演示甲-901");
  assert.equal(result.totals.amount, 3616);
  assert.equal(result.groups.length, 4);
  assert.deepEqual(
    new Set(result.groups.map((group) => `${group.courseType}|${group.statusLabel}`)),
    new Set(["雅思|正常上课", "雅思|赠课-免费", "英语试听|试听-80%", "雅思模考|模拟考试-0%"]),
  );
  assert.equal(result.groups[0].statusLabel, "正常上课");
  const promo = result.groups.find((group) => group.statusLabel === "赠课-免费");
  assert.equal(promo.cancellationStatus, "正常上课");
  assert.equal(promo.discountStatus, "赠课-免费");
  assert.equal(result.groups.find((group) => group.statusLabel === "正常上课").discountStatus, "");
  assert.equal(result.totals.cancelledLessons, 0);

  const teacher = aggregateRecords(records, "teacher", "2026-11", "林老师（演示）");
  assert.equal(teacher.totals.amount, 3200);
  assert.equal(teacher.groups.length, 3);
});

test("T-A06 临时取消统计只算 0h 那节，优惠课不算", () => {
  const rows = [...demoJiaNovember(), lesson("雅思", { 临时取消: "0h-70%", 课程总价格: "1120", 上课时间: "2026/11/23 10:00" })];
  const result = aggregateRecords(rows.map((row, index) => normalizeRow(row, index + 2)), "student", "2026-11", "演示甲-901");
  assert.equal(result.totals.cancelledLessons, 1);
  assert.equal(result.totals.cancelledAmount, 1120);
  assert.equal(result.totals.amount, 4736);
  assert.equal(result.groups.length, 5);
});

test("T-A07 临时取消=学生病假-0% 不再报未知取消标记", () => {
  assert.equal(parseCancellationRate("学生病假-0%"), 0);
  const record = normalizeRow(lesson("数学", { 临时取消: "学生病假-0%", 课程总价格: "0" }), 2);
  assert.equal(record.cancellationRate, 0);
  assert.equal(record.chargeRate, 0);
  assert.equal(record.amount, 0);
  assert.equal(record.statusLabel, "学生病假-0%");
  assert.deepEqual(codes(record), []);
});

test("T-A09 CSV 没有价格优惠列，结果和改动前一样", () => {
  const csv = [
    "学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消",
    "演示甲-901,林老师（演示）,雅思,1v1,2026/09/02 10:00,2026/09/02 12:00,800,2,1600,",
    "演示甲-901,林老师（演示）,雅思,1v1,2026/09/09 10:00,2026/09/09 12:00,800,2,1120,0h-70%",
  ].join("\n");
  const data = buildReportFromCsv(csv, "old.csv");
  assert.deepEqual(data.qualityIssues, []);
  for (const record of Object.values(data.recordsByRow)) {
    assert.equal(record.discountRaw, "");
    assert.equal(record.isDiscounted, false);
    assert.equal(record.statusLabel, record.cancellationStatus);
  }
  const view = data.views.student["2026-09"]["演示甲-901"];
  assert.equal(view.totals.amount, 2720);
  assert.deepEqual(view.groups.map((group) => group.statusLabel), ["正常上课", "0h-70%"]);
  assert.deepEqual(view.groups.map((group) => group.cancellationStatus), ["正常上课", "0h-70%"]);
  assert.deepEqual(data.metadata.knownDiscountRates, DISCOUNT_RATES);
  assert.equal(data.metadata.discountEffectiveDate, "2026-11-01");
});

test("T-E01 试听+0h 相乘 291.2", () => {
  const record = normalizeRow(lesson("试听", { 价格优惠: "试听-80%", 临时取消: "0h-70%", 课程总价格: "291.2" }), 2);
  assert.ok(Math.abs(record.chargeRate - 0.56) < 1e-9);
  assert.equal(record.expectedAmount, 291.2);
  assert.equal(record.amount, 291.2);
  assert.equal(record.statusLabel, "0h-70% · 试听-80%");
  assert.equal(record.cancellationStatus, "0h-70%");
  assert.equal(record.isCancelled, true);
  assert.deepEqual(codes(record), []);
});

test("T-E02 赠课+2h-50% 0 元，两个状态都显示", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 临时取消: "2h-50%", 课程总价格: "0" }), 2);
  assert.equal(record.amount, 0);
  assert.equal(record.statusLabel, "2h-50% · 赠课-免费");
  assert.deepEqual(codes(record), []);
});

test("T-E03 试听+学生病假-0% 0 元", () => {
  const record = normalizeRow(lesson("数学", { 价格优惠: "试听-80%", 临时取消: "学生病假-0%", 课程总价格: "0" }), 2);
  assert.equal(record.chargeRate, 0);
  assert.equal(record.amount, 0);
  assert.deepEqual(codes(record), []);
});

test("T-E04 333×1.5×0.8×0.7=279.72 不报不一致", () => {
  const record = normalizeRow(lesson("零头", { 价格优惠: "试听-80%", 临时取消: "0h-70%", 课程总价格: "279.72" }), 2);
  assert.ok(Math.abs(record.expectedAmount - 279.72) <= 0.01);
  assert.equal(record.amount, 279.72);
  assert.deepEqual(codes(record), []);
});

test("T-E05 未知优惠报未知优惠标记，规则金额置空不报不一致", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "老带新-90%", 课程总价格: "1600" }), 7);
  assert.deepEqual(codes(record), ["unknown_discount"]);
  assert.equal(record.issues[0].label, "未知优惠标记");
  assert.equal(record.issues[0].message, "价格优惠标记未配置收费比例：老带新-90%");
  assert.equal(record.issues[0].rawRow, 7);
  assert.equal(record.discountRate, null);
  assert.equal(record.chargeRate, null);
  assert.equal(record.expectedAmount, null);
  assert.equal(record.amount, 1600);
  assert.equal(record.statusLabel, "老带新-90%");
});

test("T-E06 首尾空格认出；全角「％」报未知", () => {
  const spaced = normalizeRow(lesson("雅思", { 价格优惠: " 赠课-免费 ", 课程总价格: "0" }), 2);
  assert.equal(spaced.discountRaw, "赠课-免费");
  assert.equal(spaced.discountRate, 0);
  assert.deepEqual(codes(spaced), []);

  const fullWidth = normalizeRow(lesson("试听", { 价格优惠: "试听-80％", 课程总价格: "520" }), 3);
  assert.deepEqual(codes(fullWidth), ["unknown_discount"]);
  assert.equal(fullWidth.chargeRate, null);
});

test("T-E07 赠课单价手填 0 不报缺单价、不报不一致", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 课程单价: "0", 课程总价格: "0" }), 2);
  assert.equal(record.amount, 0);
  assert.deepEqual(codes(record), []);
});

test("T-E08 赠课单价空、总价格空：报缺少课程总价格，金额 0", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 课程单价: "", 课程总价格: "" }), 2);
  assert.ok(codes(record).includes("missing_amount"));
  assert.ok(!codes(record).includes("amount_mismatch"));
  assert.equal(record.amount, 0);
});

test("T-E09 试听单价是文本「800元」：报缺单价，不报不一致", () => {
  const record = normalizeRow(lesson("试听", { 价格优惠: "试听-80%", 课程单价: "800元", 课程总价格: "416" }), 2);
  assert.ok(codes(record).includes("missing_unit_price"));
  assert.ok(!codes(record).includes("amount_mismatch"));
  assert.equal(record.expectedAmount, null);
  assert.equal(record.amount, 416);
});

test("T-E10 试听改名「试听-八折」后所有行报未知优惠标记", () => {
  const rows = [
    lesson("试听", { 价格优惠: "试听-八折", 课程总价格: "520", 上课时间: "2026/11/04 10:00" }),
    lesson("试听", { 价格优惠: "试听-八折", 课程总价格: "520", 上课时间: "2026/11/11 10:00" }),
  ];
  const data = buildReportData(rows.map((row, index) => normalizeRow(row, index + 2)));
  assert.equal(data.issueCounts.unknown_discount, 2);
  assert.equal(data.issueCounts.amount_mismatch, undefined);
});

test("T-F06 10-31 23:30 赠课 1600 不报任何问题", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 上课时间: "2026/10/31 23:30", 下课时间: "2026/11/01 01:30", 课程总价格: "1600" }), 2);
  assert.equal(record.month, "2026-10");
  assert.equal(record.discountRaw, "赠课-免费");
  assert.equal(record.discountApplies, false);
  assert.equal(record.discountStatus, "");
  assert.equal(record.discountRate, null);
  assert.equal(record.isDiscounted, false);
  assert.equal(record.chargeRate, 1);
  assert.equal(record.statusLabel, "正常上课");
  assert.equal(record.amount, 1600);
  assert.deepEqual(codes(record), []);
});

test("T-F07 11-01 00:00 >= 生效；T-E11 11-01 00:30 只在 11 月", () => {
  for (const start of ["2026/11/01 00:00:00", "2026/11/01 00:00", "2026-11-01", "2026/11/1 00:30"]) {
    const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 上课时间: start, 课程总价格: "0" }), 2);
    assert.equal(record.month, "2026-11", start);
    assert.equal(record.discountApplies, true, start);
    assert.equal(record.amount, 0, start);
    assert.deepEqual(codes(record), [], start);
  }
});

test("T-F08 跨午夜按上课时间：10-31 23:00 上课的试听按旧规则 520", () => {
  const record = normalizeRow(lesson("试听", { 价格优惠: "试听-80%", 上课时间: "2026/10/31 23:00", 下课时间: "2026/11/01 01:00", 课程总价格: "520" }), 2);
  assert.equal(record.month, "2026-10");
  assert.equal(record.discountApplies, false);
  assert.equal(record.expectedAmount, 520);
  assert.deepEqual(codes(record), []);
});

test("T-F12 9、10 月带价格优惠的行和没有标记时逐行一致", () => {
  const rows = [
    lesson("试听", { 价格优惠: "试听-80%", 上课时间: "2026/09/15 10:00", 课程总价格: "520" }),
    lesson("雅思", { 价格优惠: "赠课-免费", 上课时间: "2026/10/20 10:00", 课程总价格: "1600" }),
  ];
  const withPromo = buildReportData(rows.map((row, index) => normalizeRow(row, index + 2)));
  const without = buildReportData(rows.map((row, index) => normalizeRow({ ...row, 价格优惠: "" }, index + 2)));
  assert.deepEqual(withPromo.qualityIssues, []);
  assert.deepEqual(withPromo.views, without.views);
});

test("T-F14 残留「学生病假-0%」：10 月不报，11 月报未知", () => {
  const october = normalizeRow(lesson("雅思", { 价格优惠: "学生病假-0%", 上课时间: "2026/10/29 10:00", 课程总价格: "1600" }), 2);
  assert.deepEqual(codes(october), []);
  assert.equal(october.statusLabel, "正常上课");
  assert.equal(october.amount, 1600);

  const november = normalizeRow(lesson("雅思", { 价格优惠: "学生病假-0%", 上课时间: "2026/11/05 10:00", 课程总价格: "1600" }), 3);
  assert.deepEqual(codes(november), ["unknown_discount"]);
  assert.equal(november.expectedAmount, null);
});

test("chargeRate 为 null 时不参与乘法（未知取消 × 已知优惠、未知优惠 × 已知取消）", () => {
  const unknownCancel = normalizeRow(lesson("雅思", { 临时取消: "请假", 价格优惠: "试听-80%", 课程总价格: "1280" }), 2);
  assert.equal(unknownCancel.chargeRate, null);
  assert.equal(unknownCancel.expectedAmount, null);
  assert.equal(unknownCancel.amount, 1280);
  assert.deepEqual(codes(unknownCancel), ["unknown_cancellation"]);

  const unknownPromo = normalizeRow(lesson("雅思", { 临时取消: "0h-70%", 价格优惠: "老带新-90%", 课程总价格: "1120" }), 3);
  assert.equal(unknownPromo.chargeRate, null);
  assert.equal(unknownPromo.expectedAmount, null);
  assert.equal(unknownPromo.statusLabel, "0h-70% · 老带新-90%");
  assert.deepEqual(codes(unknownPromo), ["unknown_discount"]);

  const bothUnknown = normalizeRow(lesson("雅思", { 临时取消: "请假", 价格优惠: "老带新-90%", 课程总价格: "" }), 4);
  assert.equal(bothUnknown.chargeRate, null);
  assert.equal(bothUnknown.amount, 0);
  assert.deepEqual(codes(bothUnknown).sort(), ["missing_amount", "unknown_cancellation", "unknown_discount"]);
});

test("上课时间无法解析时优惠不生效", () => {
  const record = normalizeRow(lesson("雅思", { 价格优惠: "赠课-免费", 上课时间: "2026/13/01 10:00", 课程总价格: "1600" }), 2);
  assert.equal(record.discountApplies, false);
  assert.equal(record.chargeRate, 1);
  assert.ok(codes(record).includes("invalid_start_time"));
  assert.ok(!codes(record).includes("unknown_discount"));
});

test("只有价格优惠原文的行也算有内容，进入计费汇总", () => {
  const record = normalizeRow(lesson("雅思", { 老师: "", 课程单价: "", 课程总价格: "", 价格优惠: "赠课-免费" }), 2);
  assert.equal(record.reportable, true);
  assert.ok(!codes(record).includes("not_reportable"));
});

test("B06 金额与规则不一致按整数分比、容差 1 分：80.01 和 8.01 都不报，80.02 报", () => {
  const mismatch = (price, amount) => codes(normalizeRow(lesson("试听", { 价格优惠: "试听-80%", 课程单价: String(price), 课程时长: "1", 课程总价格: String(amount) }), 2)).includes("amount_mismatch");
  assert.equal(mismatch(100, 80.01), false);
  assert.equal(mismatch(10, 8.01), false);
  assert.equal(mismatch(100, 80.02), true);
});
