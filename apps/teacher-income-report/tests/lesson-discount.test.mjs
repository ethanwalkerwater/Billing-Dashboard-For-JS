import test from "node:test";
import assert from "node:assert/strict";

import { buildReportFromCsv } from "../web/assets/report-core.js";
import {
  adjustedGroupAmount,
  adjustedLessonRowAmount,
  defaultGroupUnitPrice,
  defaultLessonRowUnitPrice,
  groupHasAmountMismatch,
  groupHasUnknownRate,
  lessonAdjustmentKey,
  lessonRowHasUnknownRate,
  lessonRowRateNote,
} from "../web/assets/lesson-adjust.js";

const MONTH = "2026-11";
const TEACHER = "林老师（演示）";
const HEADER = "课程类型,老师,学生,授课类型,临时取消,价格优惠,上课时间,下课时间,课程单价,课程时长,课程总价格";

function teacherGroups(lines) {
  const report = buildReportFromCsv([HEADER, ...lines].join("\n"), "demo.csv");
  const groups = report.views.teacher[MONTH][TEACHER].groups;
  return groups.map((group) => ({
    group,
    records: group.rawRows.map((row) => report.recordsByRow[String(row)]),
  }));
}

function find(groups, student, statusLabel) {
  const found = groups.find(({ group }) => group.counterparty === student && group.statusLabel === statusLabel);
  assert.ok(found, `missing group ${student} / ${statusLabel}`);
  return found;
}

const lin = teacherGroups([
  `雅思,${TEACHER},演示甲-901,一对一,,,2026/11/03 10:00,2026/11/03 12:00,800,2,1600`,
  `雅思,${TEACHER},演示甲-901,一对一,,,2026/11/05 10:00,2026/11/05 12:00,800,2,1600`,
  `雅思,${TEACHER},演示甲-901,一对一,,赠课-免费,2026/11/07 10:00,2026/11/07 12:00,800,2,0`,
  `雅思,${TEACHER},演示甲-901,一对一,,模拟考试-0%,2026/11/09 10:00,2026/11/09 13:30,280,3.5,0`,
  `雅思,${TEACHER},演示乙-902,一对一,,赠课-免费,2026/11/10 10:00,2026/11/10 12:00,800,2,0`,
  `雅思,${TEACHER},演示丙-903,一对一,,赠课-免费,2026/11/10 10:00,2026/11/10 12:00,800,2,0`,
  `雅思,${TEACHER},演示丙-903,一对一,,赠课-免费,2026/11/12 10:00,2026/11/12 11:00,600,1,0`,
  `雅思,${TEACHER},演示丁-904,一对一,,老带新-90%,2026/11/11 10:00,2026/11/11 12:00,800,2,1600`,
  `雅思,${TEACHER},演示戊-905,一对一,1h-60%,,2026/11/11 10:00,2026/11/11 12:00,800,2,1600`,
  `雅思,${TEACHER},演示己-906,一对一,,老带新-90%,2026/11/11 10:00,2026/11/11 12:00,,2,500`,
]);

test("T-C04 正常组改单价 900 → 3600，赠课、模考组改 900 仍为 0", () => {
  const normal = find(lin, "演示甲-901", "正常上课");
  const gift = find(lin, "演示甲-901", "赠课-免费");
  const mock = find(lin, "演示甲-901", "模拟考试-0%");
  assert.equal(adjustedGroupAmount(normal.group, normal.records, "900"), 3600);
  assert.equal(adjustedGroupAmount(gift.group, gift.records, "900"), 0);
  assert.equal(adjustedGroupAmount(mock.group, mock.records, "900"), 0);
  assert.equal(defaultGroupUnitPrice(normal.group, normal.records), "800");
  assert.equal(defaultGroupUnitPrice(mock.group, mock.records), "280");
  assert.equal(adjustedGroupAmount(normal.group, normal.records, defaultGroupUnitPrice(normal.group, normal.records)), 3200);
});

