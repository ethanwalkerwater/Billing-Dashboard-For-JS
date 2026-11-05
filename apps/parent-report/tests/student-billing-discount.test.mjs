import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRawScheduleLookup,
  buildStudentReports,
  reportFileName,
  parseCompleteBillingCsv,
} from "../src/student-billing-batch-data.mjs";
import {
  buildConfirmedReport,
  prepareReportForEditing,
  splitBatchReports,
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
    assert.equal(gift.billingNote, "赠课 免费");
    assert.equal(trial.billingNote, "试听 收 80%");
    assert.equal(mock.billingNote, "模拟考试 免费");
    for (const line of [gift, trial, mock]) {
      assert.equal(line.isLeave, false);
      assert.doesNotMatch(line.billingNote, /请假|正常计费/);
    }
  }
  const html = render(buildConfirmedReport(webReport()));
  assert.match(html, /<tr class="is-promo">/);
  assert.match(html, /赠课 免费/);
  assert.doesNotMatch(html, /请假扣费|正常计费/);
});

test("T-B04 日历上赠课那天标优惠名，不标请假", () => {
  const report = webReport();
  const gift = report.lessons.find((lesson) => lesson.date === "2026-11-07");
  assert.equal(gift.isLeave, false);
  assert.equal(gift.isPromo, true);
  assert.equal(gift.promoLabel, "赠课-免费");
  const html = render(buildConfirmedReport(report));
  assert.match(html, /<mark class="promo">赠课 免费<\/mark>/); // C2：和折扣列同一套说法
  assert.doesNotMatch(html, /请假 · 临时取消/);
  assert.match(html, /试听、赠课、模拟考试<\/span>/);
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
  assert.equal(line.billingNote, "赠课 免费");
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
    assert.equal(report.courseLines[0].billingNote, "赠课 免费");
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
  assert.equal(leave.billingNote, "请假 收 70%");
  assert.equal(leave.isLeave, true);
  const web = prepareReportForEditing(report);
  assert.equal(web.courseLines[1].billingNote, "请假 收 70%");
  assert.equal(updateCourseLine(web, 1, "unitPrice", "900").courseLines[1].payableAmount, 1260);
  assert.deepEqual(validateReport(web).filter((issue) => /价格优惠/.test(issue.message)), []);
});

test("必改2 / 对接人定1 未知优惠「老带新-90%」改单价不归零；报错拦住生成，家长看不到「未识别」", () => {
  let report = webReport(`${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,老带新-90%,2,0,800,100,,1600,1600,"2"`);
  assert.equal(report.courseLines[0].promoUnknown, true);
  assert.doesNotMatch(report.courseLines[0].billingNote, /未识别/);
  report = updateCourseLine(report, 0, "unitPrice", "900");
  assert.equal(report.courseLines[0].payableAmount, 1800);
  const errors = validateReport(report).filter((issue) => issue.level === "error" && issue.message.includes("老带新-90%"));
  assert.equal(errors.length, 1);
  // 第 2 轮：提示写上课日期和时间（这一行「原始行」对应的课），不写校对表行号
  assert.equal(errors[0].message, "11月3日 10:00：价格优惠「老带新-90%」还没配置收费比例，请先联系开发");
  assert.throws(() => render(buildConfirmedReport(report)), (error) => error.statusCode === 422 && /还没配置收费比例/.test(error.message));
});

test("对接人定2 病假写「病假 免费」，其他 0% 取消写「请假 免费」", () => {
  const report = batchReport(`${HEAD}
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,学生病假-0%,,2,2,800,0,,0,0,"2"
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,提前取消-0%,,2,2,800,0,,0,0,"3"
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,2h-50%,,2,2,800,50,,800,800,"4"`)[0];
  assert.deepEqual(report.courseLines.map((line) => line.billingNote), ["病假 免费", "请假 免费", "请假 收 50%"]);
  const web = prepareReportForEditing(report);
  assert.deepEqual(web.courseLines.map((line) => line.billingNote), ["病假 免费", "请假 免费", "请假 收 50%"]);
});

