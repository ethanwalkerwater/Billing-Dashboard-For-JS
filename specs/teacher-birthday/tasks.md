# 老师生日祝福 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书老师档案 + 生日前 3 天私信教务预填问卷 + 生日当天 9:00 群卡片 + 3D 生日祝福网站，全程可在测试群演练。

**Architecture:** 新 workspace `apps/teacher-birthday`。纯函数领域层 `src/domain/`（日期、统计、寄语、卡片、页面数据形状）前后端共用；单个 CloudBase 云函数 `birthday-api` 处理定时任务、演练和网页数据接口，状态全部存飞书（不建数据库）；网页是 Vite + TypeScript + three.js 静态站，挂在 `app.jsjy.asia/birthday/`。

**Tech Stack:** TypeScript、node:test + tsx、esbuild（函数打包）、Vite 7、three.js、CloudBase CLI（`tcb`）、飞书开放平台 API（机器人「课表分析」`cli_a93a4faca0f8dcb6`）。

**Spec:** `specs/teacher-birthday/design.md`

## Global Constraints

- 时区固定 Asia/Shanghai（UTC+8，不用 Intl 反查）；飞书日期字段 = 当天 00:00（上海）的毫秒时间戳。
- 定时触发 cron：`0 0 9 * * * *`（CloudBase 7 段式）。
- 生日 2/29 在平年按 2/28；问卷提前 3 天（`ASK_DAYS_BEFORE = 3`）；上线时 0–3 天内的生日当天补发。
- 网页与接口不得返回手机、微信、出生年份、年龄；「隐藏」勾选的祝福在服务端过滤。
- 页面 token = `recordId.year.HMAC-SHA256(PAGE_TOKEN_PEPPER, "recordId:year")` 的 base64url 前 22 位。
- 密钥只在 `apps/teacher-birthday/server.env`（gitignore）；不入 Git、不进前端。
- 真实老师数据只在飞书；仓库里不放真实姓名以外的个人信息，一次性导入脚本放 scratchpad、不提交。
- AI 走 OpenAI 兼容 `POST {AI_BASE_URL}/chat/completions`；失败或未配置一律回退模板寄语，绝不阻断 9:00 群消息。
- 网页 three.js 由 Vite 打包（国内访问，不用 CDN、不用 Google Fonts）；必须在飞书内置浏览器可用。
- 测试期收件人：`BIRTHDAY_ACADEMIC_OPEN_IDS` = 徐翰超 open_id；`BIRTHDAY_GROUP_CHAT_ID` = `oc_0fb80402fe51d4490132e94554af137d`（生日通知测试）。

## Review Focus

1. 定时任务同一天跑两次（重试 / 手动补跑）→ 不重复发问卷、不重复发群卡片（Task 1 `dueActions` 用已发年份；Task 4 只在发送成功后写年份）。
2. 年末跨年：12/30 时 1/2 生日的老师要发问卷，年份记为下一年（Task 1 测试）。
3. 老师没填生日 / 不在职 / 没填入职时间 → 不报错，跳过或页面隐藏「第 N 天」（Task 1、Task 2 测试）。
4. token 改了年份或签名、或其他老师的 recordId → 403，且不泄露隐藏祝福（Task 2 测试 + Task 4 `pageData`）。
5. 0 条祝福、纯文字祝福、GIF/视频附件、麦克风被拒、WebGL 不可用 → 页面仍完整可读（Task 5 demo 场景逐一验证）。

---

### Task 1: 应用骨架 + 生日日期规则

**Files:**
- Create: `apps/teacher-birthday/package.json`, `tsconfig.json`, `.gitignore`, `server.env.example`
- Create: `apps/teacher-birthday/src/domain/dates.ts`
- Test: `apps/teacher-birthday/tests/dates.test.ts`
- Modify: `package.json`（根）scripts

**Interfaces:**
- Produces:
  - `type Ymd = { y: number; m: number; d: number }`
  - `shanghaiYmd(ms: number): Ymd`, `ymdToMs(ymd: Ymd): number`（上海 00:00）
  - `birthdayIn(year: number, birth: Ymd): Ymd`
  - `nextBirthday(today: Ymd, birth: Ymd): { date: Ymd; daysLeft: number }`
  - `interface TeacherRow { recordId; name; scheduleName; subject; birthMs: number|null; joinMs: number|null; active: boolean; openId: string|null; askedYear: number|null; celebratedYear: number|null; handwritten: string; aiBlessing: string; teaching: string; intro: string; photoToken: string|null; stats: LessonStats|null }`
  - `interface LessonStats { lessons: number; students: number; hours: number }`
  - `type DueAction = { teacher: TeacherRow; kind: "ask" | "celebrate"; date: Ymd; daysLeft: number }`
  - `dueActions(teachers: TeacherRow[], todayMs: number): DueAction[]`
  - `tenure(joinMs: number | null, todayMs: number): { days: number; candles: number } | null`

- [ ] **Step 1: 建分支与骨架**

```bash
git switch -c feat/teacher-birthday main
mkdir -p apps/teacher-birthday/{src/domain,src/server,src/web,functions/birthday-api,scripts,tests}
```

`apps/teacher-birthday/package.json`：

```json
{
  "name": "@jingshi/teacher-birthday",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "菁仕老师生日祝福：飞书老师档案、生日前问卷、生日当天群卡片和 3D 祝福网站。",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 4179",
    "build": "tsc --noEmit && vite build",
    "test": "tsx --test tests/*.test.ts",
    "deploy:functions": "node scripts/deploy-function.mjs",
    "deploy:web": "npm run build && tcb hosting deploy dist /birthday -e jingshi-test-d5gp401i44a0fa7a7",
    "rehearse": "node scripts/rehearse.mjs"
  },
  "dependencies": { "three": "^0.180.0" },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@types/three": "^0.180.0",
    "esbuild": "^0.28.2",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2",
    "vite": "^7.1.4"
  }
}
```

`tsconfig.json` 复制 `apps/ielts-progress/tsconfig.json`，删掉 `"jsx"` 和 `paths`，`include` 改为 `["src", "tests", "functions", "scripts", "vite.config.ts"]`。
`.gitignore`：`dist/`、`dist-functions/`、`node_modules/`、`server.env`、`cloudbaserc.local.json`。

`server.env.example`：

```bash
# 仅用于云函数 birthday-api；飞书应用 = 机器人「课表分析」（同 course-feedback-tracker/cancel.env）
FEISHU_APP_ID=
FEISHU_APP_SECRET=
TEACHER_APP_TOKEN=JfncbHflsaXCKTsTyjycnBtYnsf
TEACHER_TABLE_ID=tbl04lXBPk2YkIif
WISH_TABLE_ID=
WISH_FORM_URL=
SCHEDULE_APP_TOKEN=Xb34bXSVRaQk7ysfAQScPZp5nPh
SCHEDULE_TABLE_ID=tblWoTVtU4lqJoes
# 测试期：只填徐翰超；上线换成华心晨、Tinko（逗号分隔 open_id）
BIRTHDAY_ACADEMIC_OPEN_IDS=
# 测试期：生日通知测试群 oc_0fb80402fe51d4490132e94554af137d；上线换正式老师群
BIRTHDAY_GROUP_CHAT_ID=
PAGE_BASE_URL=https://app.jsjy.asia/birthday/
# ≥ 32 位随机串
PAGE_TOKEN_PEPPER=
# OpenAI 兼容接口；留空则用模板寄语
AI_BASE_URL=https://jingshi-test-d5gp401i44a0fa7a7.api.tcloudbasegateway.com/v1/ai/deepseek
AI_API_KEY=
AI_MODEL=deepseek-v3
```

根 `package.json` scripts 增加 `"dev:teacher-birthday"`、`"build:teacher-birthday"`、`"test:teacher-birthday": "npm test -w @jingshi/teacher-birthday"`，并把 `npm run test:teacher-birthday` 追加到 `test` 链末尾。运行 `npm install`（默认 node 是 v14，用 `/opt/homebrew/bin/node`/`npm`）。

- [ ] **Step 2: 写失败测试** `tests/dates.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { dueActions, nextBirthday, shanghaiYmd, tenure, ymdToMs } from "../src/domain/dates";
import type { TeacherRow } from "../src/domain/dates";

const at = (y: number, m: number, d: number, hour = 9) => ymdToMs({ y, m, d }) + hour * 3600_000;
const teacher = (over: Partial<TeacherRow>): TeacherRow => ({
  recordId: "rec1", name: "汤朔", scheduleName: "汤朔", subject: "物理",
  birthMs: ymdToMs({ y: 1995, m: 10, d: 12 }), joinMs: null, active: true, openId: null,
  askedYear: null, celebratedYear: null, handwritten: "", aiBlessing: "", teaching: "", intro: "",
  photoToken: null, stats: null, ...over,
});

test("shanghaiYmd: UTC 16:30 已是上海次日", () => {
  assert.deepEqual(shanghaiYmd(Date.UTC(2026, 9, 11, 16, 30)), { y: 2026, m: 10, d: 12 });
});

test("nextBirthday: 2/29 平年按 2/28，跨年取下一年", () => {
  assert.deepEqual(nextBirthday({ y: 2027, m: 2, d: 1 }, { y: 2000, m: 2, d: 29 }).date, { y: 2027, m: 2, d: 28 });
  assert.deepEqual(nextBirthday({ y: 2028, m: 2, d: 1 }, { y: 2000, m: 2, d: 29 }).date, { y: 2028, m: 2, d: 29 });
  const wrap = nextBirthday({ y: 2026, m: 12, d: 30 }, { y: 1990, m: 1, d: 2 });
  assert.deepEqual(wrap, { date: { y: 2027, m: 1, d: 2 }, daysLeft: 3 });
});

test("dueActions: 提前 3 天发问卷，当天发祝福", () => {
  const t = teacher({});
  assert.deepEqual(dueActions([t], at(2026, 10, 9)).map((a) => [a.kind, a.daysLeft]), [["ask", 3]]);
  assert.deepEqual(dueActions([t], at(2026, 10, 8)), []);
  const today = dueActions([teacher({ askedYear: 2026 })], at(2026, 10, 12));
  assert.deepEqual(today.map((a) => a.kind), ["celebrate"]);
});

test("dueActions: 上线补发——生日在 0–3 天内且今年没发过问卷", () => {
  assert.deepEqual(dueActions([teacher({})], at(2026, 10, 11)).map((a) => a.kind), ["ask"]);
  assert.deepEqual(dueActions([teacher({})], at(2026, 10, 12)).map((a) => a.kind), ["ask", "celebrate"]);
});

test("dueActions: 已发年份防重复，跨年按生日所在年份记", () => {
  assert.deepEqual(dueActions([teacher({ askedYear: 2026, celebratedYear: 2026 })], at(2026, 10, 12)), []);
  const jan = teacher({ birthMs: ymdToMs({ y: 1990, m: 1, d: 2 }), askedYear: 2026 });
  const actions = dueActions([jan], at(2026, 12, 30));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].date.y, 2027);
});

test("dueActions: 没生日、不在职的老师跳过", () => {
  assert.deepEqual(dueActions([teacher({ birthMs: null }), teacher({ active: false })], at(2026, 10, 12)), []);
});

test("tenure: 第 N 天与蜡烛数（至少 1 根，最多 12 根）", () => {
  assert.equal(tenure(null, at(2026, 10, 12)), null);
  assert.deepEqual(tenure(ymdToMs({ y: 2026, m: 10, d: 12 }), at(2026, 10, 12)), { days: 1, candles: 1 });
  assert.deepEqual(tenure(ymdToMs({ y: 2023, m: 10, d: 13 }), at(2026, 10, 12)), { days: 1096, candles: 2 });
  assert.deepEqual(tenure(ymdToMs({ y: 2000, m: 1, d: 1 }), at(2026, 10, 12))?.candles, 12);
  assert.equal(tenure(ymdToMs({ y: 2027, m: 1, d: 1 }), at(2026, 10, 12)), null);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `/opt/homebrew/bin/npm test -w @jingshi/teacher-birthday`
Expected: FAIL，`Cannot find module '../src/domain/dates'`

- [ ] **Step 4: 实现** `src/domain/dates.ts`

```ts
/** 生日日期规则。纯函数；时区固定上海 UTC+8。 */
const DAY = 86_400_000;
const SHANGHAI = 8 * 3600_000;
export const ASK_DAYS_BEFORE = 3;