test("T-C04 正常组和赠课组的调整 key 不同；无优惠组 key 与改动前一致", () => {
  const normal = find(lin, "演示甲-901", "正常上课");
  const gift = find(lin, "演示甲-901", "赠课-免费");
  assert.notEqual(lessonAdjustmentKey(MONTH, TEACHER, normal.group), lessonAdjustmentKey(MONTH, TEACHER, gift.group));
  assert.equal(
    lessonAdjustmentKey(MONTH, TEACHER, normal.group),
    JSON.stringify([MONTH, TEACHER, "演示甲-901", "雅思", "一对一", "正常上课"]),
  );
  // 只有 cancellationStatus 的旧 group 对象也能算出 key
  assert.equal(
    lessonAdjustmentKey(MONTH, TEACHER, { counterparty: "演示甲-901", courseType: "雅思", teachingType: "一对一", cancellationStatus: "0h-70%" }),
    JSON.stringify([MONTH, TEACHER, "演示甲-901", "雅思", "一对一", "0h-70%"]),
  );
});

test("T-C05 只有 1 节赠课的组默认单价是原单价 800，不是 0/NaN/空", () => {
  const gift = find(lin, "演示乙-902", "赠课-免费");
  assert.equal(defaultGroupUnitPrice(gift.group, gift.records), "800");
});

test("T-C05 多个单价的全免费组默认单价留空，不显示 0 或 NaN", () => {
  const gift = find(lin, "演示丙-903", "赠课-免费");
  const price = defaultGroupUnitPrice(gift.group, gift.records);
  assert.equal(price, "");
  assert.equal(adjustedGroupAmount(gift.group, gift.records, price), 0);
});

test("T-C06 未知优惠「老带新-90%」800×2 改 900 → 1800，并标出", () => {
  const unknown = find(lin, "演示丁-904", "老带新-90%");
  assert.equal(groupHasUnknownRate(unknown.records), true);
  assert.equal(defaultGroupUnitPrice(unknown.group, unknown.records), "800");
  assert.equal(adjustedGroupAmount(unknown.group, unknown.records, "900"), 1800);
  assert.equal(groupHasUnknownRate(find(lin, "演示甲-901", "正常上课").records), false);
});

test("T-C06 未知取消标记改单价不清零：按原比例重算", () => {
  const unknown = find(lin, "演示戊-905", "1h-60%");
  assert.equal(groupHasUnknownRate(unknown.records), true);
  assert.equal(adjustedGroupAmount(unknown.group, unknown.records, "900"), 1800);
});

test("T-C06 未知优惠且没有原单价：改单价保留原金额", () => {
  const unknown = find(lin, "演示己-906", "老带新-90%");
  assert.equal(defaultGroupUnitPrice(unknown.group, unknown.records), "");
  assert.equal(adjustedGroupAmount(unknown.group, unknown.records, "900"), 500);
});

function exportEntry(fields) {
  const source = {
    老师名: "周老师（演示）",
    月份: MONTH,
    学生: "演示甲-901",
    课程类型: "雅思",
    授课类型: "一对一",
    "取消/上课状态": "正常上课",
    "价格优惠": "",
    "总时长（h）": "2",
    "课程单价（¥）": "800",
    "实际金额（¥）": "1600",
    ...fields,
  };
  return { month: MONTH, teacher: source.老师名, student: source.学生, amount: Number(source["实际金额（¥）"]), duration: Number(source["总时长（h）"]), source };
}

test("T-C07 逐行路径：0h-70% 800×2 1120 改 900 → 1260，默认单价 800 时金额不变", () => {
  const entry = exportEntry({ "取消/上课状态": "0h-70%", "实际金额（¥）": "1120" });
  assert.equal(defaultLessonRowUnitPrice(entry), "800");
  assert.equal(adjustedLessonRowAmount(entry, defaultLessonRowUnitPrice(entry)), 1120);
  assert.equal(adjustedLessonRowAmount(entry, "900"), 1260);
  assert.equal(lessonRowHasUnknownRate(entry), false);
});

test("T-C07 逐行路径：赠课行改 900 → 0；旧 CSV 无「价格优惠」列正常行改 900 → 1800", () => {
  const gift = exportEntry({ "价格优惠": "赠课-免费", "实际金额（¥）": "0" });
  assert.equal(defaultLessonRowUnitPrice(gift), "800");
  assert.equal(adjustedLessonRowAmount(gift, "900"), 0);

  const old = exportEntry({});
  delete old.source["价格优惠"];
  assert.equal(adjustedLessonRowAmount(old, "900"), 1800);
});

test("T-C07 逐行路径：单价混合时默认单价按 金额÷(时长×比例) 反推", () => {
  const entry = exportEntry({ "取消/上课状态": "0h-70%", "课程单价（¥）": "800 / 900", "实际金额（¥）": "1190" });
  assert.equal(defaultLessonRowUnitPrice(entry), "850");
  assert.equal(adjustedLessonRowAmount(entry, "850"), 1190);
});