test("请假 + 试听：比例相乘，说明写「请假 收 70% · 试听 收 80%」", () => {
  let report = webReport(`${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,0h-70%,试听-80%,1.5,1.5,300,100,,252,252,"2"`, `${SCHEDULE_HEAD}
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/03 10:00,2026/11/03 11:30,300,1.5,252,0h-70%,试听-80%,校区`);
  assert.equal(report.courseLines[0].billingNote, "请假 收 70% · 试听 收 80%");
  report = updateCourseLine(report, 0, "unitPrice", "333");
  assert.equal(report.courseLines[0].payableAmount, 279.72);
  assert.equal(report.courseLines[0].billingNote, "请假 收 70% · 试听 收 80%");
  const html = render(buildConfirmedReport(report));
  assert.match(html, /<tr class="is-leave is-promo">/);
  assert.match(html, /请假 收 70% · 试听 收 80%/);
});

test("用户补充 金额四舍五入到元：三行各 279.5 各显示 ¥280，合计按精确 838.5 显示 ¥839", () => {
  const report = webReport(`${HEAD}
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,正常上课,,1,0,279.5,100,,279.5,279.5,"2"
演示乙-902,2026-11,周老师（演示）,演示物理,1v1,正常上课,,1,0,279.5,100,,279.5,279.5,"3"
演示乙-902,2026-11,周老师（演示）,演示化学,1v1,正常上课,,1,0,279.5,100,,279.5,279.5,"4"`);
  assert.equal(report.totals.payableAmount, 838.5);
  const html = render(buildConfirmedReport(report));
  assert.equal((html.match(/<td>¥280<\/td>/g) || []).length >= 3, true);
  assert.doesNotMatch(html, /<td>¥279<\/td>/);
  assert.match(html, /Total Payable<\/span>\s*<strong>¥839<\/strong>/);
  assert.match(html, /¥839/);
  assert.doesNotMatch(html, /¥840/);
});

const errorsOf = (report) => validateReport(report).filter((issue) => issue.level === "error");
const blocked422 = (pattern) => (error) => error.statusCode === 422 && pattern.test(error.message);

test("B02 课表里的未知优惠（收费 CSV 没有优惠列）单个、批量、渲染都拦下", () => {
  const csv = `${OLD_HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,4,0,800,100,,3200,3200,"2 3"`;
  const schedule = `${SCHEDULE_HEAD}
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/02 10:00,2026/11/02 12:00,800,2,1600,,老带新-90%,校区
演示甲-901,林老师（演示）,演示数学,1v1,2026/11/05 10:00,2026/11/05 12:00,800,2,1600,,,校区`;
  const batch = batchReport(csv, schedule)[0];
  const web = prepareReportForEditing(batch);
  const errors = errorsOf(web);
  assert.deepEqual(errors.map((issue) => issue.message), ["11月2日 10:00：价格优惠「老带新-90%」还没配置收费比例，请先联系开发"]);
  assert.equal(splitBatchReports([web]).ready.length, 0);
  // API / 命令行入口：不经过网页校验也不能渲染
  assert.throws(() => render(batch), blocked422(/11月2日 10:00：价格优惠「老带新-90%」还没配置收费比例/));
  assert.throws(() => render(buildConfirmedReport(web)), blocked422(/老带新-90%/));
});

