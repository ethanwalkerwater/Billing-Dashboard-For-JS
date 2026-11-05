import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRawScheduleLookup,
  buildStudentReports,
  parseCompleteBillingCsv,
} from "../src/student-billing-batch-data.mjs";
import {
  buildConfirmedReport,
  prepareReportForEditing,
  updateCourseLine,
  validateReport,
} from "../web/src/report-model.js";
import { renderStudentBillingReportHtml } from "../src/render-student-billing-report.mjs";

const HEAD = "学生名,月份,老师,课程类型,授课类型,取消/上课状态,价格优惠,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行";
const OLD_HEAD = "学生名,月份,老师,课程类型,授课类型,取消/上课状态,总时长（h）,取消时长（h）,课程单价（¥）,折扣（%）,折扣原因,总金额（¥）,实际金额（¥）,原始行";
const SCHEDULE_HEAD = "学生,老师,课程类型,授课类型,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,价格优惠,上课地点";

// 演示甲-901 11 月：正常 2 节、赠课、试听、模拟考试（导出 CSV 的总金额是飞书公式算好的金额）
const billingCsv = `${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,,4,0,800,100,,3200,3200,"2 3"
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,赠课-免费,2,0,800,100,,0,0,"4"
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,试听-80%,1,0,520,100,,416,416,"5"
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,模拟考试-0%,3.5,0,280,100,,0,0,"6"`;

const scheduleCsv = `${SCHEDULE_HEAD}
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/03 10:00,2026/11/03 12:00,800,2,1600,,,校区
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/05 10:00,2026/11/05 12:00,800,2,1600,,,校区
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/07 10:00,2026/11/07 12:00,800,2,0,,赠课-免费,校区
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/09 10:00,2026/11/09 11:00,520,1,416,,试听-80%,校区
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/11 09:00,2026/11/11 12:30,280,3.5,0,,模拟考试-0%,校区`;

const teachers = [{ name: "林老师（演示）", subject: "数学", photo: null, tag: "", desc: "", scores: {} }];

function batchReport(csv = billingCsv, schedule = scheduleCsv) {
  return buildStudentReports(parseCompleteBillingCsv(csv), buildRawScheduleLookup(schedule));
}

function webReport(csv = billingCsv, schedule = scheduleCsv) {
  return prepareReportForEditing(batchReport(csv, schedule)[0]);
}

const render = (report) => renderStudentBillingReportHtml(report, teachers, { embedTeacherPhotos: false });

test("T-B01 优惠课按原价、应付、减免正确", () => {
  const report = webReport();
  const [normal, gift, trial, mock] = report.courseLines;
  assert.deepEqual([normal.grossAmount, normal.payableAmount, normal.discountAmount], [3200, 3200, 0]);
  assert.deepEqual([gift.grossAmount, gift.payableAmount, gift.discountAmount], [1600, 0, 1600]);
  assert.deepEqual([trial.grossAmount, trial.payableAmount, trial.discountAmount], [520, 416, 104]);
  assert.deepEqual([mock.grossAmount, mock.payableAmount, mock.discountAmount], [980, 0, 980]);
  assert.deepEqual(report.totals, { duration: 10.5, grossAmount: 6300, discountAmount: 2684, payableAmount: 3616, cancelledDuration: 0 });
  // 改单价后试听只乘一次 80%，再改一次也不会叠乘
  let edited = updateCourseLine(report, 2, "unitPrice", "600");
  assert.equal(edited.courseLines[2].payableAmount, 480);
  edited = updateCourseLine(edited, 2, "duration", "2");
  assert.equal(edited.courseLines[2].payableAmount, 960);
  assert.equal(updateCourseLine(report, 1, "unitPrice", "900").courseLines[1].payableAmount, 0);
});

test("T-B02 优惠课计费说明写优惠名，不写请假、正常计费", () => {
  for (const report of [batchReport()[0], webReport()]) {
    const [, gift, trial, mock] = report.courseLines;
    assert.equal(gift.billingNote, "赠课 · 免费");
    assert.equal(trial.billingNote, "试听 · 收 80%");
    assert.equal(mock.billingNote, "模拟考试 · 免费");
    for (const line of [gift, trial, mock]) {
      assert.equal(line.isLeave, false);
      assert.doesNotMatch(line.billingNote, /请假|正常计费/);
    }
  }
  const html = render(buildConfirmedReport(webReport()));
  assert.match(html, /<tr class="is-promo">/);
  assert.match(html, /赠课 · 免费/);
  assert.doesNotMatch(html, /请假扣费|正常计费/);
});

test("T-B04 日历上赠课那天标优惠名，不标请假", () => {
  const report = webReport();
  const gift = report.lessons.find((lesson) => lesson.date === "2026-11-07");
  assert.equal(gift.isLeave, false);
  assert.equal(gift.isPromo, true);
  assert.equal(gift.promoLabel, "赠课-免费");
  const html = render(buildConfirmedReport(report));
  assert.match(html, /<mark class="promo">赠课-免费<\/mark>/);
  assert.doesNotMatch(html, /请假 · 临时取消/);
  assert.match(html, /优惠课程<\/span>/);
});