export type Ymd = { y: number; m: number; d: number };
export interface LessonStats { lessons: number; students: number; hours: number }

export interface TeacherRow {
  recordId: string;
  name: string;
  scheduleName: string;
  subject: string;
  birthMs: number | null;
  joinMs: number | null;
  active: boolean;
  openId: string | null;
  askedYear: number | null;
  celebratedYear: number | null;
  handwritten: string;
  aiBlessing: string;
  teaching: string;
  intro: string;
  photoToken: string | null;
  stats: LessonStats | null;
}

export type DueAction = { teacher: TeacherRow; kind: "ask" | "celebrate"; date: Ymd; daysLeft: number };

export function shanghaiYmd(ms: number): Ymd {
  const t = new Date(ms + SHANGHAI);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function ymdToMs({ y, m, d }: Ymd): number {
  return Date.UTC(y, m - 1, d) - SHANGHAI;
}

const dayIndex = ({ y, m, d }: Ymd) => Date.UTC(y, m - 1, d) / DAY;
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function birthdayIn(year: number, birth: Ymd): Ymd {
  if (birth.m === 2 && birth.d === 29 && !isLeap(year)) return { y: year, m: 2, d: 28 };
  return { y: year, m: birth.m, d: birth.d };
}

export function nextBirthday(today: Ymd, birth: Ymd): { date: Ymd; daysLeft: number } {
  let date = birthdayIn(today.y, birth);
  if (dayIndex(date) < dayIndex(today)) date = birthdayIn(today.y + 1, birth);
  return { date, daysLeft: dayIndex(date) - dayIndex(today) };
}

/** 今天该做的事。已发年份 = 生日所在年份，所以重跑、跨年都不会重复。 */
export function dueActions(teachers: TeacherRow[], todayMs: number): DueAction[] {
  const today = shanghaiYmd(todayMs);
  const actions: DueAction[] = [];
  for (const teacher of teachers) {
    if (!teacher.active || teacher.birthMs === null) continue;
    const { date, daysLeft } = nextBirthday(today, shanghaiYmd(teacher.birthMs));
    if (daysLeft <= ASK_DAYS_BEFORE && teacher.askedYear !== date.y) actions.push({ teacher, kind: "ask", date, daysLeft });
    if (daysLeft === 0 && teacher.celebratedYear !== date.y) actions.push({ teacher, kind: "celebrate", date, daysLeft });
  }
  return actions;
}

/** 在菁仕的第 N 天（入职当天是第 1 天）与蜡烛数（满几年，1–12 根）。 */
export function tenure(joinMs: number | null, todayMs: number): { days: number; candles: number } | null {
  if (joinMs === null) return null;
  const join = shanghaiYmd(joinMs);
  const today = shanghaiYmd(todayMs);
  const days = dayIndex(today) - dayIndex(join) + 1;
  if (days < 1) return null;
  let years = today.y - join.y;
  if (today.m < join.m || (today.m === join.m && today.d < join.d)) years -= 1;
  return { days, candles: Math.min(12, Math.max(1, years)) };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `/opt/homebrew/bin/npm test -w @jingshi/teacher-birthday`
Expected: 7 个测试 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/teacher-birthday package.json package-lock.json specs/teacher-birthday
git commit -m "feat(teacher-birthday): 应用骨架与生日日期规则"
```

---

### Task 2: 领域层——飞书记录解析、课表统计、token、寄语、卡片

**Files:**
- Create: `src/domain/records.ts`（飞书字段 → TeacherRow / Wish）
- Create: `src/domain/stats.ts`（课表一年统计 + 查询条件）
- Create: `src/domain/blessing.ts`（AI 提示词、模板、取用顺序）
- Create: `src/domain/cards.ts`（飞书卡片 + 问卷链接）
- Create: `src/domain/page-data.ts`（网页数据形状，前后端共用）
- Create: `src/server/token.ts`
- Test: `tests/domain.test.ts`

**Interfaces:**
- Consumes: `TeacherRow`, `LessonStats`, `Ymd`, `ymdToMs`（Task 1）
- Produces:
  - `TEACHER_FIELDS`（字段名常量对象）、`parseTeacher(record: { record_id: string; fields: Record<string, unknown> }): TeacherRow`
  - `interface Wish { name: string; role: string; text: string; files: Array<{ token: string; name: string; mime: string }> }`
  - `parseWish(fields: Record<string, unknown>): Wish | null`（隐藏或无正文 → null）
  - `scheduleFilter(scheduleName: string, todayMs: number): SearchFilter`、`SCHEDULE_STAT_FIELDS: string[]`
  - `scheduleStats(records: Array<{ fields: Record<string, unknown> }>, todayMs: number): LessonStats`
  - `blessingMessages(input: BlessingInput): Array<{ role: "system" | "user"; content: string }>`
  - `templateBlessing(name: string): string`
  - `chooseBlessing(teacher: Pick<TeacherRow, "name" | "handwritten" | "aiBlessing">): string`
  - `wishFormUrl(base: string, teacherName: string, year: number): string`
  - `askCard(input: { teacherName: string; date: Ymd; daysLeft: number; formUrl: string; wishCount: number }): FeishuCard`
  - `celebrateCard(input: { teacherName: string; openId: string | null; pageUrl: string; wishCount: number }): FeishuCard`
  - `interface PageData { name: string; subject: string; photoUrl: string | null; year: number; tenure: { days: number; candles: number } | null; stats: LessonStats | null; blessing: string; wishes: Array<{ name: string; role: string; text: string; media: Array<{ url: string; kind: "image" | "video" }> }> }`
  - `signPageToken(recordId: string, year: number, pepper: string): string`、`verifyPageToken(token: string, pepper: string): { recordId: string; year: number } | null`

- [ ] **Step 1: 写失败测试** `tests/domain.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseBlessing, templateBlessing } from "../src/domain/blessing";
import { askCard, celebrateCard, wishFormUrl } from "../src/domain/cards";
import { ymdToMs } from "../src/domain/dates";
import { parseTeacher, parseWish } from "../src/domain/records";
import { scheduleStats } from "../src/domain/stats";
import { signPageToken, verifyPageToken } from "../src/server/token";

test("parseTeacher: 文本段落数组、日期、人员、复选框、课表名回退", () => {
  const row = parseTeacher({
    record_id: "recA",
    fields: {
      姓名: [{ type: "text", text: "Jack Hou（侯东淳）" }],
      课表名: "Jack Hou",
      主学科: "英语",
      生日: ymdToMs({ y: 1990, m: 3, d: 4 }),
      在职: true,
      飞书账号: [{ id: "ou_x", name: "侯东淳" }],
      问卷已发年份: 2026,
      照片: [{ file_token: "boxA", name: "a.webp" }],
    },
  });
  assert.equal(row.name, "Jack Hou（侯东淳）");
  assert.equal(row.scheduleName, "Jack Hou");
  assert.equal(row.openId, "ou_x");
  assert.equal(row.askedYear, 2026);
  assert.equal(row.celebratedYear, null);
  assert.equal(row.photoToken, "boxA");
  assert.equal(parseTeacher({ record_id: "r", fields: { 姓名: "汤朔" } }).scheduleName, "汤朔");
  assert.equal(parseTeacher({ record_id: "r", fields: { 姓名: "汤朔" } }).active, false);
});

test("parseWish: 隐藏或无正文 → null；附件保留 token 与类型", () => {
  assert.equal(parseWish({ 你的名字: "小王", "最想对 ta 说的话": "生日快乐", 隐藏: true }), null);
  assert.equal(parseWish({ 你的名字: "小王", "最想对 ta 说的话": "  " }), null);
  const wish = parseWish({
    你的名字: "小王", 身份: "学生", "最想对 ta 说的话": "谢谢老师",
    "图片 / 表情包": [{ file_token: "boxB", name: "猫.gif", type: "image/gif" }],
  });
  assert.deepEqual(wish, { name: "小王", role: "学生", text: "谢谢老师", files: [{ token: "boxB", name: "猫.gif", mime: "image/gif" }] });
});

test("scheduleStats: 只算有单价、时长>0、非临时取消、一年内的课；学生按关联 ID 去重", () => {
  const today = ymdToMs({ y: 2026, m: 10, d: 12 });
  const lesson = (over: Record<string, unknown>) => ({
    fields: { 上课时间: today - 10 * 86_400_000, 课程单价: "1000", 课程时长: { type: 2, value: [2] }, 学生: { link_record_ids: ["s1"] }, ...over },
  });
  const stats = scheduleStats(
    [
      lesson({}),
      lesson({ 学生: { link_record_ids: ["s1", "s2"] }, 课程时长: { type: 2, value: [1.5] } }),
      lesson({ 临时取消: "6h-30%" }),
      lesson({ 课程单价: "" }),
      lesson({ 上课时间: today - 400 * 86_400_000 }),
      lesson({ 上课时间: today + 86_400_000 }),
    ],
    today,
  );
  assert.deepEqual(stats, { lessons: 2, students: 2, hours: 3.5 });
});

test("token: 往返、篡改年份或签名都失败", () => {
  const token = signPageToken("recA", 2026, "p".repeat(32));
  assert.deepEqual(verifyPageToken(token, "p".repeat(32)), { recordId: "recA", year: 2026 });
  assert.equal(verifyPageToken(token.replace(".2026.", ".2027."), "p".repeat(32)), null);
  assert.equal(verifyPageToken(`${token}x`, "p".repeat(32)), null);
  assert.equal(verifyPageToken("garbage", "p".repeat(32)), null);
});

test("寄语：手写优先，其次 AI，再次模板", () => {
  assert.equal(chooseBlessing({ name: "汤朔", handwritten: "手写", aiBlessing: "AI" }), "手写");
  assert.equal(chooseBlessing({ name: "汤朔", handwritten: " ", aiBlessing: "AI" }), "AI");
  assert.equal(chooseBlessing({ name: "汤朔", handwritten: "", aiBlessing: "" }), templateBlessing("汤朔"));
  assert.match(templateBlessing("汤朔"), /汤朔/);
});

test("问卷链接预填并隐藏老师与年份；卡片带链接与 @", () => {
  const url = new URL(wishFormUrl("https://x.feishu.cn/share/base/form/shrA", "汤朔", 2026));
  assert.equal(url.searchParams.get("prefill_老师"), "汤朔");
  assert.equal(url.searchParams.get("hide_年份"), "1");
  const ask = JSON.stringify(askCard({ teacherName: "汤朔", date: { y: 2026, m: 10, d: 12 }, daysLeft: 3, formUrl: url.href, wishCount: 0 }));
  assert.match(ask, /10\/12/);
  assert.ok(ask.includes(url.href));
  assert.match(JSON.stringify(celebrateCard({ teacherName: "汤朔", openId: "ou_x", pageUrl: "https://p", wishCount: 5 })), /<at id=ou_x><\/at>/);
  assert.doesNotMatch(JSON.stringify(celebrateCard({ teacherName: "汤朔", openId: null, pageUrl: "https://p", wishCount: 0 })), /<at/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `/opt/homebrew/bin/npm test -w @jingshi/teacher-birthday`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现** `src/domain/records.ts`

```ts
/** 飞书多维表格记录 → 领域对象。字段名是和教务的约定，不要改名。 */
import type { TeacherRow } from "./dates";

export const TEACHER_FIELDS = {
  name: "姓名", scheduleName: "课表名", gender: "性别", birth: "生日", join: "入职时间", phone: "手机", wechat: "微信",
  feishu: "飞书账号", subject: "主学科", education: "学历信息", intro: "个人介绍", teaching: "教学特点",
  courses: "可授课课程", photo: "照片", active: "在职", handwritten: "手写寄语", ai: "AI 寄语",
  lessons: "今年课节", students: "今年学生", hours: "今年课时", asked: "问卷已发年份", celebrated: "祝福已发年份",
} as const;

export const WISH_FIELDS = {
  teacher: "老师", year: "年份", name: "你的名字", role: "身份", text: "最想对 ta 说的话", files: "图片 / 表情包", hidden: "隐藏",
} as const;

export interface Wish { name: string; role: string; text: string; files: Array<{ token: string; name: string; mime: string }> }

/** 文本字段可能是字符串，也可能是 [{type:"text", text}] 段落数组 */
export function readText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : String(part))).join("").trim();
  return "";
}

const readNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const readFiles = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is { file_token: string; name?: string; type?: string } => Boolean(item && typeof item === "object" && "file_token" in item))
        .map((item) => ({ token: item.file_token, name: item.name ?? "", mime: item.type ?? "" }))
    : [];

export function parseTeacher(record: { record_id: string; fields: Record<string, unknown> }): TeacherRow {
  const f = record.fields;
  const F = TEACHER_FIELDS;
  const name = readText(f[F.name]);
  const person = Array.isArray(f[F.feishu]) ? (f[F.feishu] as Array<{ id?: string }>)[0] : undefined;
  const lessons = readNumber(f[F.lessons]);
  return {
    recordId: record.record_id,
    name,
    scheduleName: readText(f[F.scheduleName]) || name,
    subject: readText(f[F.subject]),
    birthMs: readNumber(f[F.birth]),
    joinMs: readNumber(f[F.join]),
    active: f[F.active] === true,
    openId: person?.id ?? null,
    askedYear: readNumber(f[F.asked]),
    celebratedYear: readNumber(f[F.celebrated]),
    handwritten: readText(f[F.handwritten]),
    aiBlessing: readText(f[F.ai]),
    teaching: readText(f[F.teaching]),
    intro: readText(f[F.intro]),
    photoToken: readFiles(f[F.photo])[0]?.token ?? null,
    stats: lessons === null ? null : { lessons, students: readNumber(f[F.students]) ?? 0, hours: readNumber(f[F.hours]) ?? 0 },
  };
}

export function parseWish(fields: Record<string, unknown>): Wish | null {
  const W = WISH_FIELDS;
  const text = readText(fields[W.text]);
  if (fields[W.hidden] === true || !text) return null;
  return { name: readText(fields[W.name]) || "匿名", role: readText(fields[W.role]), text, files: readFiles(fields[W.files]) };
}
```

注意：`parseWish` 的期望输出 `files` 里 key 为 `token/name/mime`，与测试一致。

- [ ] **Step 4: 实现** `src/domain/stats.ts`

```ts
/** 「这一年」= 今天往前 365 天。只算计费课（有单价、时长 > 0，口径同薪资预警）且非临时取消。 */
import type { LessonStats } from "./dates";

const DAY = 86_400_000;
export const SCHEDULE_STAT_FIELDS = ["老师", "学生", "上课时间", "课程单价", "课程时长", "临时取消"];

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[,¥￥\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "text" in value[0]) return readNumber((value[0] as { text: unknown }).text);
  if (value && typeof value === "object" && Array.isArray((value as { value?: unknown }).value)) return readNumber((value as { value: unknown[] }).value[0]);
  return null;
}

/** search 接口条件：老师 + 上课时间（ExactDate 只精确到天，前后各放宽一天，精确边界在 scheduleStats 里判） */
export function scheduleFilter(scheduleName: string, todayMs: number) {
  return {
    conjunction: "and" as const,
    conditions: [
      { field_name: "老师", operator: "is", value: [scheduleName] },
      { field_name: "上课时间", operator: "isGreater", value: ["ExactDate", String(todayMs - 366 * DAY)] },
      { field_name: "上课时间", operator: "isLess", value: ["ExactDate", String(todayMs + DAY)] },
    ],
  };
}

export function scheduleStats(records: Array<{ fields: Record<string, unknown> }>, todayMs: number): LessonStats {
  let lessons = 0;
  let hours = 0;
  const students = new Set<string>();
  for (const { fields } of records) {
    const startsAt = fields["上课时间"];
    if (typeof startsAt !== "number" || startsAt >= todayMs || startsAt < todayMs - 365 * DAY) continue;
    const length = readNumber(fields["课程时长"]) ?? 0;
    const cancelled = typeof fields["临时取消"] === "string" ? fields["临时取消"].trim() !== "" : Boolean(fields["临时取消"]);
    if (!readNumber(fields["课程单价"]) || length <= 0 || cancelled) continue;
    lessons += 1;
    hours += length;
    const ids = (fields["学生"] as { link_record_ids?: unknown } | undefined)?.link_record_ids;
    if (Array.isArray(ids)) for (const id of ids) students.add(String(id));
  }
  return { lessons, students: students.size, hours: Math.round(hours * 10) / 10 };
}
```

- [ ] **Step 5: 实现** `src/server/token.ts`

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const sign = (recordId: string, year: number, pepper: string) =>
  createHmac("sha256", pepper).update(`${recordId}:${year}`).digest("base64url").slice(0, 22);

export function signPageToken(recordId: string, year: number, pepper: string): string {
  return `${recordId}.${year}.${sign(recordId, year, pepper)}`;
}

export function verifyPageToken(token: string, pepper: string): { recordId: string; year: number } | null {
  const [recordId, yearText, signature, ...rest] = token.split(".");
  const year = Number(yearText);
  if (rest.length || !recordId || !signature || !Number.isInteger(year)) return null;
  const expected = Buffer.from(sign(recordId, year, pepper));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { recordId, year } : null;
}
```

- [ ] **Step 6: 实现** `src/domain/blessing.ts`

```ts
import type { LessonStats, TeacherRow } from "./dates";

export interface BlessingInput {
  name: string;
  subject: string;
  teaching: string;
  intro: string;
  stats: LessonStats | null;
  days: number | null;
  wishes: string[];
}

export function blessingMessages(input: BlessingInput): Array<{ role: "system" | "user"; content: string }> {
  const facts = [
    `老师：${input.name}（${input.subject || "学科未填"}）`,
    input.teaching && `教学特点：${input.teaching}`,
    input.intro && `个人介绍：${input.intro}`,
    input.days && `在菁仕的第 ${input.days} 天`,
    input.stats && `这一年：${input.stats.lessons} 节课、${input.stats.students} 位学生、${input.stats.hours} 小时`,
    input.wishes.length > 0 && `学生和同事的祝福（节选）：\n${input.wishes.slice(0, 20).map((w) => `- ${w}`).join("\n")}`,
  ].filter(Boolean);
  return [
    {
      role: "system",
      content:
        "你是菁仕教育的同事，为一位老师写生日寄语，放在生日祝福网页的最后。要求：中文，80–150 字，一段；温暖、真诚、具体，" +
        "从老师的教学特点和学生的祝福里取一两个细节；不提年龄，不编造成绩、数字或事件，不用「您」，不堆砌成语，不加标题、引号和落款。",
    },
    { role: "user", content: facts.join("\n") },
  ];
}

const TEMPLATES = [
  (n: string) => `${n}，生日快乐。谢谢你把耐心和热爱放进每一节课里，让很多个普通的下午变得闪闪发光。愿新的一岁，你也被温柔地照顾，被认真地爱着。`,
  (n: string) => `${n}，生日快乐！你点亮过的那些「原来如此」的瞬间，都悄悄长成了学生们的底气。愿你今天放下教案，好好被祝福一次。`,
  (n: string) => `${n}，生日快乐。讲台上的你认真又发光，讲台下的你也值得所有的好。愿这一年，所想皆如愿，所行皆坦途。`,
];

/** 同一位老师总拿到同一句模板，不同老师尽量不同。 */
export function templateBlessing(name: string): string {
  const seed = [...name].reduce((sum, ch) => sum + ch.codePointAt(0)!, 0);
  return TEMPLATES[seed % TEMPLATES.length](`${name}老师`);
}

export function chooseBlessing(teacher: Pick<TeacherRow, "name" | "handwritten" | "aiBlessing">): string {
  return teacher.handwritten.trim() || teacher.aiBlessing.trim() || templateBlessing(teacher.name);
}
```

- [ ] **Step 7: 实现** `src/domain/cards.ts`

```ts
import type { Ymd } from "./dates";
import { WISH_FIELDS } from "./records";

export type FeishuCard = Record<string, unknown>;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const mmdd = ({ y, m, d }: Ymd) => `${m}/${d}（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;

export function wishFormUrl(base: string, teacherName: string, year: number): string {
  const url = new URL(base);
  url.searchParams.set(`prefill_${WISH_FIELDS.teacher}`, teacherName);
  url.searchParams.set(`hide_${WISH_FIELDS.teacher}`, "1");
  url.searchParams.set(`prefill_${WISH_FIELDS.year}`, String(year));
  url.searchParams.set(`hide_${WISH_FIELDS.year}`, "1");
  return url.href;
}

const button = (text: string, url: string, type = "primary") => ({
  tag: "action",
  actions: [{ tag: "button", text: { tag: "plain_text", content: text }, type, url }],
});

export function askCard(input: { teacherName: string; date: Ymd; daysLeft: number; formUrl: string; wishCount: number }): FeishuCard {
  const when = input.daysLeft === 0 ? "就是今天" : `还有 ${input.daysLeft} 天`;
  return {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: { tag: "plain_text", content: `🎂 ${input.teacherName} 老师 ${mmdd(input.date)} 生日` } },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `距离生日${when}。请把下面的祝福问卷转给 **${input.teacherName}** 老师的学生、家长和同事，大家写下想说的话，也可以传图片和表情包。`,
            `生日当天 9:00，祝福会做成一个专属网页发到老师群。${input.wishCount > 0 ? `\n目前已收到 **${input.wishCount}** 条祝福。` : ""}`,
            `问卷链接（可直接复制转发）：\n${input.formUrl}`,
          ].join("\n\n"),
        },
      },
      button("打开祝福问卷", input.formUrl),
    ],
  };
}

export function celebrateCard(input: { teacherName: string; openId: string | null; pageUrl: string; wishCount: number }): FeishuCard {
  const who = input.openId ? `<at id=${input.openId}></at>` : `**${input.teacherName}** 老师`;
  const gift = input.wishCount > 0 ? `同学和同事们写了 **${input.wishCount}** 条祝福，装进了一份小礼物里。` : "我们给你准备了一份小礼物。";
  return {
    config: { wide_screen_mode: true },
    header: { template: "carmine", title: { tag: "plain_text", content: `🎂 今天是 ${input.teacherName} 老师的生日` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `${who} 生日快乐！\n${gift}点开它，记得对着蛋糕吹一口气。` } },
      button("打开生日礼物 🎁", input.pageUrl),
    ],
  };
}
```

- [ ] **Step 8: 实现** `src/domain/page-data.ts`

```ts
import type { LessonStats } from "./dates";

/** GET /birthday-api/page 的返回体；只放展示用字段。 */
export interface PageData {
  name: string;
  subject: string;
  photoUrl: string | null;
  year: number;
  tenure: { days: number; candles: number } | null;
  stats: LessonStats | null;
  blessing: string;
  wishes: Array<{ name: string; role: string; text: string; media: Array<{ url: string; kind: "image" | "video" }> }>;
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `/opt/homebrew/bin/npm test -w @jingshi/teacher-birthday`
Expected: dates 7 + domain 6 全部 PASS

- [ ] **Step 10: Commit**

```bash
git add apps/teacher-birthday
git commit -m "feat(teacher-birthday): 领域层——记录解析、课表统计、页面 token、寄语与卡片"
```

---

### Task 3: 飞书表结构 + 22 位老师导入

**Files:**
- Create: `apps/teacher-birthday/scripts/setup-feishu.ts`（幂等：建字段、建祝福表与表单、开分享）
- 一次性（scratchpad，不提交）：`import-teachers.ts`

**Interfaces:**
- Consumes: `TEACHER_FIELDS`, `WISH_FIELDS`（Task 2）
- Produces: 飞书里的字段与表；`server.env` 中 `WISH_TABLE_ID`、`WISH_FORM_URL` 的真实值

- [ ] **Step 1: 写** `scripts/setup-feishu.ts`

```ts
/**
 * 幂等建表：tsx scripts/setup-feishu.ts（读 server.env）。已存在的字段/表跳过，不删不改。
 * 字段类型：1 文本 2 数字 3 单选 4 多选 5 日期 7 复选框 11 人员 13 电话 17 附件
 */
import { readFileSync } from "node:fs";

import { TEACHER_FIELDS as T, WISH_FIELDS as W } from "../src/domain/records";

const env = Object.fromEntries(
  readFileSync(new URL("../server.env", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const APP = env.TEACHER_APP_TOKEN;
const API = "https://open.feishu.cn/open-apis";
const tokenRes = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
});
const { tenant_access_token: token } = (await tokenRes.json()) as { tenant_access_token: string };

async function call<R = any>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { code: number; msg: string; data: R };
  if (json.code !== 0) throw new Error(`${method} ${path} → ${json.code} ${json.msg}`);
  return json.data;
}

const date = { date_formatter: "yyyy/MM/dd", auto_fill: false };
const select = (...names: string[]) => ({ options: names.map((name) => ({ name })) });
type Spec = [string, number, Record<string, unknown>?];

const teacherSpecs: Spec[] = [
  [T.scheduleName, 1], [T.gender, 3, select("男", "女")], [T.birth, 5, date], [T.join, 5, date],
  [T.phone, 13], [T.wechat, 1], [T.feishu, 11, { multiple: false }],
  [T.subject, 3, select("数学", "物理", "化学", "经济", "英语")],
  [T.education, 1], [T.intro, 1], [T.teaching, 1], [T.courses, 4, select()], [T.photo, 17],
  [T.active, 7], [T.handwritten, 1], [T.ai, 1],
  [T.lessons, 2, { formatter: "0" }], [T.students, 2, { formatter: "0" }], [T.hours, 2, { formatter: "0.0" }],
  [T.asked, 2, { formatter: "0" }], [T.celebrated, 2, { formatter: "0" }],
];
const wishSpecs: Spec[] = [
  [W.year, 2, { formatter: "0" }], [W.name, 1], [W.role, 3, select("学生", "家长", "同事")],
  [W.text, 1], [W.files, 17], [W.hidden, 7],
];

async function ensureFields(tableId: string, specs: Spec[], primaryName: string) {
  const { items } = await call<{ items: Array<{ field_id: string; field_name: string; is_primary?: boolean; type: number }> }>(
    "GET", `/bitable/v1/apps/${APP}/tables/${tableId}/fields?page_size=100`);
  const primary = items.find((f) => f.is_primary)!;
  if (primary.field_name !== primaryName) {
    await call("PUT", `/bitable/v1/apps/${APP}/tables/${tableId}/fields/${primary.field_id}`, { field_name: primaryName, type: 1 });
    console.log(`主字段 ${primary.field_name} → ${primaryName}`);
  }
  const existing = new Set(items.map((f) => f.field_name));
  for (const [field_name, type, property] of specs) {
    if (existing.has(field_name)) continue;
    await call("POST", `/bitable/v1/apps/${APP}/tables/${tableId}/fields`, { field_name, type, ...(property ? { property } : {}) });
    console.log(`+ ${field_name}`);
  }
}

await ensureFields(env.TEACHER_TABLE_ID, teacherSpecs, T.name);

const { items: tables } = await call<{ items: Array<{ table_id: string; name: string }> }>("GET", `/bitable/v1/apps/${APP}/tables`);
let wishTable = tables.find((t) => t.name === "生日祝福")?.table_id;
if (!wishTable) {
  wishTable = (await call<{ table_id: string }>("POST", `/bitable/v1/apps/${APP}/tables`, { table: { name: "生日祝福" } })).table_id;
  console.log(`+ 表 生日祝福 ${wishTable}`);
}
await ensureFields(wishTable, wishSpecs, W.teacher);

const { items: views } = await call<{ items: Array<{ view_id: string; view_name: string; view_type: string }> }>(
  "GET", `/bitable/v1/apps/${APP}/tables/${wishTable}/views`);
let formId = views.find((v) => v.view_type === "form")?.view_id;
if (!formId) {
  formId = (await call<{ view: { view_id: string } }>("POST", `/bitable/v1/apps/${APP}/tables/${wishTable}/views`, { view_name: "祝福问卷", view_type: "form" })).view.view_id;
}
const form = await call<{ form: { shared_url?: string } }>("PATCH", `/bitable/v1/apps/${APP}/tables/${wishTable}/forms/${formId}`, {
  name: "给老师的生日祝福",
  description: "写下你最想对 ta 说的话，也可以上传照片、表情包或小视频。生日当天，这些祝福会变成一份专属礼物送给老师。",
  shared: true,
  shared_limit: "anyone_editable",
});
const { items: formFields } = await call<{ items: Array<{ field_id: string; title: string }> }>(
  "GET", `/bitable/v1/apps/${APP}/tables/${wishTable}/forms/${formId}/fields`);
const formRules: Record<string, { required: boolean; visible: boolean; description?: string }> = {
  [W.teacher]: { required: true, visible: true },
  [W.year]: { required: true, visible: true },
  [W.name]: { required: true, visible: true, description: "学生请写学生姓名" },
  [W.role]: { required: true, visible: true },
  [W.text]: { required: true, visible: true },
  [W.files]: { required: false, visible: true, description: "选填：照片、表情包、GIF 或短视频" },
  [W.hidden]: { required: false, visible: false },
};
for (const field of formFields) {
  const rule = formRules[field.title];
  if (rule) await call("PATCH", `/bitable/v1/apps/${APP}/tables/${wishTable}/forms/${formId}/fields/${field.field_id}`, rule);
}
console.log(`WISH_TABLE_ID=${wishTable}\nWISH_FORM_URL=${form.form.shared_url ?? "（未返回，去表单视图手动复制分享链接）"}`);
```

- [ ] **Step 2: 准备 server.env 并运行**

```bash
cd apps/teacher-birthday && cp server.env.example server.env
# FEISHU_APP_ID / FEISHU_APP_SECRET 从 ../course-feedback-tracker/cancel.env 复制；PAGE_TOKEN_PEPPER=$(openssl rand -base64 36)
/opt/homebrew/bin/npx tsx scripts/setup-feishu.ts
```

Expected：依次打印 `+ 字段名`、`+ 表 生日祝福 tbl…`，最后打印 `WISH_TABLE_ID=…` 与 `WISH_FORM_URL=https://…/share/base/form/shrcn…`，写回 server.env。再跑一次应只打印最后两行（幂等）。若任一 API 报权限 / 不支持（例如表单 PATCH 返回非 0），记录错误码，改为在飞书界面手工完成该一步并在 README 里注明。

- [ ] **Step 3: 一次性导入 22 位老师（scratchpad 脚本，不提交）**

脚本 `$SCRATCH/import-teachers.ts` 做三件事：
1. `await import("/Users/hanchaoxu/Documents/GitHub/菁仕官网/src/data/teachers.ts")` 取 `teachers`（名师团队 22 位，`selectedTeachers` 不取）。
2. 读主课表「老师信息」表 `tblNU7DChTZ8nvqk`（`Xb34bXSVRaQk7ysfAQScPZp5nPh`），按「老师名」匹配补「联系方式 → 手机」「人员 → 飞书账号（`[{id}]`）」。
3. 照片：`POST /drive/v1/medias/upload_all`（multipart：`file_name`、`parent_type=bitable_image`、`parent_node=<TEACHER_APP_TOKEN>`、`size`、`file`），文件取 `菁仕官网/public<photo>`，返回的 `file_token` 写入「照片」。
4. `POST /bitable/v1/apps/<app>/tables/<tbl>/records/batch_create`，每位老师字段：

```ts
{
  姓名: t.name,
  课表名: t.name === "Jack Hou（侯东淳）" ? "Jack Hou" : t.name,
  性别: t.gender, 主学科: t.subject,
  学历信息: t.education, 教学特点: t.style,
  可授课课程: t.courses.split("·").map((s: string) => s.trim()).filter(Boolean),
  在职: true,
  照片: [{ file_token }],
  ...(phone ? { 手机: phone } : {}), ...(openId ? { 飞书账号: [{ id: openId }] } : {}),
}
```

导入前先 GET 记录，已存在同名「姓名」则跳过（可重复运行）。个人介绍、生日、入职时间留空给教务。
另外核对课表「老师」单选里的写法：对 22 人逐个确认能在课表选项中找到 `课表名`，找不到的打印出来，手工在飞书改「课表名」（如 `Valentina Lin`）。

Run: `/opt/homebrew/bin/npx tsx $SCRATCH/import-teachers.ts`
Expected：`created 22`（重跑 `created 0, skipped 22`），以及未匹配课表名清单（应为空或已手工修正）。

- [ ] **Step 4: 人工抽查**：飞书打开「老师数据主表」，确认 22 行、照片可预览；打开祝福问卷链接，在无痕窗口能填写并上传图片。

- [ ] **Step 5: Commit**

```bash
git add apps/teacher-birthday/scripts/setup-feishu.ts
git commit -m "feat(teacher-birthday): 飞书老师档案与生日祝福问卷建表脚本"
```

---

### Task 4: 云函数 `birthday-api`（定时、演练、网页接口）+ 部署

**Files:**
- Modify: `apps/course-feedback-tracker/src/server/feishu/client.ts`（加 `tmpDownloadUrls`）
- Create: `apps/teacher-birthday/src/server/service.ts`
- Create: `apps/teacher-birthday/src/server/ai.ts`
- Create: `apps/teacher-birthday/functions/birthday-api/index.ts`
- Create: `apps/teacher-birthday/cloudbaserc.json`, `scripts/deploy-function.mjs`, `scripts/rehearse.mjs`
- Test: `apps/teacher-birthday/tests/service.test.ts`

**Interfaces:**
- Consumes: Task 1/2 全部导出；`FeishuClient`（`listAllRecords`、`searchRecords`、`getRecord`、`updateRecord`、`sendMessage`）
- Produces:
  - `FeishuClient.tmpDownloadUrls(fileTokens: string[]): Promise<Map<string, string>>`
  - `interface BirthdayDeps { feishu: BirthdayFeishu; now(): number; config: BirthdayConfig; generate(messages): Promise<string> }`
  - `runDaily(deps, todayMs?: number): Promise<Array<{ teacher: string; kind: "ask" | "celebrate"; ok: boolean; error?: string }>>`
  - `rehearse(deps, teacherName: string, step: "ask" | "celebrate" | "all"): Promise<{ pageUrl?: string; formUrl?: string }>`
  - `pageData(deps, token: string): Promise<PageData | null>`

- [ ] **Step 1: 给共享飞书客户端加临时下载链接**

在 `apps/course-feedback-tracker/src/server/feishu/client.ts` 的 `sendMessage` 之后加：

```ts
  /** 多维表格附件的临时下载链接（24 小时有效，无需鉴权即可访问），一次最多 5 个 token。 */
  async tmpDownloadUrls(fileTokens: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    for (let i = 0; i < fileTokens.length; i += 5) {
      const search = new URLSearchParams();
      for (const token of fileTokens.slice(i, i + 5)) search.append("file_tokens", token);
      const data = await this.request<{ tmp_download_urls?: Array<{ file_token: string; tmp_download_url: string }> }>(
        `/open-apis/drive/v1/medias/batch_get_tmp_download_url?${search}`,
      );
      for (const item of data.tmp_download_urls ?? []) urls.set(item.file_token, item.tmp_download_url);
    }
    return urls;
  }
```

Run: `/opt/homebrew/bin/npm test -w @jingshi/course-feedback-tracker`
Expected: 现有测试全部 PASS（只加方法）

- [ ] **Step 2: 写失败测试** `tests/service.test.ts`（内存假飞书）

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { ymdToMs } from "../src/domain/dates";
import { pageData, rehearse, runDaily } from "../src/server/service";
import type { BirthdayDeps } from "../src/server/service";
import { signPageToken } from "../src/server/token";

function fakeDeps(over: { generate?: BirthdayDeps["generate"] } = {}) {
  const sent: Array<{ to: string; card: string }> = [];
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  const teacher = {
    record_id: "recT",
    fields: { 姓名: "汤朔", 主学科: "物理", 在职: true, 生日: ymdToMs({ y: 1995, m: 10, d: 12 }), 入职时间: ymdToMs({ y: 2024, m: 9, d: 1 }), 照片: [{ file_token: "boxP" }] },
  };
  const wishes = [
    { record_id: "w1", fields: { 老师: "汤朔", 年份: 2026, 你的名字: "小王", 身份: "学生", "最想对 ta 说的话": "谢谢老师", "图片 / 表情包": [{ file_token: "boxW", type: "image/gif" }] } },
    { record_id: "w2", fields: { 老师: "汤朔", 年份: 2026, 你的名字: "捣乱", "最想对 ta 说的话": "不该显示", 隐藏: true } },
  ];
  const deps: BirthdayDeps = {
    now: () => ymdToMs({ y: 2026, m: 10, d: 12 }) + 9 * 3600_000,
    config: {
      teacherAppToken: "app", teacherTableId: "tblT", wishTableId: "tblW", wishFormUrl: "https://f.feishu.cn/share/base/form/shrA",
      scheduleAppToken: "sch", scheduleTableId: "tblS", academicOpenIds: ["ou_jw"], groupChatId: "oc_g",
      pageBaseUrl: "https://app.jsjy.asia/birthday/", pepper: "p".repeat(32),
    },
    generate: over.generate ?? (async () => "AI 写的寄语"),
    feishu: {
      listTeachers: async () => [teacher],
      getTeacher: async (id) => (id === "recT" ? teacher : null),
      updateTeacher: async (recordId, fields) => { updates.push({ recordId, fields }); },
      listWishes: async (name, year) => wishes.filter((w) => w.fields.老师 === name && w.fields.年份 === year),
      listLessons: async () => [{ fields: { 上课时间: ymdToMs({ y: 2026, m: 9, d: 1 }), 课程单价: "800", 课程时长: 2, 学生: { link_record_ids: ["s1"] } } }],
      tmpUrls: async (tokens) => new Map(tokens.map((t) => [t, `https://tmp/${t}`])),
      send: async (to, card) => { sent.push({ to, card: JSON.stringify(card) }); },
    },
  };
  return { deps, sent, updates };
}

test("runDaily 生日当天：补发问卷 + 群卡片，写回年份/统计/AI 寄语；重跑不重复", async () => {
  const { deps, sent, updates } = fakeDeps();
  const results = await runDaily(deps);
  assert.deepEqual(results.map((r) => [r.kind, r.ok]), [["ask", true], ["celebrate", true]]);
  assert.deepEqual(sent.map((s) => s.to), ["open_id:ou_jw", "chat_id:oc_g"]);
  const merged = Object.assign({}, ...updates.map((u) => u.fields));
  assert.equal(merged["问卷已发年份"], 2026);
  assert.equal(merged["祝福已发年份"], 2026);
  assert.equal(merged["AI 寄语"], "AI 写的寄语");
  assert.equal(merged["今年课节"], 1);
});

test("runDaily: AI 失败 → 模板寄语，群卡片照发", async () => {
  const { deps, sent, updates } = fakeDeps({ generate: async () => { throw new Error("EXCEED_TOKEN_QUOTA_LIMIT"); } });
  const results = await runDaily(deps);
  assert.ok(results.every((r) => r.ok));
  assert.equal(sent.length, 2);
  assert.equal(updates.some((u) => "AI 寄语" in u.fields), false);
});

test("rehearse: 立即发送、不写已发年份", async () => {
  const { deps, sent, updates } = fakeDeps();
  const result = await rehearse(deps, "汤朔", "all");
  assert.equal(sent.length, 2);
  assert.ok(result.pageUrl?.startsWith("https://app.jsjy.asia/birthday/?t=recT.2026."));
  assert.equal(updates.some((u) => "问卷已发年份" in u.fields || "祝福已发年份" in u.fields), false);
  await assert.rejects(rehearse(deps, "不存在", "ask"), /找不到老师/);
});

test("pageData: 校验 token，过滤隐藏祝福，只返回展示字段", async () => {
  const { deps } = fakeDeps();
  assert.equal(await pageData(deps, "recT.2026.bad"), null);
  const data = await pageData(deps, signPageToken("recT", 2026, "p".repeat(32)));
  assert.ok(data);
  assert.equal(data.name, "汤朔");
  assert.equal(data.photoUrl, "https://tmp/boxP");
  assert.deepEqual(data.wishes.map((w) => w.name), ["小王"]);
  assert.deepEqual(data.wishes[0].media, [{ url: "https://tmp/boxW", kind: "image" }]);
  assert.equal(JSON.stringify(data).includes("1995"), false);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `/opt/homebrew/bin/npm test -w @jingshi/teacher-birthday`
Expected: FAIL，`Cannot find module '../src/server/service'`

- [ ] **Step 4: 实现** `src/server/service.ts`

```ts
/** 生日祝福的全部流程。飞书 IO 通过 deps 注入，便于测试；云函数入口只负责组装 deps。 */
import { blessingMessages, chooseBlessing } from "../domain/blessing";
import { askCard, celebrateCard, wishFormUrl } from "../domain/cards";
import type { FeishuCard } from "../domain/cards";
import { dueActions, nextBirthday, shanghaiYmd, tenure } from "../domain/dates";
import type { DueAction, TeacherRow, Ymd } from "../domain/dates";
import type { PageData } from "../domain/page-data";
import { TEACHER_FIELDS as T, parseTeacher, parseWish } from "../domain/records";
import type { Wish } from "../domain/records";
import { scheduleStats } from "../domain/stats";
import { signPageToken, verifyPageToken } from "./token";

type RawRecord = { record_id: string; fields: Record<string, unknown> };

export interface BirthdayFeishu {
  listTeachers(): Promise<RawRecord[]>;
  getTeacher(recordId: string): Promise<RawRecord | null>;
  updateTeacher(recordId: string, fields: Record<string, unknown>): Promise<void>;
  listWishes(teacherName: string, year: number): Promise<RawRecord[]>;
  listLessons(scheduleName: string, todayMs: number): Promise<Array<{ fields: Record<string, unknown> }>>;
  tmpUrls(fileTokens: string[]): Promise<Map<string, string>>;
  /** to = "open_id:ou_…" 或 "chat_id:oc_…" */
  send(to: string, card: FeishuCard): Promise<void>;
}

export interface BirthdayConfig {
  teacherAppToken: string;
  teacherTableId: string;
  wishTableId: string;
  wishFormUrl: string;
  scheduleAppToken: string;
  scheduleTableId: string;
  academicOpenIds: string[];
  groupChatId: string;
  pageBaseUrl: string;
  pepper: string;
}

export interface BirthdayDeps {
  feishu: BirthdayFeishu;
  config: BirthdayConfig;
  now(): number;
  generate(messages: ReturnType<typeof blessingMessages>): Promise<string>;
}

const wishesOf = async (deps: BirthdayDeps, name: string, year: number): Promise<Wish[]> =>
  (await deps.feishu.listWishes(name, year)).map((r) => parseWish(r.fields)).filter((w): w is Wish => w !== null);

export function pageUrl(deps: BirthdayDeps, recordId: string, year: number): string {
  return `${deps.config.pageBaseUrl}?t=${encodeURIComponent(signPageToken(recordId, year, deps.config.pepper))}`;
}

async function sendAsk(deps: BirthdayDeps, teacher: TeacherRow, date: Ymd, daysLeft: number): Promise<string> {
  const formUrl = wishFormUrl(deps.config.wishFormUrl, teacher.name, date.y);
  const wishCount = (await wishesOf(deps, teacher.name, date.y)).length;
  for (const openId of deps.config.academicOpenIds) {
    await deps.feishu.send(`open_id:${openId}`, askCard({ teacherName: teacher.name, date, daysLeft, formUrl, wishCount }));
  }
  return formUrl;
}

/** 统计 + 寄语写回老师表（AI 失败只记日志，用模板兜底），然后发群卡片。 */
async function sendCelebrate(deps: BirthdayDeps, teacher: TeacherRow, year: number): Promise<string> {
  const todayMs = deps.now();
  const wishes = await wishesOf(deps, teacher.name, year);
  const stats = scheduleStats(await deps.feishu.listLessons(teacher.scheduleName, todayMs), todayMs);
  const fields: Record<string, unknown> = { [T.lessons]: stats.lessons, [T.students]: stats.students, [T.hours]: stats.hours };
  if (!teacher.handwritten) {
    try {
      const text = (
        await deps.generate(
          blessingMessages({
            name: teacher.name, subject: teacher.subject, teaching: teacher.teaching, intro: teacher.intro, stats,
            days: tenure(teacher.joinMs, todayMs)?.days ?? null, wishes: wishes.map((w) => w.text),
          }),
        )
      ).trim();
      if (text) fields[T.ai] = text;
    } catch (error) {
      console.error(`AI 寄语失败，使用模板：${teacher.name}`, error);
    }
  }
  await deps.feishu.updateTeacher(teacher.recordId, fields);
  const url = pageUrl(deps, teacher.recordId, year);
  await deps.feishu.send(`chat_id:${deps.config.groupChatId}`, celebrateCard({ teacherName: teacher.name, openId: teacher.openId, pageUrl: url, wishCount: wishes.length }));
  return url;
}

async function loadTeachers(deps: BirthdayDeps): Promise<TeacherRow[]> {
  return (await deps.feishu.listTeachers()).map(parseTeacher).filter((t) => t.name);
}

/** 每天 09:00。每个动作单独 try，一位老师失败不影响其他人；发送成功后才写已发年份。 */
export async function runDaily(deps: BirthdayDeps, todayMs = deps.now()) {
  const results: Array<{ teacher: string; kind: DueAction["kind"]; ok: boolean; error?: string }> = [];
  for (const action of dueActions(await loadTeachers(deps), todayMs)) {
    try {
      if (action.kind === "ask") {
        await sendAsk(deps, action.teacher, action.date, action.daysLeft);
        await deps.feishu.updateTeacher(action.teacher.recordId, { [T.asked]: action.date.y });
      } else {
        await sendCelebrate(deps, action.teacher, action.date.y);
        await deps.feishu.updateTeacher(action.teacher.recordId, { [T.celebrated]: action.date.y });
      }
      results.push({ teacher: action.teacher.name, kind: action.kind, ok: true });
    } catch (error) {
      console.error(error);
      results.push({ teacher: action.teacher.name, kind: action.kind, ok: false, error: String((error as Error).message ?? error) });
    }
  }
  return results;
}

/** 演练：不看日期、不写已发年份。年份 = 下一次生日所在年（没填生日用今年）。 */
export async function rehearse(deps: BirthdayDeps, teacherName: string, step: "ask" | "celebrate" | "all") {
  const teacher = (await loadTeachers(deps)).find((t) => t.name === teacherName);
  if (!teacher) throw new Error(`找不到老师：${teacherName}`);
  const today = shanghaiYmd(deps.now());
  const next = teacher.birthMs === null ? { date: today, daysLeft: 0 } : nextBirthday(today, shanghaiYmd(teacher.birthMs));
  const result: { formUrl?: string; pageUrl?: string } = {};
  if (step !== "celebrate") result.formUrl = await sendAsk(deps, teacher, next.date, next.daysLeft);
  if (step !== "ask") result.pageUrl = await sendCelebrate(deps, teacher, next.date.y);
  return result;
}

const mediaKind = (mime: string, name: string): "image" | "video" | null =>
  mime.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(name) ? "video" : mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(name) ? "image" : null;

export async function pageData(deps: BirthdayDeps, token: string): Promise<PageData | null> {
  const parsed = verifyPageToken(token, deps.config.pepper);
  if (!parsed) return null;
  const record = await deps.feishu.getTeacher(parsed.recordId);
  if (!record) return null;
  const teacher = parseTeacher(record);
  const wishes = await wishesOf(deps, teacher.name, parsed.year);
  const tokens = [teacher.photoToken, ...wishes.flatMap((w) => w.files.map((f) => f.token))].filter((t): t is string => Boolean(t));
  const urls = tokens.length ? await deps.feishu.tmpUrls(tokens) : new Map<string, string>();
  return {
    name: teacher.name,
    subject: teacher.subject,
    photoUrl: (teacher.photoToken && urls.get(teacher.photoToken)) || null,
    year: parsed.year,
    tenure: tenure(teacher.joinMs, deps.now()),
    stats: teacher.stats,
    blessing: chooseBlessing(teacher),
    wishes: wishes.map((w) => ({
      name: w.name,
      role: w.role,
      text: w.text,
      media: w.files.flatMap((f) => {
        const kind = mediaKind(f.mime, f.name);
        const url = urls.get(f.token);
        return kind && url ? [{ url, kind }] : [];
      }),
    })),
  };
}
```

注意：`rehearse` 在 sendCelebrate 里会写统计和 AI 寄语，但不会写两个已发年份。这样演练能看到真实的 AI 效果。

- [ ] **Step 5: 实现** `src/server/ai.ts`

```ts
/** OpenAI 兼容 chat/completions。未配置时直接抛错，由调用方回退模板。 */
export function createGenerate(env: { baseUrl?: string; apiKey?: string; model?: string }) {
  return async (messages: Array<{ role: string; content: string }>): Promise<string> => {
    if (!env.baseUrl || !env.apiKey || !env.model) throw new Error("AI 未配置");
    const response = await fetch(`${env.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: env.model, messages, temperature: 0.9, max_tokens: 400 }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; code?: string; message?: string };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!response.ok || !text) throw new Error(`AI 调用失败：${body.code ?? response.status} ${body.message ?? ""}`);
    return text;
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `/opt/homebrew/bin/npm test -w @jingshi/teacher-birthday`
Expected: 全部 PASS（dates 7 + domain 6 + service 4）

- [ ] **Step 7: 函数入口** `functions/birthday-api/index.ts`

```ts
/**
 * birthday-api —— 老师生日祝福（HTTP 访问服务路径 /birthday-api，定时触发 daily-9am）。
 *   定时触发（每天 09:00）                 runDaily
 *   tcb fn invoke {"action":"daily","today":"2026-10-12"}   手动补跑 / 模拟某天（会真的发送并写年份）
 *   tcb fn invoke {"action":"rehearse","teacher":"汤朔","step":"all"}   演练
 *   GET /birthday-api/page?t=<token>       网页数据
 */
import { FeishuClient } from "../../../course-feedback-tracker/src/server/feishu/client";
import { ymdToMs } from "../../src/domain/dates";
import { SCHEDULE_STAT_FIELDS, scheduleFilter } from "../../src/domain/stats";
import { WISH_FIELDS } from "../../src/domain/records";
import { createGenerate } from "../../src/server/ai";
import { pageData, rehearse, runDaily } from "../../src/server/service";
import type { BirthdayDeps } from "../../src/server/service";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

let cached: BirthdayDeps | undefined;
function deps(): BirthdayDeps {
  if (cached) return cached;
  const client = new FeishuClient({ appId: requireEnv("FEISHU_APP_ID"), appSecret: requireEnv("FEISHU_APP_SECRET") });
  const config = {
    teacherAppToken: requireEnv("TEACHER_APP_TOKEN"),
    teacherTableId: requireEnv("TEACHER_TABLE_ID"),
    wishTableId: requireEnv("WISH_TABLE_ID"),
    wishFormUrl: requireEnv("WISH_FORM_URL"),
    scheduleAppToken: requireEnv("SCHEDULE_APP_TOKEN"),
    scheduleTableId: requireEnv("SCHEDULE_TABLE_ID"),
    academicOpenIds: requireEnv("BIRTHDAY_ACADEMIC_OPEN_IDS").split(",").map((s) => s.trim()).filter(Boolean),
    groupChatId: requireEnv("BIRTHDAY_GROUP_CHAT_ID"),
    pageBaseUrl: requireEnv("PAGE_BASE_URL"),
    pepper: requireEnv("PAGE_TOKEN_PEPPER"),
  };
  const teacherTable = { appToken: config.teacherAppToken, tableId: config.teacherTableId };
  cached = {
    config,
    now: () => Date.now(),
    generate: createGenerate({ baseUrl: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_MODEL }),
    feishu: {
      listTeachers: () => client.listAllRecords(teacherTable),
      getTeacher: (recordId) => client.getRecord({ ...teacherTable, recordId }),
      updateTeacher: async (recordId, fields) => { await client.updateRecord({ ...teacherTable, recordId, fields }); },
      listWishes: (teacherName, year) =>
        client.searchRecords({
          appToken: config.teacherAppToken,
          tableId: config.wishTableId,
          fieldNames: Object.values(WISH_FIELDS),
          filter: { conjunction: "and", conditions: [
            { field_name: WISH_FIELDS.teacher, operator: "is", value: [teacherName] },
            { field_name: WISH_FIELDS.year, operator: "is", value: [String(year)] },
          ] },
        }),
      listLessons: (scheduleName, todayMs) =>
        client.searchRecords({ appToken: config.scheduleAppToken, tableId: config.scheduleTableId, fieldNames: SCHEDULE_STAT_FIELDS, filter: scheduleFilter(scheduleName, todayMs) }),
      tmpUrls: (tokens) => client.tmpDownloadUrls(tokens),
      send: (to, card) => {
        const [type, id] = to.split(":") as ["open_id" | "chat_id", string];
        return client.sendMessage({ receiveIdType: type, receiveId: id, msgType: "interactive", content: card });
      },
    },
  };
  return cached;
}

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
  isBase64Encoded: false,
});

interface Event {
  httpMethod?: string; path?: string; queryStringParameters?: Record<string, string>;
  Type?: string; TriggerName?: string; action?: string; today?: string; teacher?: string; step?: "ask" | "celebrate" | "all";
}

export async function main(event: Event) {
  if (typeof event.httpMethod !== "string") {
    if (event.Type === "Timer" || event.TriggerName) return { ok: true, results: await runDaily(deps()) };
    if (event.action === "daily") {
      const [y, m, d] = (event.today ?? "").split("-").map(Number);
      const todayMs = y && m && d ? ymdToMs({ y, m, d }) + 9 * 3600_000 : undefined;
      return { ok: true, results: await runDaily(deps(), todayMs) };
    }
    if (event.action === "rehearse" && event.teacher) return { ok: true, ...(await rehearse(deps(), event.teacher, event.step ?? "all")) };
    return { ok: false, error: "UNKNOWN_ACTION" };
  }
  try {
    const path = (event.path ?? "").replace(/^\/birthday-api(?=\/|$)/, "").replace(/\/$/, "") || "/";
    if (event.httpMethod === "GET" && path === "/page") {
      const data = await pageData(deps(), event.queryStringParameters?.t ?? "");
      return data ? json(200, { ok: true, data }) : json(403, { ok: false, error: "INVALID_LINK" });
    }
    return json(404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    console.error(error);
    return json(500, { ok: false, error: "INTERNAL" });
  }
}
```

注意：`action:"daily"` 带 `today` 会真实写年份——只用于补跑，演练一律用 `rehearse`。

- [ ] **Step 8: 部署脚本**

`cloudbaserc.json`：

```json
{
  "$schema": "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
  "version": "2.0",
  "envId": "jingshi-test-d5gp401i44a0fa7a7",
  "region": "ap-shanghai",
  "functionRoot": "dist-functions",
  "functions": [
    {
      "name": "birthday-api",
      "timeout": 120,
      "memorySize": 256,
      "runtime": "Nodejs20.19",
      "handler": "index.main",
      "installDependency": false,
      "description": "老师生日祝福：每天 9 点发问卷 / 群卡片，提供生日网页数据",
      "triggers": [{ "name": "daily-9am", "type": "timer", "config": "0 0 9 * * * *" }]
    }
  ]
}
```

`scripts/deploy-function.mjs`：按 `course-feedback-tracker/scripts/deploy-cancel-api.mjs` 的写法——读 `server.env` → 校验 required（`FEISHU_APP_ID FEISHU_APP_SECRET TEACHER_APP_TOKEN TEACHER_TABLE_ID WISH_TABLE_ID WISH_FORM_URL SCHEDULE_APP_TOKEN SCHEDULE_TABLE_ID BIRTHDAY_ACADEMIC_OPEN_IDS BIRTHDAY_GROUP_CHAT_ID PAGE_BASE_URL PAGE_TOKEN_PEPPER`）→ esbuild 打包 `functions/birthday-api/index.ts` 到 `dist-functions/birthday-api/index.js`（cjs、node20、bundle）→ 写 package.json → 合成 `cloudbaserc.local.json`（含 envVariables）→ `tcb fn deploy birthday-api --force --config-file cloudbaserc.local.json` → `tcb fn trigger create birthday-api --config-file cloudbaserc.local.json`（已存在时报错可忽略，打印提示）。

`scripts/rehearse.mjs`：

```js
// npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 all
import { execFileSync } from "node:child_process";
const [teacher, step = "all"] = process.argv.slice(2);
if (!teacher || !["ask", "celebrate", "all"].includes(step)) {
  console.error("用法：npm run rehearse -- <老师姓名> [ask|celebrate|all]");
  process.exit(1);
}
execFileSync("tcb", ["fn", "invoke", "birthday-api", "-e", "jingshi-test-d5gp401i44a0fa7a7", "--params", JSON.stringify({ action: "rehearse", teacher, step })], { stdio: "inherit" });
```

- [ ] **Step 9: 查徐翰超 open_id，填测试收件人**

徐翰超在「老师信息」表的「人员」字段里，用课表分析机器人的 token 读出来的 `id` 就是这个应用下的 open_id：

```bash
# 在 scratchpad 里用 cancel.env 的凭证读 tblNU7DChTZ8nvqk，取 老师名=徐翰超 的 人员[0].id
```

写入 server.env：`BIRTHDAY_ACADEMIC_OPEN_IDS=<徐翰超 open_id>`，`BIRTHDAY_GROUP_CHAT_ID=oc_0fb80402fe51d4490132e94554af137d`。

- [ ] **Step 10: 部署 + 路由 + 冒烟**

```bash
cd apps/teacher-birthday && /opt/homebrew/bin/npm run deploy:functions
tcb routes add -e jingshi-test-d5gp401i44a0fa7a7 --data '{"domain":"app.jsjy.asia","routes":[{"path":"/birthday-api","upstreamResourceType":"SCF","upstreamResourceName":"birthday-api"}]}'
curl -s "https://app.jsjy.asia/birthday-api/page?t=bad"
/opt/homebrew/bin/npm run rehearse -- 汤朔 ask
```

Expected：curl 返回 `{"ok":false,"error":"INVALID_LINK"}`（403）；演练后徐翰超飞书收到「🎂 汤朔 老师 … 生日」卡片，点按钮打开的问卷里看不到老师和年份两个字段（已预填并隐藏）。

- [ ] **Step 11: Commit**

```bash
git add apps/teacher-birthday apps/course-feedback-tracker/src/server/feishu/client.ts
git commit -m "feat(teacher-birthday): birthday-api 云函数——每日 9 点问卷与群卡片、演练、网页数据接口"
```

---

### Task 5: 生日网站（信封 → 吹蜡烛 → 星座 → 卡片墙 → 寄语）

**Files:**
- Create: `apps/teacher-birthday/index.html`, `vite.config.ts`
- Create: `src/web/main.ts`（取数 + 编排五幕）
- Create: `src/web/scene.ts`（three.js：蛋糕、蜡烛、火焰、烟→星、星座、点击拾取）
- Create: `src/web/blow.ts`（麦克风吹气检测 + 长按兜底）
- Create: `src/web/cards.ts`（拍立得卡片墙）
- Create: `src/web/demo.ts`（演示数据：`?demo=0|3|12` 条祝福）
- Create: `src/web/styles.css`

**Interfaces:**
- Consumes: `PageData`（Task 2 `src/domain/page-data.ts`）；接口 `GET /birthday-api/page?t=`（Task 4）
- Produces:
  - `createScene(canvas: HTMLCanvasElement, opts: { candles: number; stars: number; name: string; onStar(index: number): void }): { extinguish(): Promise<void>; release(): void; dispose(): void }`
  - `listenForBlow(target: HTMLElement, onBlow: () => void): () => void`
  - `renderCards(root: HTMLElement, wishes: PageData["wishes"]): HTMLElement[]`
  - `demoData(count: number): PageData`

视觉方向：「夜空里的一场小生日会」。深靛紫夜色背景（`--night: #14112b`→`#2a1f4d` 渐变），烛光金（`--flame: #ffc56b`），拍立得纸白（`--paper: #fbf6ec`），墨色文字（`--ink: #2b2433`）。标题用系统宋体（`"Songti SC", "STSong", "Noto Serif CJK SC", serif`），正文用系统黑体。动效克制：缓入缓出，`prefers-reduced-motion` 时全部改为淡入。实现时先加载 `huashu-design` 或 `design-taste-frontend` 技能做一次视觉评审再写样式。

- [ ] **Step 1: Vite 配置与入口**

`vite.config.ts`：

```ts
import { defineConfig } from "vite";

// 挂在 CloudBase 静态托管 /birthday/；本地开发把 /birthday-api 代理到线上函数。
export default defineConfig({
  base: "/birthday/",
  server: { host: "0.0.0.0", port: 4179, proxy: { "/birthday-api": { target: "https://app.jsjy.asia", changeOrigin: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
```

`index.html`：`<html lang="zh-CN">`，viewport `width=device-width,initial-scale=1,viewport-fit=cover`，`<title>生日快乐</title>`，`<main id="app">` 内五个 section：`#envelope`、`#stage`（含 `<canvas>` 与提示文案）、`#sky-caption`、`#wall`、`#finale`；底部 `<script type="module" src="/src/web/main.ts">`。

- [ ] **Step 2: 演示数据** `src/web/demo.ts`

```ts
import type { PageData } from "../domain/page-data";

const SAMPLES = [
  ["小王", "学生", "谢谢老师把电磁学讲得像故事一样，我第一次觉得物理好玩！"],
  ["Gavin 妈妈", "家长", "孩子说汤老师很会教，学物理没那么难了。祝老师生日快乐！"],
  ["李老师", "同事", "隔壁教室总能听到你们的笑声，生日快乐，搭档！"],
  ["袁同学", "学生", "讲课好玩，生日快乐🎂"],
] as const;

export function demoData(count: number): PageData {
  return {
    name: "汤朔",
    subject: "物理",
    photoUrl: null,
    year: new Date().getFullYear(),
    tenure: { days: 732, candles: 2 },
    stats: { lessons: 318, students: 27, hours: 596.5 },
    blessing: "汤朔老师，生日快乐。谢谢你把耐心和热爱放进每一节课里，让很多个普通的下午变得闪闪发光。愿新的一岁，你也被温柔地照顾，被认真地爱着。",
    wishes: Array.from({ length: count }, (_, i) => {
      const [name, role, text] = SAMPLES[i % SAMPLES.length];
      return { name, role, text, media: i % 3 === 1 ? [{ url: `https://picsum.photos/seed/jsjy${i}/480/360`, kind: "image" as const }] : [] };
    }),
  };
}
```

- [ ] **Step 3: 吹气检测** `src/web/blow.ts`

```ts
/** 麦克风音量持续高于阈值约 0.3 秒视为吹气；没有权限（飞书内置浏览器常见）时长按 1 秒兜底。两者都可用。 */
export function listenForBlow(target: HTMLElement, onBlow: () => void): () => void {
  let done = false;
  let stopMic = () => {};
  let pressTimer: number | undefined;
  const fire = () => {
    if (done) return;
    done = true;
    cleanup();
    onBlow();
  };
  const down = () => { pressTimer = window.setTimeout(fire, 1000); };
  const up = () => window.clearTimeout(pressTimer);
  target.addEventListener("pointerdown", down);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointerleave", up);

  navigator.mediaDevices?.getUserMedia({ audio: true }).then((stream) => {
    if (done) return stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let loud = 0;
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      loud = Math.sqrt(sum / buf.length) > 0.18 ? loud + 1 : 0;
      if (loud > 18) fire(); // ≈ 0.3 秒 @60fps
      else raf = requestAnimationFrame(tick);
    };
    tick();
    stopMic = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); void ctx.close(); };
  }).catch(() => { /* 没权限就只用长按 */ });

  function cleanup() {
    window.clearTimeout(pressTimer);
    target.removeEventListener("pointerdown", down);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointerleave", up);
    stopMic();
  }
  return cleanup;
}
```

阈值 0.18 / 18 帧是标定旋钮：真机试吹时如误触或吹不灭，只改这两个数。

- [ ] **Step 4: 3D 场景** `src/web/scene.ts`

要求（实现时按此逐条完成，代码约 250 行）：
1. `WebGLRenderer({ canvas, antialias: true, alpha: true })`，`setPixelRatio(Math.min(devicePixelRatio, 2))`，`resize` 监听；`PerspectiveCamera(40)` 初始看蛋糕（`position (0, 2.2, 7)`）。
2. 蛋糕：两层 `CylinderGeometry`（奶油色 `MeshStandardMaterial`，粗糙度 0.6），顶层边缘一圈小球做奶油花；`HemisphereLight` + 一盏暖色 `PointLight` 放在蜡烛高度（强度随火焰闪烁）。
3. 蜡烛：`opts.candles` 根细圆柱，沿顶层圆环均匀排布；每根顶部一个火焰 `Sprite`（canvas 径向渐变纹理，金→透明），每帧用 `sin(t*13+i)` 抖动缩放与 PointLight 强度。
4. `extinguish()`：火焰 0.4 秒缩到 0、PointLight 熄灭；每根蜡烛生成 40 个烟雾粒子（`Points`，灰白、透明度递减）上升；1.2 秒后粒子变成金色并飞向星位（`Math.max(opts.stars, 7)` 个星点，分布在相机上方的椭圆带里，位置由老师名字的字符码做种子，保证同一位老师每次打开都一样），同时相机 2.5 秒缓动上仰看星空；星点之间按 x 排序依次连线（`LineBasicMaterial` 透明度 0.35，线条逐段画出）。Promise 在相机就位后 resolve。
5. 星星常亮微闪；`Raycaster` 拾取前 `opts.stars` 颗星（其余为装饰星），`pointerup` 命中时调 `opts.onStar(index)`。
6. `prefers-reduced-motion: reduce` 时：不抖动，`extinguish()` 直接切到星空终态。
7. `dispose()` 释放 geometry/material/renderer，停 RAF。
8. 创建失败（`WebGLRenderer` 抛错）由调用方 catch → 降级。

- [ ] **Step 5: 卡片墙** `src/web/cards.ts`

```ts
import type { PageData } from "../domain/page-data";