test("B03 金额和规则对不上（改公式前导出的赠课 1600）拦下；校对页改单价、时长解除不了，改课程表重新导出后放行", () => {
  const csv = `${HEAD}
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"4"
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,正常上课,赠课-免费,2,0,800,100,,1600,1600,"2"
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,0h-70%,试听-80%,1.5,1.5,333,100,,349.65,349.65,"3"`;
  const schedule = (giftAmount, comboAmount) => `${SCHEDULE_HEAD}
演示庚-907,郑老师（演示）,雅思,1v1,2026/11/02 10:00,2026/11/02 12:00,800,2,${giftAmount},,赠课-免费,校区
演示庚-907,郑老师（演示）,雅思,1v1,2026/11/03 10:00,2026/11/03 11:30,333,1.5,${comboAmount},0h-70%,试听-80%,校区
演示庚-907,郑老师（演示）,雅思,1v1,2026/11/04 10:00,2026/11/04 12:00,800,2,1600,,,校区`;
  const batch = batchReport(csv, schedule(1600, 349.65))[0];
  const web = prepareReportForEditing(batch);
  assert.deepEqual(messagesOf(web), [
    "11月2日 10:00：「赠课 免费」这节按规则应收 ¥0.00，课程表里填的是 ¥1,600.00，请先核对课程表",
    "11月3日 10:00：「请假 收 70% · 试听 收 80%」这节按规则应收 ¥279.72，课程表里填的是 ¥349.65，请先核对课程表",
  ]);
  assert.throws(() => render(batch), blocked422(/11月2日 10:00：「赠课 免费」这节按规则应收 ¥0\.00/));
  assert.throws(() => render(buildConfirmedReport(web)), blocked422(/课程表里填的是 ¥1,600\.00/));
  let edited = updateCourseLine(web, 1, "unitPrice", "800");
  edited = updateCourseLine(edited, 2, "duration", "1.5");
  edited = updateCourseLine(edited, 1, "duration", "3");
  assert.equal(messagesOf(edited).length, 2);
  // 改课程表后重新导出：放行
  const fixedCsv = csv.replace("赠课-免费,2,0,800,100,,1600,1600", "赠课-免费,2,0,800,100,,0,0").replace(/349\.65/g, "279.72");
  assert.deepEqual(messagesOf(webReport(fixedCsv, schedule(0, 279.72))), []);
  // 金额和规则一致的优惠行不受影响
  assert.deepEqual(errorsOf(webReport()), []);
});

test("C2 日历标签和折扣列同一套说法：病假 免费、请假 收 70%、试听 收 80%、赠课 免费", () => {
  const csv = `${HEAD}
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,学生病假-0%,,2,2,800,100,,0,0,"2"
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,0h-70%,试听-80%,1.5,1.5,333,100,,279.72,279.72,"3"
演示乙-902,2026-11,周老师（演示）,演示数学,1v1,正常上课,赠课-免费,2,0,800,100,,0,0,"4"`;
  const schedule = `${SCHEDULE_HEAD}
演示乙-902,周老师（演示）,演示数学,1v1,2026/11/12 18:00,2026/11/12 20:00,800,2,0,学生病假-0%,,校区
演示乙-902,周老师（演示）,演示数学,1v1,2026/11/13 18:00,2026/11/13 19:30,333,1.5,279.72,0h-70%,试听-80%,校区
演示乙-902,周老师（演示）,演示数学,1v1,2026/11/14 18:00,2026/11/14 20:00,800,2,0,,赠课-免费,校区`;
  const web = webReport(csv, schedule);
  const [sick, combo, gift] = web.lessons;
  assert.deepEqual([sick.leaveLabel, combo.leaveLabel, combo.promoText, gift.promoText], ["病假 免费", "请假 收 70%", "试听 收 80%", "赠课 免费"]);
  assert.equal(web.courseLines[1].billingNote, `${combo.leaveLabel} · ${combo.promoText}`);
  const html = render(buildConfirmedReport(web));
  assert.match(html, /<mark>病假 免费<\/mark>/);
  assert.match(html, /<mark>请假 收 70%<\/mark>\s*<mark class="promo">试听 收 80%<\/mark>/);
  assert.match(html, /<mark class="promo">赠课 免费<\/mark>/);
  assert.doesNotMatch(html, /请假 · 临时取消|试听-80%|赠课-免费/);
});