test("T-C07 逐行路径：未知优惠按原比例重算并标出，没有原单价就保留原金额", () => {
  const unknown = exportEntry({ "价格优惠": "老带新-90%" });
  assert.equal(lessonRowHasUnknownRate(unknown), true);
  assert.equal(adjustedLessonRowAmount(unknown, "900"), 1800);

  const noPrice = exportEntry({ "价格优惠": "老带新-90%", "课程单价（¥）": "800 / 900", "实际金额（¥）": "500" });
  assert.equal(adjustedLessonRowAmount(noPrice, "900"), 500);
});

test("B01 逐行路径：手填折扣 90% 的行不改单价保持 468，改单价要乘折扣", () => {
  const entry = exportEntry({ "课程单价（¥）": "520", "总时长（h）": "1", "折扣（%）": "90", "实际金额（¥）": "468" });
  assert.equal(adjustedLessonRowAmount(entry, defaultLessonRowUnitPrice(entry)), 468);
  assert.equal(adjustedLessonRowAmount(entry, "600"), 540);

  const trial = exportEntry({ "价格优惠": "试听-80%", "课程单价（¥）": "520", "总时长（h）": "1", "折扣（%）": "90", "实际金额（¥）": "374.4" });
  assert.equal(adjustedLessonRowAmount(trial, defaultLessonRowUnitPrice(trial)), 374.4);
  assert.equal(adjustedLessonRowAmount(trial, "600"), 432);
});

test("B01 逐行路径：窗口期赠课行飞书总价 1600，不改单价保持 1600", () => {
  const gift = exportEntry({ "价格优惠": "赠课-免费", "总时长（h）": "4", "折扣（%）": "100", "实际金额（¥）": "1600" });
  assert.equal(adjustedLessonRowAmount(gift, defaultLessonRowUnitPrice(gift)), 1600);
  assert.equal(adjustedLessonRowAmount(gift, "900"), 0);
});

test("B01 分组路径：单价「800元」与 520 并组的试听组，不改单价保持报表金额 1160", () => {
  const [{ group, records }] = teacherGroups([
    `英语试听,${TEACHER},演示甲-901,1v1,,试听-80%,2026/11/25 10:00,2026/11/25 11:00,800元,1,640`,
    `英语试听,${TEACHER},演示甲-901,1v1,,试听-80%,2026/11/28 10:00,2026/11/28 11:00,520,1,520`,
  ]);
  assert.equal(group.amount, 1160);
  assert.equal(adjustedGroupAmount(group, records, defaultGroupUnitPrice(group, records)), 1160);
});

test("B01 分组路径：窗口期赠课组飞书总价 1600，不改单价保持 1600", () => {
  const [{ group, records }] = teacherGroups([
    `雅思,${TEACHER},演示庚-907,一对一,,赠课-免费,2026/11/03 10:00,2026/11/03 12:00,800,2,1600`,
  ]);
  assert.equal(adjustedGroupAmount(group, records, defaultGroupUnitPrice(group, records)), group.amount);
});

test("Q2 billing-core 判出金额与规则不一致的组被标出，金额不改", () => {
  const g = teacherGroups([
    `雅思,${TEACHER},演示庚-907,一对一,,,2026/11/03 10:00,2026/11/03 12:00,800,2,1000`,
    `雅思,${TEACHER},演示辛-908,一对一,,,2026/11/03 10:00,2026/11/03 12:00,800,2,1600`,
  ]);
  const bad = find(g, "演示庚-907", "正常上课");
  const ok = find(g, "演示辛-908", "正常上课");
  assert.equal(groupHasAmountMismatch(bad.records), true);
  assert.equal(groupHasAmountMismatch(ok.records), false);
  assert.equal(adjustedGroupAmount(bad.group, bad.records, defaultGroupUnitPrice(bad.group, bad.records)), 1000);
});

test("可考虑 6 逐行路径：手填折扣不是数字时提示「折扣填写有误」，未知标记仍用原提示", () => {
  assert.equal(lessonRowRateNote(exportEntry({ "折扣（%）": "九折" })), "折扣填写有误，按原比例重算");
  assert.equal(lessonRowRateNote(exportEntry({ "价格优惠": "老带新-90%" })), "含未知优惠/取消标记，按原比例重算");
  assert.equal(lessonRowRateNote(exportEntry({})), "");
});