test("T-B05 有优惠课时页脚说明优惠规则，没有时不写", () => {
  const sentence = "优惠课程：赠课、模拟考试不收费；试听课按 80% 收取课时费。临时取消按取消时间对应的比例收取课时费，病假不收费。";
  const html = render(buildConfirmedReport(webReport()));
  assert.ok(html.includes(sentence));
  assert.match(html, /折扣、优惠课程与临时请假已按规则计入应付课时费。/);

  const plain = webReport(`${OLD_HEAD}
演示甲-901,2026-10,林老师（演示）,演示数学,1v1,正常上课,2,0,800,100,,1600,1600,"2"`, scheduleCsv);
  assert.ok(!render(buildConfirmedReport(plain)).includes(sentence));
});

test("T-B07 单价 0 的赠课不出 NaN / Infinity", () => {
  const report = webReport(`${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,赠课-免费,2,0,0,100,,0,0,"4"`);
  const [line] = report.courseLines;
  assert.deepEqual([line.grossAmount, line.payableAmount, line.discountAmount], [0, 0, 0]);
  assert.equal(line.billingNote, "赠课 · 免费");
  const edited = updateCourseLine(report, 0, "duration", "3");
  assert.equal(edited.courseLines[0].payableAmount, 0);
  const html = render(buildConfirmedReport(edited));
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("T-B08 批量版和单个版同一学生金额、标签一致", () => {
  const batch = batchReport()[0];
  const single = buildConfirmedReport(webReport());
  const pick = (report) => report.courseLines.map((line) => [line.grossAmount, line.payableAmount, line.billingNote]);
  assert.deepEqual(pick(batch), pick(single));
  assert.equal(batch.totals.payableAmount, single.totals.payableAmount);
});

test("T-B09 小班一行两个学生各自标赠课、0 元", () => {
  const csv = `${HEAD}
演示丙-903,2026-11,林老师（演示）,演示小班,小班,正常上课,赠课-免费,2,0,600,100,,0,0,"2"
演示丁-904,2026-11,林老师（演示）,演示小班,小班,正常上课,赠课-免费,2,0,600,100,,0,0,"2"`;
  const schedule = `${SCHEDULE_HEAD}
"演示丙-903,演示丁-904",林老师（演示）,演示小班,小班,2026/11/04 18:00,2026/11/04 20:00,600,2,0,,赠课-免费,校区`;
  const reports = batchReport(csv, schedule).map(prepareReportForEditing);
  assert.equal(reports.length, 2);
  for (const report of reports) {
    assert.equal(report.courseLines[0].payableAmount, 0);
    assert.equal(report.courseLines[0].billingNote, "赠课 · 免费");
    assert.equal(report.lessons.length, 1);
    assert.equal(report.lessons[0].promoLabel, "赠课-免费");
  }
});

test("T-A09 旧 CSV 没有价格优惠列，结果和原来一样", () => {
  const report = batchReport(`${OLD_HEAD}
演示甲-901,2026-10,林老师（演示）,演示数学,1v1,正常上课,2,0,800,100,,1600,1600,"2"
演示甲-901,2026-10,林老师（演示）,演示数学,1v1,0h-70%,2,2,800,70,,1600,1120,"3"`)[0];
  const [normal, leave] = report.courseLines;
  assert.equal(normal.promoLabel, "");
  assert.equal(normal.billingNote, "—");
  assert.equal(leave.billingNote, "请假 70%");
  assert.equal(leave.isLeave, true);
  const web = prepareReportForEditing(report);
  assert.equal(web.courseLines[1].billingNote, "请假 70%");
  assert.equal(updateCourseLine(web, 1, "unitPrice", "900").courseLines[1].payableAmount, 1260);
  assert.deepEqual(validateReport(web).filter((issue) => /价格优惠/.test(issue.message)), []);
});

test("必改2 未知优惠「老带新-90%」改单价后不归零，按原比例并提示", () => {
  let report = webReport(`${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,老带新-90%,2,0,800,100,,1600,1600,"2"`);
  assert.equal(report.courseLines[0].promoUnknown, true);
  assert.equal(report.courseLines[0].billingNote, "老带新-90%（未识别，按原价）");
  report = updateCourseLine(report, 0, "unitPrice", "900");
  assert.equal(report.courseLines[0].payableAmount, 1800);
  const hints = validateReport(report).filter((issue) => issue.level === "warning" && issue.message.includes("老带新-90%"));
  assert.equal(hints.length, 1);
  assert.equal(hints[0].row, 1);
});

test("请假 + 试听：比例相乘，说明写「请假 70% · 试听 收 80%」", () => {
  let report = webReport(`${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,0h-70%,试听-80%,1.5,1.5,300,100,,252,252,"2"`);
  assert.equal(report.courseLines[0].billingNote, "请假 70% · 试听 收 80%");
  report = updateCourseLine(report, 0, "unitPrice", "333");
  assert.equal(report.courseLines[0].payableAmount, 279.72);
  assert.equal(report.courseLines[0].billingNote, "请假 70% · 试听 收 80%");
  const html = render(buildConfirmedReport(report));
  assert.match(html, /<tr class="is-leave is-promo">/);
  assert.match(html, /请假 70% · 试听 收 80%/);
});