const ROLE_LABEL: Record<string, string> = { 学生: "来自学生", 家长: "来自家长", 同事: "来自同事" };

/** 拍立得卡片：正面是图片（没图用大号首字），点击翻面读留言。轻微随机倾斜，按名字做种子保持稳定。 */
export function renderCards(root: HTMLElement, wishes: PageData["wishes"]): HTMLElement[] {
  root.replaceChildren();
  return wishes.map((wish, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "polaroid";
    card.style.setProperty("--tilt", `${(([...wish.name].reduce((s, c) => s + c.codePointAt(0)!, index) % 7) - 3) * 0.8}deg`);
    card.setAttribute("aria-label", `${wish.name}的祝福，点击翻面`);

    const front = document.createElement("div");
    front.className = "face front";
    const media = wish.media[0];
    if (media?.kind === "image") {
      const img = document.createElement("img");
      img.src = media.url;
      img.alt = "";
      img.loading = "lazy";
      front.append(img);
    } else if (media?.kind === "video") {
      const video = document.createElement("video");
      video.src = media.url;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      front.append(video);
    } else {
      const initial = document.createElement("span");
      initial.className = "initial";
      initial.textContent = [...wish.name][0] ?? "♡";
      front.append(initial);
    }
    const caption = document.createElement("p");
    caption.className = "caption";
    caption.textContent = `${wish.name} · ${ROLE_LABEL[wish.role] ?? "来自朋友"}`;
    front.append(caption);

    const back = document.createElement("div");
    back.className = "face back";
    const text = document.createElement("p");
    text.textContent = wish.text;
    const sign = document.createElement("p");
    sign.className = "sign";
    sign.textContent = `—— ${wish.name}`;
    back.append(text, sign);

    card.append(front, back);
    card.addEventListener("click", () => card.classList.toggle("flipped"));
    root.append(card);
    return card;
  });
}
```

- [ ] **Step 6: 编排** `src/web/main.ts`

流程：
1. 读 `?t=`：有 → `fetch("/birthday-api/page?t=…")`，403 显示「链接无效或已过期，请联系教务」，网络错误显示重试按钮；`?demo=N` → `demoData(N)`；都没有 → `demoData(6)`（方便本地开发）。
2. 填文字：信封「致 {name} 老师」；结尾「在菁仕的第 {tenure.days} 天」（`tenure` 为 null 不显示）、「这一年你上了 {lessons} 节课，陪 {students} 位同学走过 {hours} 小时」（`stats` 为 null 或 lessons=0 不显示）、寄语、落款「菁仕教育全体 · {year}」。所有文字用 `textContent`，不用 innerHTML。
3. 第一幕：点击信封 → 信封翻开动画（CSS）→ 显示 `#stage`，创建场景（`try createScene(...)`；失败则加 `body.no-webgl`，显示 CSS 绘制的静态蛋糕）。提示「对着手机吹一口气，或者长按蛋糕」，`listenForBlow(stage, …)`。
4. 吹灭 → `await scene.extinguish()` → 显示 `#sky-caption`「{N} 颗星星，是 {N} 份想对你说的话」（N=0 时「祝福还在路上，星星先替大家亮着」）→ 2 秒后出现向下箭头，滚动进入卡片墙。点星星 → `cards[index].scrollIntoView({ behavior: "smooth", block: "center" })` 并翻面。
5. 卡片墙下面是结尾：`IntersectionObserver` 进入视口时逐行淡入（寄语按句号拆分逐句出现）。
6. 页面离开时 `scene.dispose()`。

