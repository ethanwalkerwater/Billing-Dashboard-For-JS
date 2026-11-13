const assert = require("node:assert/strict");
const { chromium } = require(process.env.FEEDBACK_PLAYWRIGHT || "playwright");

const identity = ["（必填）您的身份", true];
const shared = [
  ["（选填）您如何评价这位老师的整体授课风格？", false],
  ["（选填）您如何评价这位老师的教学进度与节奏把控？", false],
  ["您如何评价这位老师的课堂教学方式？", false],
  ["（选填）如果您可以对我们提一个最希望改进的建议，您最想说的是什么？", false],
];
const branches = [
  ["学生本人", [
    ["（必填）这段时间的课程，对您的成绩提升帮助有多大？", true],
    ["（必填）在整个课程期间，老师是否始终认真负责、态度热情、服务周到？", true],
    ["（必填）您觉得这位老师的个人教学魅力如何？", true],
    ["（选填）在日常学习过程中，您希望老师可以在哪些方面进一步提升？", false],
  ]],
  ["家长/监护人", [
    ["（必填）这段时间的课程，您认为对孩子的成绩提升帮助有多大？", true],
    ["（必填）在整个课程期间，您感受到老师是否始终认真负责、态度热情、服务周到？", true],
    ["（必填）您认为这位老师对学生的教学影响力如何？", true],
    ["顾问老师（Tinko）是否及时帮助学生优化课程安排：", true],
    ["（选填）在孩子的日常学习过程中，您希望老师可以在哪些方面进一步提升？", false],
  ]],
];

async function main() {
  const studentUrl = process.env.FEEDBACK_STUDENT_URL;
  const formUrl = process.env.FEEDBACK_EMBEDDED_FORM_URL;
  assert(studentUrl || formUrl, "请设置现有月度链接 FEEDBACK_STUDENT_URL，或为本地提供预填的 FEEDBACK_EMBEDDED_FORM_URL");
  const browser = await chromium.launch({ executablePath: process.env.FEEDBACK_CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true });
    if (formUrl) {
      await page.route("**/auth/monthly-feedback", (route) => route.fulfill({ json: {
        courseMonth: "2026-11", studentName: "小禾", closed: false,
        teachers: [{ id: "test", name: "陈老师", courses: ["英语"], studentDone: false, parentDone: false, formUrl }],
      } }));
    }
    await page.goto(studentUrl || "http://127.0.0.1:4176/feedback/student.html#test", { waitUntil: "domcontentloaded" });
    const hint = page.getByText("请先在问卷里选择身份（学生 8 题，家长 9 题）。", { exact: true });
    await hint.waitFor({ timeout: 10_000 });
    const frame = page.frameLocator('iframe[title$="的飞书问卷"]');
    // 飞书未给题目容器和必填星号提供语义角色，用原表单的 DOM 核对每个可见题目。
    const cards = frame.locator(".base-form-container_card_item:visible");
    const readQuestions = () => cards.evaluateAll((elements) => elements.map((card) => [
      card.querySelector(".base-form-container_title_wrapper")?.textContent.trim(),
      Boolean(card.querySelector(".base-form-container_red_star")),
    ]));

    await frame.getByText(identity[0], { exact: true }).waitFor();
    assert.deepEqual(await readQuestions(), [identity, ...shared], "未选择身份");
    for (const [role, questions] of branches) {
      await frame.getByText(role, { exact: true }).click();
      await frame.getByText(questions[0][0], { exact: true }).waitFor();
      assert.deepEqual(await readQuestions(), [identity, ...questions, ...shared], role);
      const submit = frame.getByRole("button", { name: "提交", exact: true });
      await submit.scrollIntoViewIfNeeded();
      const bounds = await submit.boundingBox();
      assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height, `${role}可以滑到提交按钮`);
      console.log(`${role}：${questions.length + shared.length} 道反馈题，题目顺序、必填状态和提交按钮均通过`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
