import test from "node:test";
import assert from "node:assert/strict";

import { renderStudentBillingReportHtml } from "../src/render-student-billing-report.mjs";

const report = {
  brandName: "菁仕",
  brandEnglish: "JINGSHI EDUCATION",
  studentName: "Ivy",
  month: "2026-03",
  monthLabel: "2026年3月",
  monthEnglish: "March 2026",
  totals: {
    grossAmount: 3300,
    discountAmount: 390,
    payableAmount: 2910,
    duration: 4,
    cancelledDuration: 2,
  },
  courseLines: [
    {
      teacher: "李品轩",
      courseType: "Alevel物理",
      teachingType: "1v1",
      isLeave: false,
      duration: 2,
      unitPriceLabel: "1,000",
      grossAmount: 2000,
      payableAmount: 2000,
      discountAmount: 0,
      discountRate: 100,
      discountReason: "",
      billingNote: "—",
    },
    {
      teacher: "李品轩",
      courseType: "Alevel物理",
      teachingType: "1v1",
      isLeave: true,
      duration: 2,
      unitPriceLabel: "650",
      grossAmount: 1300,
      payableAmount: 910,
      discountAmount: 390,
      discountRate: 70,
      discountReason: "临时请假",
      billingNote: "请假 70%",
    },
  ],
  calendar: {
    weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    cells: [
      { inMonth: true, day: 1, lessons: [] },
      { inMonth: true, day: 2, lessons: [] },
      {
        inMonth: true,
        day: 3,
        lessons: [{
          startTime: "15:15",
          endTime: "17:15",
          courseType: "Alevel物理",
          teacher: "李品轩",
          duration: 2,
          isLeave: false,
        }],
      },
      {
        inMonth: true,
        day: 4,
        lessons: [{
          startTime: "10:00",
          endTime: "12:00",
          courseType: "Alevel物理",
          teacher: "李品轩",
          duration: 2,
          isLeave: true,
          leaveLabel: "请假 · 临时取消",
        }],
      },
    ],
  },
  activeTeacherNames: ["李品轩"],
};

const teachers = [
  {
    name: "李品轩",
    subject: "物理",
    photo: null,
    tag: "IGCSE / A-Level 物理",
    desc: "物理老师简介",
    scores: { 学习提升: null, 责任心: null, 个人魅力: null },
  },
  {
    name: "应雁心",
    subject: "数学",
    photo: null,
    tag: "A-Level 数学",
    desc: "数学老师简介",
    scores: { 学习提升: null, 责任心: null, 个人魅力: null },
  },
];

test("renderStudentBillingReportHtml renders approved sections", () => {
  const html = renderStudentBillingReportHtml(report, teachers, { embedTeacherPhotos: false });

  assert.match(html, /<title>Ivy 2026年3月课时费明细<\/title>/);
  assert.match(html, /<h1 class="cover-student-name">Ivy<\/h1>/);
  assert.match(html, /<strong>2026年3月<\/strong>/);
  assert.match(html, /March 2026/);
  assert.match(html, /¥2,910/);
  assert.match(html, /<table>/);
  assert.match(html, /Alevel物理/);
  assert.match(html, /请假 70%/);
  assert.match(html, /class="calendar-wrap"/);
  assert.match(html, /class="lesson-pill leave"/);
  assert.match(html, /授课老师/);
  assert.match(html, /更多老师/);
  assert.match(html, /<h3>李品轩<\/h3>/);
  assert.match(html, /<h3>应雁心<\/h3>/);
});