test("C3 未知取消标记「1h-60%」和未知优惠一样拦下（收费 CSV 和课表两条输入）", () => {
  const csv = `${HEAD}
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"4"
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,1h-60%,,2,2,800,100,,960,960,"3"`;
  const web = webReport(csv, "");
  assert.deepEqual(errorsOf(web).map((issue) => issue.message), ["取消标记「1h-60%」还没配置收费比例，请先联系开发"]);
  assert.throws(() => render(batchReport(csv, "")[0]), blocked422(/取消标记「1h-60%」还没配置收费比例/));

  const schedule = `${SCHEDULE_HEAD}
演示庚-907,郑老师（演示）,雅思,1v1,2026/11/04 10:00,2026/11/04 12:00,800,2,960,1h-60%,,校区`;
  const fromSchedule = webReport(`${HEAD}
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"4"`, schedule);
  assert.deepEqual(errorsOf(fromSchedule).map((issue) => issue.message), ["11月4日 10:00：取消标记「1h-60%」还没配置收费比例，请先联系开发"]);
  assert.throws(() => render(buildConfirmedReport(fromSchedule)), blocked422(/1h-60%/));
});

test("C4 批量 ZIP 先出能出的学生，被拦下的列出原因", () => {
  const csv = `${HEAD}
演示甲-901,2026-11,林老师（演示）,演示数学,1v1,正常上课,,2,0,800,100,,1600,1600,"2"
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,1h-60%,,2,2,800,100,,960,960,"3"`;
  const reports = batchReport(csv, "").map(prepareReportForEditing);
  const { ready, blocked } = splitBatchReports(reports);
  assert.deepEqual(ready.map((report) => report.studentName), ["演示甲-901"]);
  assert.deepEqual(blocked.map((item) => [item.studentName, item.errors[0].message]), [["演示庚-907", "取消标记「1h-60%」还没配置收费比例，请先联系开发"]]);
});

test("C5 家长能看到的单价四舍五入到元：命令行、网页单个、ZIP 都是 ¥651", () => {
  const csv = `${HEAD}
演示戊-905,2026-11,林老师（演示）,演示数学,1v1,正常上课,,2,0,650.8,100,,1301.6,1301.6,"2"`;
  const batch = batchReport(csv, "")[0];
  const web = webReport(csv, "");
  assert.equal(batch.courseLines[0].unitPriceLabel, "651");
  assert.equal(web.courseLines[0].unitPriceLabel, "651");
  assert.equal(updateCourseLine(web, 0, "unitPrice", "650.8").courseLines[0].unitPriceLabel, "651");
  for (const html of [render(batch), render(buildConfirmedReport(web))]) {
    assert.match(html, /<td>¥651<\/td>/);
    assert.doesNotMatch(html, /650\.8/);
  }
});

// ---- 第 2 轮：金额核对改用 billing-core 逐节判出的「金额与规则不一致」 ----
const R_SCHEDULE_HEAD = "学员课程ID,课程类型,老师,学生,上课时间,下课时间,课程单价,课程时长,课程总价格,临时取消,授课类型,当地上课时间,价格优惠";
const messagesOf = (report) => errorsOf(report).map((issue) => issue.message);

test("B04 优惠行单价读不出（组内 600 / 800、「800元」、空）也拦：免费按应收 ¥0 判，其余写没法核对", () => {
  const schedule = `${R_SCHEDULE_HEAD}
D01,雅思,丁老师（演示）,演示R-954,2026/11/02 10:00,2026/11/02 12:00,600,2,1200,,1v1,,赠课-免费
D02,雅思,丁老师（演示）,演示R-954,2026/11/03 10:00,2026/11/03 12:00,800,2,1600,,1v1,,赠课-免费
E01,雅思,戊老师（演示）,演示R-955,2026/11/02 10:00,2026/11/02 12:00,800元,2,1600,,1v1,,赠课-免费
E02,数学,戊老师（演示）,演示R-955,2026/11/03 10:00,2026/11/03 12:00,,2,1600,,1v1,,试听-80%`;
  const csv = `${HEAD}
演示R-954,2026-11,丁老师（演示）,雅思,1v1,正常上课,赠课-免费,4,0,600 / 800,100,,2800,2800,"2 3"
演示R-955,2026-11,戊老师（演示）,雅思,1v1,正常上课,赠课-免费,2,0,缺失,100,,1600,1600,"4"
演示R-955,2026-11,戊老师（演示）,数学,1v1,正常上课,试听-80%,2,0,缺失,100,,1600,1600,"5"`;
  const [r954, r955] = batchReport(csv, schedule).map(prepareReportForEditing);
  assert.deepEqual(messagesOf(r954), ["11月2日 10:00、11月3日 10:00：「赠课 免费」这几节按规则应收 ¥0.00，课程表里填的是 ¥2,800.00，请先核对课程表"]);
  assert.deepEqual(messagesOf(r955), [
    "11月2日 10:00：「赠课 免费」这节按规则应收 ¥0.00，课程表里填的是 ¥1,600.00，请先核对课程表",
    "11月3日 10:00：「试听 收 80%」这节缺少课程单价，没法核对金额，请先核对课程表",
  ]);
  assert.throws(() => render(buildConfirmedReport(r954)), blocked422(/这几节按规则应收 ¥0\.00/));
  assert.throws(() => render(buildConfirmedReport(r955)), blocked422(/没法核对金额/));
});

