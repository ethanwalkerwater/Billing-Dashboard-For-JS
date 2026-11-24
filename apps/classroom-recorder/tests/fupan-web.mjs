// Run with local Chrome installed, or set CHROME_BIN. No server or real account is used.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch(
  process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN }
    : { channel: "chrome" },
);
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const root = "https://classroom.invalid";
  const site = process.env.FUPAN_BUILT === "1" ? "../dist-fupan/" : "../fupan/";
  let authenticated = false;
  const course = {
    id: "recExample",
    course: "虚构课程",
    startAt: 1800000000000,
    endAt: 1800003600000,
    teacherName: "示例老师",
    teacherId: "recTeacher",
    student: "虚构学员",
    recording: "有录音",
    analysisStatus: "分析完成",
    hasAudio: true,
    hasTranscript: true,
    pending: 1,
    confirmed: 0,
    summary: "示例概要",
    transcript: [
      {
        start: 9,
        end: 11,
        speaker: "老师",
        text: "<img onerror=window.bad=1>",
      },
    ],
    segments: [],
    metrics: null,
  };
  const issue = {
    category: "课堂惩戒",
    priority: "重要",
    title: "示例事项",
    findingId: "example",
    lessonId: course.id,
    sourceHash: "a".repeat(64),
    version: 1,
    teacherName: course.teacherName,
    course: course.course,
    startAt: course.startAt,
    state: "open",
    evidence: [{ speaker: "老师", start: 9, text: course.transcript[0].text }],
    history: [],
  };
  let requests = [],
    submitted,
    overrideStatus = 0;
  const archived = {
    ...issue,
    historical: true,
    state: "follow",
    sourceHash: "b".repeat(64),
    title: "原转写事项",
    check: "旧版核实说明",
    owner: "历史负责人",
    result: "confirm",
    note: "已约定跟进",
    evidence: [
      { line: 0, start: 57, end: 61, speaker: "老师", text: "此前版本的证据" },
    ],
  };
  const missing = {
    ...archived,
    lessonId: "missing-2026-11-12",
    sourceHash: "c".repeat(64),
    findingId: "rule-missing",
    title: "原日缺录音记录",
    category: "录音缺失",
    result: "refer",
    evidence: [],
    check: "核对当时的排课快照",
  };
  let includeHistory = false;
  const teacher = {
    id: course.teacherId,
    name: course.teacherName,
    classes: ["示例班"],
    subject: "示例学科",
    monthly: 1,
    pending: 1,
    confirmed: 0,
    coverage: {recorded: 3, total: 4},
    modes: {"讲授型": 2, "混合型": 1},
    topMode: "讲授型",
    medianTalkRatio: 0.68,
    recentLessons: [{...course, metrics:{mode:"讲授型"}, miniSegments:[{start:0,end:30,kind:"讲解"}],firstIssue:issue}],
    issues: [issue],
  };
  await page.route(root + "/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.startsWith("/fupan")) {
      const file = url.pathname.replace(/^\/fupan\/?/, "") || "index.html";
      return route.fulfill({
        body: await readFile(new URL(site + file, import.meta.url)),
        contentType: file.endsWith("html")
          ? "text/html"
          : file.endsWith("css")
            ? "text/css"
            : "application/javascript",
      });
    }
    assert.ok(!decodeURIComponent(request.url()).includes("姓名检索样例"));
    const path = url.pathname.replace("/classroom-api/fupan", "");
    requests.push(path);
    assert.equal(request.headers().authorization, undefined);
    assert.equal(request.headers()["x-fupan-request"], "1");
    if (!authenticated) return route.fulfill({ status: 401, json: {} });
    if (path === "/logout") {
      authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (overrideStatus)
      return route.fulfill({
        status: overrideStatus,
        json: { message: "拒绝访问" },
      });
    let data;
    switch (path) {
      case "/me":
        data = { name: "虚构主管" };
        break;
      case "/inbox": {
        const all = includeHistory ? [issue, archived, missing] : [issue];
        const state = url.searchParams.get("state");
        const items = all.filter((item) => item.state === state);
        data = {
          items,
          total: items.length,
          pageSize: 25,
          counts: Object.fromEntries(
            ["open", "follow", "closed"].map((s) => [
              s,
              all.filter((i) => i.state === s).length,
            ]),
          ),
        };
        break;
      }
      case "/decision": {
        submitted = request.postDataJSON();
        const target = [issue, archived, missing].find(
          (it) => it.sourceHash === submitted.sourceHash,
        );
        assert.ok(target);
        target.state = submitted.action === "close" ? "closed" : "follow";
        if (submitted.action !== "close") {
          target.result = "confirm";
          target.owner = submitted.owner;
        }
        target.note = submitted.note;
        data = { ok: true };
        break;
      }
      case "/audio":
        data = { url: "https://audio.invalid/fixture" };
        break;
      case "/lesson":
        data = course;
        break;
      case "/issues":
        data = {
          items: [issue],
          previousItems: includeHistory ? [archived] : [],
        };
        break;
      case "/lessons/search":
        assert.equal(request.method(), "POST");
        assert.equal(request.postDataJSON().q, "姓名检索样例");
      case "/lessons":
        data = {
          date: url.searchParams.get("date") || request.postDataJSON()?.date,
          items: [course],
          scheduleAvailable: true,
        };
        break;
      case "/teachers":
        data =
          request.method() === "POST"
            ? { id: "new" }
            : { items: [teacher], scheduleAvailable: true, month: "2026-11" };
        break;
      case "/random":
        data = { id: course.id };
        break;
      case "/teacher-options/search":
        data = { items: [{ id: "recNew", name: "虚构老师" }] };
        break;
      case "/teacher":
        data = teacher;
        break;
      default:
        throw Error("unexpected " + path);
    }
    return route.fulfill({ json: data });
  });
  // 20 seconds of silent 8-bit PCM so Chrome really decodes, seeks, and plays.
  const silence = Buffer.alloc(44 + 160000, 128);
  silence.write("RIFF", 0);
  silence.writeUInt32LE(silence.length - 8, 4);
  silence.write("WAVEfmt ", 8);
  silence.writeUInt32LE(16, 16);
  silence.writeUInt16LE(1, 20);
  silence.writeUInt16LE(1, 22);
  silence.writeUInt32LE(8000, 24);
  silence.writeUInt32LE(8000, 28);
  silence.writeUInt16LE(1, 32);
  silence.writeUInt16LE(8, 34);
  silence.write("data", 36);
  silence.writeUInt32LE(160000, 40);
  await page.route("https://audio.invalid/**", (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range || "",
    );
    const start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Number(range[2]) : silence.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        ...(range
          ? {
              "Content-Range":
                "bytes " + start + "-" + end + "/" + silence.length,
            }
          : {}),
      },
      body: silence.subarray(start, end + 1),
    });
  });
  await page.goto(root + "/fupan/");
  await page.getByRole("link", { name: "用飞书登录" }).waitFor();
  assert.deepEqual(requests, ["/me"]);
  authenticated = true;
  await page.goto(root + "/fupan/?login=1#token=ignored");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page
    .getByRole("dialog", { name: "复核", exact: true })
    .getByRole("button", { name: "00:09" })
    .click();
  await page
    .getByRole("dialog", { name: "逐字稿与回听" })
    .getByText(course.transcript[0].text, { exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const a = document.querySelector("#player audio");
    return a && !a.paused && a.currentTime >= 9 && a.currentTime < 11;
  });
  assert.equal(requests.filter((p) => p === "/audio").length, 1);
  assert.ok(!page.url().includes("token="));
  assert.equal(await page.locator(".transcript img,.q img").count(), 0);
  await page
    .getByRole("dialog", { name: "逐字稿与回听" })
    .getByRole("button", { name: "关闭" })
    .click();
  await page.getByLabel("确认，安排跟进").check();
  await page.getByLabel("跟进负责人").fill("虚构负责人");
  await page.getByLabel("复核备注").fill("测试结论");
  await page.getByRole("button", { name: "提交复核" }).click();
  await page.getByText("暂无待复核事项").waitFor();
  assert.equal(submitted.owner, "虚构负责人");
  assert.equal(submitted.expectedState, "open");
  await page.getByRole("link", { name: /跟进中/ }).click();
  await page.getByRole("button", { name: "记录结果" }).click();
  await page
    .getByRole("textbox", { name: "跟进结果", exact: true })
    .fill("虚构测试已完成");
  await page.getByRole("button", { name: "关闭事项" }).click();
  await page.getByText("暂无跟进中事项").waitFor();
  assert.equal(submitted.expectedState, "follow");
  includeHistory = true;
  await page.reload();
  const oldRow = page.locator("article").filter({ hasText: archived.title });
  await oldRow.getByText("历史版本", { exact: true }).waitFor();
  await oldRow.getByText("00:57–01:01", { exact: true }).waitFor();
  await oldRow.getByText(archived.evidence[0].text, { exact: true }).waitFor();
  assert.equal(await oldRow.locator("[data-play]").count(), 0);
  const missingRow = page.locator("article").filter({ hasText: missing.title });
  assert.equal(
    await missingRow
      .getByRole("link", { name: "查看当天课程" })
      .getAttribute("href"),
    "#/lessons?date=2026-11-12",
  );
  await missingRow.getByRole("button", { name: "记录结果" }).click();
  const dlg = page.getByRole("dialog", { name: "记录跟进结果" });
  await dlg.getByText("历史版本", { exact: true }).waitFor();
  assert.equal(await dlg.locator("[data-evidence]").count(), 0);
  await dlg.getByRole("textbox", { name: "跟进结果" }).fill("已核对原排课记录");
  await dlg.getByRole("button", { name: "关闭事项" }).click();
  await missingRow.waitFor({ state: "detached" });
  assert.equal(submitted.sourceHash, missing.sourceHash);
  assert.equal(submitted.expectedState, "follow");
  assert.equal(submitted.action, "close");
  await page.getByRole("link", { name: "课程", exact: true }).click();
  await page.getByLabel("搜索老师、课程或学员").fill("姓名检索样例");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/lessons/search")),
    page.getByRole("button", { name: "筛选", exact: true }).click(),
  ]);
  await page.getByRole("link", { name: /虚构课程 · 虚构学员/ }).waitFor();
  assert.ok(!decodeURIComponent(page.url()).includes("姓名检索样例"));
  assert.ok(requests.includes("/lessons/search"));
  await page.getByRole("button", { name: "课表", exact: true }).click();
  await page.getByRole("link", { name: /虚构课程 · 虚构学员/ }).click();
  const oldSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "历史版本的复核记录" }) });
  await oldSection.getByText("00:57–01:01").waitFor();
  await oldSection.getByText(/跟进中 · 已确认 · 负责人 历史负责人/).waitFor();
  assert.equal(await oldSection.locator("[data-play]").count(), 0);
  await oldSection.getByRole("button", { name: "记录结果" }).click();
  await dlg.getByText("00:57–01:01").waitFor();
  assert.equal(await dlg.locator("[data-evidence],[data-play]").count(), 0);
  await dlg.getByRole("textbox", { name: "跟进结果" }).fill("原事项已办结");
  await dlg.getByRole("button", { name: "关闭事项" }).click();
  await oldSection
    .getByText(/已关闭 · 已确认 · 负责人 历史负责人 · 原事项已办结/)
    .waitFor();
  assert.equal(submitted.sourceHash, archived.sourceHash);
  assert.equal(submitted.action, "close");
  assert.equal(requests.filter((p) => p === "/audio").length, 1);
  assert.equal(await page.getByText(/课程概要|听课记录|示例概要/).count(), 0);
  assert.ok(!requests.includes("/notes"));
  await page.getByRole("link", { name: "老师", exact: true }).click();
  await page.getByRole("button", { name: "添加老师" }).click();
  await page.getByRole("textbox", { name: "老师姓名" }).fill("虚构");
  await page.getByRole("button", { name: "查找" }).click();
  await page.getByText("共 1 个档案。").waitFor();
  await page.getByLabel("年级").fill("初二");
  await page.getByLabel("所教班级").fill("示例班");
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByRole("row").filter({hasText:"示例老师"}).click({position:{x:250,y:14}});
  await page.getByRole("heading", { name: teacher.name, exact:true }).waitFor();
  assert.equal(await page.getByText(/听课记录/).count(), 0);
  assert.match(await page.locator(".teacher-stats").innerText(), /3\s*\/ 4 节/);
  assert.equal(await page.locator(".teacher-columns .mbar").count(), 4);
  assert.equal(await page.locator(".teacher-course-table .timeline").count(), 1);
  const [courses, aside] = await Promise.all([".teacher-columns > section",".teacher-columns > aside"].map(s => page.locator(s).boundingBox()));
  assert.ok(courses.x + courses.width <= aside.x && Math.abs(courses.y - aside.y) < 2);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  await page.getByRole("button", { name: "抽一节课" }).click();
  await page.getByRole("heading", { name: "时间档案" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("link", { name: "待处理", exact: false })
    .first()
    .click();
  await page.getByText("暂无待复核事项").waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  overrideStatus = 403;
  await page.getByRole("link", { name: "课程", exact: true }).click();
  await page.getByText("当前飞书账号没有课堂复盘权限。").waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("fupan-session")),
    null,
  );
  assert.equal(
    await page.locator("#root").getByText(course.teacherName).count(),
    0,
  );
  overrideStatus = 0;
  await page.reload();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByRole("link", { name: "用飞书登录" }).waitFor();
  assert.equal(authenticated, false);
  assert.ok(requests.includes("/logout"));
  assert.deepEqual(errors, []);
  console.log("Fupan browser flow passed (synthetic, desktop and mobile).");
} finally {
  await browser.close();
}
