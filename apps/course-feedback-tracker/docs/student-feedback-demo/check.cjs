const assert = require("node:assert/strict");
const { chromium } = require(process.env.FEEDBACK_PLAYWRIGHT || "playwright");

const previewUrl = process.env.FEEDBACK_DEMO_URL || "http://127.0.0.1:4193/";
const url = new URL("?mode=demo", previewUrl).href;
const chromePath = process.env.FEEDBACK_CHROME;
const screenshotDir = process.env.FEEDBACK_SCREENSHOTS;

async function scrollToFeishuFooter(page, iframe) {
  const frame = iframe.contentFrame();
  const submit = frame.getByRole("button", { name: "提交", exact: true }).first();
  const bounds = await iframe.boundingBox();
  const submitBounds = await submit.boundingBox();
  assert.ok(submitBounds.y + submitBounds.height <= bounds.y + bounds.height, "只读 iframe 应完整显示到飞书提交按钮");

  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(bounds.x + bounds.width / 2);
  const viewportHeight = page.viewportSize().height;
  const startY = viewportHeight - 110;
  for (let swipe = 0; swipe < 10; swipe++) {
    const button = await submit.boundingBox();
    if (button.y >= 100 && button.y + button.height <= viewportHeight) return;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY - step * 55 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  assert.fail("手机手势应该能从飞书问卷区域滑到提交按钮");
}

async function main() {
  const browser = await chromium.launch({ executablePath: chromePath });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(url);

    const assertProgress = async (count) => {
      assert.equal(await page.locator("#progress-text").textContent(), `已提交 ${count} / 3 份`);
      assert.equal(await page.locator('[role="tab"] [data-state="done"]').count(), count);
    };
    const assertHeading = async (text) => assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), text);
    const rate = async () => {
      for (const group of await page.getByRole("group").all()) await group.getByRole("radio", { name: "4 分", exact: true }).check();
    };
    const capture = async (name, options) => {
      if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png`, ...options });
    };

    await assertHeading("评价周老师");
    await assertProgress(0);
    assert.ok((await page.locator(".top").boundingBox()).height <= 100);
    assert.equal(await page.getByRole("tab", { name: /周老师.*待评价/, selected: true }).count(), 1);
    await page.getByRole("tab", { name: /周老师/ }).focus();
    await page.keyboard.press("ArrowRight");
    await assertHeading("评价陈老师");
    assert.equal(await page.getByText("雅思写作、雅思口语", { exact: true }).count(), 1);

    await page.getByRole("button", { name: "提交并继续" }).click();
    assert.match(await page.getByRole("alert").textContent(), /各选一个分数/);
    await assertProgress(0);
    await rate();
    await page.getByRole("button", { name: "提交并继续" }).click();
    await assertHeading("评价许老师");
    await assertProgress(1);
    assert.equal(await page.getByRole("tab", { name: /陈老师.*已提交/ }).count(), 1);
    assert.equal(await page.getByRole("tab", { name: /许老师/, selected: true }).count(), 1);
    assert.equal(await page.getByRole("status").textContent(), "陈老师的反馈已提交。");
    await capture("student-feedback-tabs", { clip: { x: 0, y: 0, width: 390, height: 610 } });

    await page.getByRole("group").first().getByRole("radio", { name: "3 分", exact: true }).check();
    await page.getByRole("tab", { name: /陈老师.*已提交/ }).click();
    await assertHeading("陈老师的反馈已提交");
    assert.equal(await page.getByRole("tab", { name: /许老师.*有草稿/ }).count(), 1);
    const originalLink = page.url();
    await page.close();
    const reopened = await context.newPage();
    reopened.on("pageerror", (error) => errors.push(error));
    await reopened.goto(originalLink);
    assert.equal(await reopened.getByRole("heading", { level: 1 }).textContent(), "评价许老师");
    assert.equal(await reopened.locator("#progress-text").textContent(), "已提交 1 / 3 份");
    assert.equal(await reopened.getByRole("group").first().getByRole("radio", { name: "3 分", exact: true }).isChecked(), true);
    await reopened.getByRole("button", { name: "保存，稍后继续" }).click();
    assert.equal(await reopened.getByRole("tab", { name: /许老师.*有草稿/, selected: true }).count(), 1);
    await reopened.reload();
    assert.equal(await reopened.getByRole("heading", { level: 1 }).textContent(), "评价许老师");

    for (const next of ["评价周老师", "本月反馈已全部提交"]) {
      for (const group of await reopened.getByRole("group").all()) await group.getByRole("radio", { name: "4 分", exact: true }).check();
      await reopened.getByRole("button", { name: /提交并继续|^提交反馈$/ }).click();
      assert.equal(await reopened.getByRole("heading", { level: 1 }).textContent(), next);
    }
    await reopened.reload();
    assert.equal(await reopened.locator("#progress-text").textContent(), "已提交 3 / 3 份");
    assert.equal(await reopened.getByRole("heading", { level: 1 }).textContent(), "本月反馈已全部提交");
    assert.equal(await reopened.evaluate(() => JSON.parse(localStorage.getItem("jingshi-demo:xiaohe:2026-10")).zhou.parentSubmitted), true);
    assert.equal(await reopened.locator('[data-state="done"]').count(), 3);
    await reopened.getByRole("tab", { name: /周老师.*已提交/ }).click();
    assert.equal(await reopened.getByRole("heading", { level: 1 }).textContent(), "周老师的反馈已提交");
    assert.equal(await reopened.locator("form").count(), 0);
    assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);

    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktop.goto(url);
    assert.equal(await desktop.locator("#progress-text").textContent(), "已提交 0 / 3 份");
    assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    console.log("通过：老师 Tab 点击和键盘切换、已提交与草稿状态、学生独立计数、逐份提交、关闭后续填。");

    if (process.env.FEEDBACK_LIVE === "1") {
      for (const width of [390, 1280]) {
        const live = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
        if (width === 390) {
          const cdp = await live.context().newCDPSession(live);
          await cdp.send("Network.enable");
          await cdp.send("Network.setCookieControls", { enableThirdPartyCookieRestriction: true, disableThirdPartyCookieMetadata: true, disableThirdPartyCookieHeuristics: true });
        }
        await live.addInitScript(() => {
          window.frameMessages = [];
          window.addEventListener("message", (event) => {
            if (event.source === document.querySelector("#embed iframe")?.contentWindow) window.frameMessages.push(event.origin);
          });
        });
        await live.goto(previewUrl, { waitUntil: "domcontentloaded" });
        const iframe = live.locator("#embed iframe");
        assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts allow-same-origin");
        const title = iframe.contentFrame().getByText("课程反馈问卷", { exact: true }).first();
        await title.waitFor({ state: "visible", timeout: 30_000 });
        await live.getByRole("tab", { name: /陈老师/ }).click();
        assert.equal(await live.getByRole("tab", { selected: true }).textContent(), "陈老师待评价");
        assert.equal(await live.getByRole("tabpanel").getByText("雅思写作、雅思口语", { exact: true }).count(), 1);
        assert.equal(await live.getByRole("heading", { level: 1 }).count(), 0);
        assert.equal(await live.getByRole("link", { name: "只读预览 · 去试填" }).count(), 1);
        assert.ok((await iframe.boundingBox()).y <= 155, "飞书问卷应该紧接老师标签和课程行");
        await title.waitFor({ state: "visible" });
        assert.equal(await live.locator("#progress-text").textContent(), "已提交 0 / 3 份");
        if (width === 390 && screenshotDir) {
          await live.screenshot({ path: `${screenshotDir}/student-feedback-feishu.png`, clip: { x: 0, y: 0, width, height: 720 } });
        }
        if (width === 390) await scrollToFeishuFooter(live, iframe);
        console.log(`飞书 iframe ${width}px：显示实际问卷，加载阶段父页收到 ${await live.evaluate(() => window.frameMessages.length)} 条消息。`);
        await live.close();
      }
    }

    if (process.env.FEEDBACK_PILOT_URL) {
      const pilotUrl = process.env.FEEDBACK_PILOT_URL;
      const pilot = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
      await pilot.goto(pilotUrl);
      const first = pilot.getByRole("tab", { selected: true });
      assert.equal(await pilot.getByRole("tab").count(), 8);
      assert.equal(await pilot.locator("#progress-text").textContent(), "已提交 0 / 8 份");
      assert.ok((await pilot.locator(".top").boundingBox()).height <= 100);
      assert.equal(await pilot.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await first.focus();
      await pilot.keyboard.press("End");
      const tabStrip = await pilot.getByRole("tablist").boundingBox();
      const last = await pilot.getByRole("tab", { selected: true }).boundingBox();
      assert.ok(last.x >= tabStrip.x && last.x + last.width <= tabStrip.x + tabStrip.width);
      for (const group of await pilot.getByRole("group").all()) await group.getByRole("radio", { name: "4 分", exact: true }).check();
      await pilot.getByRole("button", { name: "提交并继续" }).click();
      assert.equal(await pilot.locator("#progress-text").textContent(), "已提交 1 / 8 份");
      assert.equal(await pilot.getByRole("tab", { name: /已提交/ }).count(), 1);
      const embedUrl = new URL("?mode=feishu", pilotUrl);
      await pilot.goto(embedUrl.href, { waitUntil: "domcontentloaded" });
      const iframe = pilot.locator("#embed iframe");
      const previous = await iframe.getAttribute("src");
      await pilot.getByRole("tab", { selected: true }).focus();
      await pilot.keyboard.press("ArrowRight");
      const current = new URL(await iframe.getAttribute("src"));
      assert.notEqual(current.href, previous);
      assert.equal(current.searchParams.get("prefill_反馈课程月份"), "2026-11");
      await iframe.contentFrame().getByText("课程反馈问卷", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
      await scrollToFeishuFooter(pilot, iframe);
      await pilot.goto(pilotUrl);
      assert.equal(await pilot.locator("#progress-text").textContent(), "已提交 1 / 8 份");
      const guessed = await pilot.request.get(new URL("/p/unissued", pilotUrl).href);
      assert.equal(guessed.status(), 404);
      console.log("通过：真实任务 8 个、360px 横滑切换、飞书逐老师预填、模拟提交后续填、非邀请路径返回 404。");
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