- [ ] **Step 7: 样式** `src/web/styles.css`

要点：`:root` 定义上述颜色 token；`body` 背景为夜色渐变加一层很淡的噪点（CSS `radial-gradient` 叠加，不用图片）；`#stage` 高度 `100svh`，canvas 铺满；`.polaroid` 宽 `min(78vw, 280px)`，白边 12px、底边 44px，`transform: rotate(var(--tilt))`，`perspective` 翻面（`.face` 设 `backface-visibility: hidden`，`.back` 旋转 180deg）；卡片墙在手机上单列错落、宽屏用 `columns: 3`；左右 16px 留白，不出现横向滚动条；`@media (prefers-reduced-motion: reduce)` 取消翻转与位移动画，只保留淡入。

- [ ] **Step 8: 本地验证（四种演示数据 + 降级）**

```bash
cd apps/teacher-birthday && /opt/homebrew/bin/npm run dev
```

用 gstack `/browse` 技能在 390×844 与 1440×900 两个尺寸下分别打开：
- `http://localhost:4179/birthday/?demo=0`：星空文案为「祝福还在路上」，卡片墙为空且没有空白大洞
- `?demo=3`、`?demo=12`：星星数等于祝福数，点星星能滚到对应卡片并翻面
- 长按蛋糕 1 秒能吹灭（模拟没有麦克风权限的情况）
- 在控制台把 `HTMLCanvasElement.prototype.getContext` 改成返回 null 后刷新（模拟 WebGL 不可用）：显示静态蛋糕，后面的流程不受影响