test("B04 复现 2：单价留空的赠课 1600 按应收 ¥0 拦下；免费课应付 0 不需要单价，放行", () => {
  const schedule = `${R_SCHEDULE_HEAD}
G9,雅思,郑老师（演示）,演示庚-907,2026/11/04 10:00,2026/11/04 12:00,,2,1600,,1v1,,赠课-免费`;
  const csv = `${HEAD}
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,正常上课,赠课-免费,2,0,,100,,1600,1600,"2"`;
  assert.deepEqual(messagesOf(webReport(csv, schedule)), ["11月4日 10:00：「赠课 免费」这节按规则应收 ¥0.00，课程表里填的是 ¥1,600.00，请先核对课程表"]);
  const freeSchedule = `${R_SCHEDULE_HEAD}
G8,雅思,郑老师（演示）,演示庚-908,2026/11/04 10:00,2026/11/04 12:00,,2,0,,1v1,,赠课-免费
G7,雅思,郑老师（演示）,演示庚-908,2026/11/05 10:00,2026/11/05 12:00,,,0,学生病假-0%,1v1,,`;
  const freeCsv = `${HEAD}
演示庚-908,2026-11,郑老师（演示）,雅思,1v1,正常上课,赠课-免费,2,0,,100,,0,0,"2"
演示庚-908,2026-11,郑老师（演示）,雅思,1v1,学生病假-0%,,0,0,,100,,0,0,"3"`;
  assert.deepEqual(messagesOf(webReport(freeCsv, freeSchedule)), []);
});

test("B06 和课时收费同口径逐节比：6 节 50 分钟试听每节 533.33（合计 3199.98）不拦", () => {
  const rows = [2, 3, 4, 5, 6, 7].map((day) => `B0${day},雅思,乙老师（演示）,演示R-952,2026/11/0${day} 10:00,2026/11/0${day} 10:50,800,0.8333333333333334,533.33,,1v1,,试听-80%`);
  const schedule = `${R_SCHEDULE_HEAD}\n${rows.join("\n")}`;
  const csv = `${HEAD}
演示R-952,2026-11,乙老师（演示）,雅思,1v1,正常上课,试听-80%,4.999998,0,800,100,,3199.98,3199.98,"2 3 4 5 6 7"`;
  assert.deepEqual(messagesOf(webReport(csv, schedule)), []);
});

test("B06 按整数分比，容差 1 分：80.01、8.01 都不拦，80.02 拦", () => {
  const run = (price, amount) => {
    const schedule = `${R_SCHEDULE_HEAD}
T1,雅思,乙老师（演示）,演示乙-902,2026/11/02 10:00,2026/11/02 11:00,${price},1,${amount},,1v1,,试听-80%`;
    const csv = `${HEAD}
演示乙-902,2026-11,乙老师（演示）,雅思,1v1,正常上课,试听-80%,1,0,${price},100,,${amount},${amount},"2"`;
    return messagesOf(webReport(csv, schedule));
  };
  assert.deepEqual(run(100, 80.01), []);
  assert.deepEqual(run(10, 8.01), []);
  assert.deepEqual(run(100, 80.02), ["11月2日 10:00：「试听 收 80%」这节按规则应收 ¥80.00，课程表里填的是 ¥80.02，请先核对课程表"]);
});

