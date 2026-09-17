import test from "node:test";
import assert from "node:assert/strict";
import writeXlsxFile from "write-excel-file/node";
import { strFromU8, unzipSync } from "fflate";

import {
  buildIncomeWorkbook,
  buildIncomeWorkbookSheets,
} from "../web/assets/income-workbook.js";

function fixtureModel() {
  return {
    month: "2026-08",
    summaryHeaders: ["老师", "个人总收入"],
    summaryRows: [["张老师", 12000], ["李/老师", 9000]],
    summaryCurrencyColumns: [2],
    summaryRateColumns: [],
    teachers: ["张老师", "李/老师"].map((teacher) => ({
      teacher,
      employmentType: "全职",
      personalTotalIncome: 12000,
      companyTotalCost: 13000,
      financialHeaders: ["类型", "项目", "来源", "公式", "金额"],
      financialRows: [["加项", "管理费", "主数据", "", 1000]],
      lessonHeaders: ["学生", "课程单价", "乘数", "乘数原因", "实际金额"],
      lessonRows: [["学生A", 800, 1.3, "晚间课程", 1040]],
      lessonCurrencyColumns: [5],
      extraHeaders: ["项目说明", "调整金额（元）"],
      extraRows: [["临时代课补贴", 300], ["合计", 300]],
      extraCurrencyColumns: [2],
      commissionHeaders: ["类型", "学生", "说明", "计提基数", "比例", "金额"],
      commissionRows: [["归属提成", "学生A", "", 1000, 0.2, 200]],
    })),
  };
}

test("monthly income workbook contains summary and one sheet per teacher", async () => {
  const model = fixtureModel();
  const sheets = buildIncomeWorkbookSheets(model);

  assert.deepEqual(sheets.map((sheet) => sheet.sheet), ["本月汇总", "张老师", "李-老师"]);
  assert.equal(sheets[0].data[2][0].value, "老师");
  assert.equal(sheets[1].data.flat().some((cell) => cell?.value === "乘数"), true);
  assert.equal(sheets[1].data.flat().some((cell) => cell?.value === "乘数原因"), true);
  assert.equal(sheets[1].data.flat().some((cell) => cell?.value === "额外收入与扣款"), true);
  assert.equal(sheets[1].data.flat().some((cell) => cell?.value === "临时代课补贴"), true);

  const buffer = await buildIncomeWorkbook(writeXlsxFile, model).toBuffer();
  const files = unzipSync(buffer);
  const workbookXml = strFromU8(files["xl/workbook.xml"]);
  assert.match(workbookXml, /name="本月汇总"/);
  assert.match(workbookXml, /name="张老师"/);
  assert.match(workbookXml, /name="李-老师"/);
  assert.ok(files["xl/worksheets/sheet1.xml"]);
  assert.ok(files["xl/worksheets/sheet3.xml"]);
});