每个场景截一张图，控制台没有报错。

- [ ] **Step 9: 构建、部署、端到端**

```bash
/opt/homebrew/bin/npm run build -w @jingshi/teacher-birthday
/opt/homebrew/bin/npm run deploy:web -w @jingshi/teacher-birthday
/opt/homebrew/bin/npm run rehearse -w @jingshi/teacher-birthday -- 汤朔 celebrate
```

Expected：「生日通知测试」群收到卡片，在手机飞书里点按钮打开 `app.jsjy.asia/birthday/?t=…`，看到真实祝福（先用 Task 4 演练的问卷提交 2–3 条，带一张 GIF）。

- [ ] **Step 10: Commit**

```bash
git add apps/teacher-birthday
git commit -m "feat(teacher-birthday): 3D 生日祝福网站——吹蜡烛、祝福星座、拍立得卡片墙"
```

---

### Task 6: 文档、AI 额度、交付演练

**Files:**
- Create: `apps/teacher-birthday/README.md`
- Modify: `AGENTS.md`（领域地图加一行）
- Modify: `specs/teacher-birthday/design.md`（如果实现中有偏差，在这里同步）

- [ ] **Step 1: README**（参照 `apps/ielts-progress/README.md` 的结构）：功能一句话；访问地址；飞书表格与问卷链接；字段说明（哪些由教务填写，哪些由系统写入，字段不要改名）；每日流程与时间；演练命令；上线切换步骤（改两个收件人变量 → `deploy:functions`）；AI 配置与额度说明；命令清单。

- [ ] **Step 2: AGENTS.md** 领域地图加：`- **老师生日**：apps/teacher-birthday，飞书老师档案 + 生日问卷与群卡片 + 3D 祝福网页（CloudBase）。`

- [ ] **Step 3: AI 冒烟**：如果到这一步 AI 额度已经到位（CloudBase 购买了大模型 token 包，或者换成 DeepSeek 密钥），在 server.env 填好 `AI_API_KEY` 后重新部署，跑 `npm run rehearse -- 汤朔 celebrate`，检查「AI 寄语」字段写入了 80–150 字的中文；如果额度还没到位，在 README 写明「当前使用模板寄语」。

- [ ] **Step 4: 全量验证**

```bash
/opt/homebrew/bin/npm test
/opt/homebrew/bin/npm run build:teacher-birthday
```

Expected：所有 workspace 测试通过，构建成功。

- [ ] **Step 5: Commit**

```bash
git add apps/teacher-birthday/README.md AGENTS.md specs/teacher-birthday
git commit -m "docs(teacher-birthday): README、领域地图与上线说明"
```