test("Q1 取消行金额不符也拦（病假 免费 ¥1,600、请假 收 70% ¥1,600）；11 月以前的课不拦", () => {
  const schedule = `${R_SCHEDULE_HEAD}
G01,雅思,庚老师（演示）,演示R-957,2026/11/02 10:00,2026/11/02 12:00,800,2,1600,0h-70%,1v1,,
G02,雅思,庚老师（演示）,演示R-957,2026/11/03 10:00,2026/11/03 12:00,800,2,1600,学生病假-0%,1v1,,
G00,雅思,庚老师（演示）,演示R-957,2026/10/27 10:00,2026/10/27 12:00,800,2,1600,0h-70%,1v1,,`;
  const csv = `${HEAD}
演示R-957,2026-10,庚老师（演示）,雅思,1v1,0h-70%,,2,2,800,100,,1600,1600,"4"
演示R-957,2026-11,庚老师（演示）,雅思,1v1,0h-70%,,2,2,800,100,,1600,1600,"2"
演示R-957,2026-11,庚老师（演示）,雅思,1v1,学生病假-0%,,2,2,800,100,,1600,1600,"3"`;
  const reports = batchReport(csv, schedule).map(prepareReportForEditing);
  assert.equal(reports.length, 1);
  assert.deepEqual(messagesOf(reports[0]), [
    "11月2日 10:00：「请假 收 70%」这节按规则应收 ¥1,120.00，课程表里填的是 ¥1,600.00，请先核对课程表",
    "11月3日 10:00：「病假 免费」这节按规则应收 ¥0.00，课程表里填的是 ¥1,600.00，请先核对课程表",
  ]);
  const october = prepareReportForEditing(batchReport(`${HEAD}
演示R-957,2026-10,庚老师（演示）,雅思,1v1,0h-70%,,2,2,800,100,,1600,1600,"4"`, schedule)[0]);
  assert.deepEqual(messagesOf(october), []);
});

test("可考虑3 被拦的课在校对页改时长、清单价、改回原值都不解除拦截；改回原值不重算应付", () => {
  const schedule = `${R_SCHEDULE_HEAD}
G9,雅思,郑老师（演示）,演示庚-907,2026/11/04 10:00,2026/11/04 12:00,800,2,1600,,1v1,,赠课-免费`;
  const csv = `${HEAD}
演示庚-907,2026-11,郑老师（演示）,雅思,1v1,正常上课,赠课-免费,2,0,800,100,,1600,1600,"2"`;
  const web = webReport(csv, schedule);
  assert.equal(messagesOf(web).length, 1);
  const same = updateCourseLine(web, 0, "duration", "2");
  assert.equal(same.courseLines[0].payableAmount, 1600);
  for (const edited of [same, updateCourseLine(web, 0, "unitPrice", ""), updateCourseLine(web, 0, "unitPrice", "900")]) {
    assert.equal(messagesOf(edited).length, 1);
    assert.throws(() => render(buildConfirmedReport(edited)), blocked422(/请先核对课程表/));
  }
});

test("可考虑1 试听带手动折扣 90% 写「试听 收 80% · 9 折」", () => {
  const schedule = `${R_SCHEDULE_HEAD}
T1,雅思,乙老师（演示）,演示乙-902,2026/11/02 10:00,2026/11/02 14:00,800,4,2560,,1v1,,试听-80%`;
  const csv = `${HEAD}
演示乙-902,2026-11,乙老师（演示）,雅思,1v1,正常上课,试听-80%,4,0,800,90,,2560,2304,"2"`;
  const batch = batchReport(csv, schedule)[0];
  const web = prepareReportForEditing(batch);
  assert.equal(batch.courseLines[0].billingNote, "试听 收 80% · 9 折");
  assert.equal(web.courseLines[0].billingNote, "试听 收 80% · 9 折");
  assert.equal(updateCourseLine(web, 0, "unitPrice", "900").courseLines[0].billingNote, "试听 收 80% · 9 折");
  assert.match(render(buildConfirmedReport(web)), /试听 收 80% · 9 折/);
});

test("可考虑4 日历图例和折扣列同一套说法", () => {
  const html = render(buildConfirmedReport(webReport()));
  assert.doesNotMatch(html, /临时取消课程/);
  assert.match(html, /<span class="leave"><i><\/i>请假、病假<\/span>/);
  assert.match(html, /<span class="promo"><i><\/i>试听、赠课、模拟考试<\/span>/);
});

test("B05 同名学生按带编号的完整标识匹配：只被自己的课拦，日历不混课，文件名带编号", () => {
  const schedule = `${R_SCHEDULE_HEAD}
H01,雅思,辛老师（演示）,演示同-9901,2026/11/02 10:00,2026/11/02 12:00,800,2,1600,,1v1,,
H02,雅思,辛老师（演示）,演示同-9902,2026/11/03 10:00,2026/11/03 12:00,800,2,1440,,1v1,,老带新-90%
H03,雅思,辛老师（演示）,演示同-9902,2026/11/04 10:00,2026/11/04 12:00,800,2,1600,,1v1,,`;
  const csv = `${HEAD}
演示同-9901,2026-11,辛老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"2"
演示同-9902,2026-11,辛老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"4"
演示同-9902,2026-11,辛老师（演示）,雅思,1v1,正常上课,老带新-90%,2,0,800,100,,1440,1440,"3"`;
  const [a, b] = batchReport(csv, schedule).map(prepareReportForEditing);
  assert.deepEqual([a.studentId, b.studentId], ["演示同-9901", "演示同-9902"]);
  assert.deepEqual(a.lessons.map((lesson) => lesson.date), ["2026-11-02"]);
  assert.deepEqual(b.lessons.map((lesson) => lesson.date), ["2026-11-03", "2026-11-04"]);
  assert.deepEqual(messagesOf(a), []);
  assert.deepEqual(messagesOf(b), ["11月3日 10:00：价格优惠「老带新-90%」还没配置收费比例，请先联系开发"]);
  assert.doesNotThrow(() => render(buildConfirmedReport(a)));
  // 文件名和批量面板带编号，不互相覆盖
  assert.deepEqual([reportFileName(a), reportFileName(b)], ["演示同-9901-2026-11.pdf", "演示同-9902-2026-11.pdf"]);
  assert.deepEqual(splitBatchReports([a, b]).blocked.map((item) => item.studentId), ["演示同-9902"]);
});

test("B07 课表已改对（赠课 0）、收费 CSV 还是旧的 ¥1,600：两份文件对不上，单个、渲染都拦；校对页改单价时长解除不了；11 月以前不拦", () => {
  const schedule = (giftAmount, month = "11") => `${R_SCHEDULE_HEAD}
G1,雅思,甲老师（演示）,演示甲-9001,2026/${month}/02 10:00,2026/${month}/02 12:00,800,2,${giftAmount},,1v1,,赠课-免费`;
  const csv = (amount, month = "11") => `${HEAD}
演示甲-9001,2026-${month},甲老师（演示）,雅思,1v1,正常上课,赠课-免费,2,0,800,100,,${amount},${amount},"2"`;
  const batch = batchReport(csv(1600), schedule(0))[0];
  const web = prepareReportForEditing(batch);
  assert.deepEqual(messagesOf(web), [
    "11月2日 10:00：「雅思 · 赠课 免费」收费明细里是 ¥1,600.00，课程表里是 ¥0.00，两份文件对不上，请先用这份课程表重新导出课时收费",
  ]);
  assert.throws(() => render(batch), blocked422(/两份文件对不上/));
  for (const edited of [updateCourseLine(web, 0, "unitPrice", "0"), updateCourseLine(web, 0, "duration", "0"), updateCourseLine(web, 0, "payableAmount", "0")]) {
    assert.equal(messagesOf(edited).filter((message) => message.includes("两份文件对不上")).length, 1);
  }
  // 重新导出后两边一致：放行；差 1 分以内不拦；10 月旧账不拦
  assert.deepEqual(messagesOf(webReport(csv(0), schedule(0))), []);
  assert.deepEqual(messagesOf(webReport(csv(0.01), schedule(0))), []);
  assert.deepEqual(messagesOf(webReport(csv(1600, "10"), schedule(0, "10"))), []);
});

test("B08 多单价合并行只改课程类型、老师、授课类型、原因，应付和原价不动；改时长才重算", () => {
  const schedule = `${R_SCHEDULE_HEAD}
T1,雅思,甲老师（演示）,演示甲-9001,2026/11/02 10:00,2026/11/02 12:00,600,2,960,,1v1,,试听-80%
T2,雅思,甲老师（演示）,演示甲-9001,2026/11/03 10:00,2026/11/03 12:00,800,2,1280,,1v1,,试听-80%`;
  const csv = `${HEAD}
演示甲-9001,2026-11,甲老师（演示）,雅思,1v1,正常上课,试听-80%,4,0,600 / 800,100,,2240,2240,"2 3"`;
  const web = webReport(csv, schedule);
  assert.equal(web.totals.payableAmount, 2240);
  const before = web.courseLines[0];
  for (const [field, value] of [["courseType", "雅思口语"], ["teacher", "乙老师（演示）"], ["teachingType", "小班"], ["adjustmentReason", "备注"]]) {
    const edited = updateCourseLine(web, 0, field, value);
    const line = edited.courseLines[0];
    assert.equal(line[field], value);
    assert.deepEqual([line.payableAmount, line.grossAmount, line.discountAmount], [before.payableAmount, before.grossAmount, before.discountAmount], field);
    assert.equal(edited.totals.payableAmount, 2240, field);
  }
  assert.equal(updateCourseLine(web, 0, "duration", "4.5").courseLines[0].payableAmount, 0);
});

test("B09 同名无编号：课表两个「演示同名」（甲老师雅思、乙老师数学），收费只有 2h：单个、批量、渲染都拦", () => {
  const schedule = `${R_SCHEDULE_HEAD}
N1,雅思,甲老师（演示）,演示同名,2026/11/02 10:00,2026/11/02 12:00,800,2,1600,,1v1,,
N2,数学,乙老师（演示）,演示同名,2026/11/03 10:00,2026/11/03 12:00,800,2,1600,,1v1,,`;
  const csv = `${HEAD}
演示同名,2026-11,甲老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"2"`;
  const batch = batchReport(csv, schedule)[0];
  const web = prepareReportForEditing(batch);
  const message = "课程表里有多个同名学生「演示同名」，请在课程表的学生名后加编号再导出";
  assert.ok(messagesOf(web).includes(message));
  assert.throws(() => render(batch), blocked422(/多个同名学生「演示同名」/));
  assert.deepEqual(splitBatchReports([web]).blocked.map((item) => item.studentId), ["演示同名"]);
  // 校对页把时长改大也解除不了
  assert.ok(messagesOf(updateCourseLine(web, 0, "duration", "4")).includes(message));
});

test("B09 同名无编号不该拦：只有一个无编号学生、两位老师，课表时长等于汇总时长照常放行", () => {
  const schedule = `${R_SCHEDULE_HEAD}
N1,雅思,甲老师（演示）,演示单名,2026/11/02 10:00,2026/11/02 12:00,800,2,1600,,1v1,,
N2,数学,乙老师（演示）,演示单名,2026/11/03 10:00,2026/11/03 12:00,800,2,1600,,1v1,,`;
  const csv = `${HEAD}
演示单名,2026-11,甲老师（演示）,雅思,1v1,正常上课,,2,0,800,100,,1600,1600,"2"
演示单名,2026-11,乙老师（演示）,数学,1v1,正常上课,,2,0,800,100,,1600,1600,"3"`;
  const web = webReport(csv, schedule);
  assert.deepEqual(messagesOf(web), []);
  assert.doesNotThrow(() => render(buildConfirmedReport(web)));
});
