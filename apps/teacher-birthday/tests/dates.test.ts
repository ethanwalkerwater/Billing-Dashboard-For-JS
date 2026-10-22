import assert from "node:assert/strict";
import { test } from "node:test";

import { dueActions, nextBirthday, shanghaiYmd, tenure, wishWindow, ymdToMs } from "../src/domain/dates";
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

test("wishWindow: 从生日前 3 天到下次收集前，覆盖跨年、闰日和未填生日", () => {
  const jan = ymdToMs({ y: 1990, m: 1, d: 2 });
  const window = wishWindow(jan, 2027);
  assert.deepEqual(window, { fromMs: at(2026, 12, 30, 0), toMs: at(2027, 12, 30, 0) });
  assert.equal(window.toMs, wishWindow(jan, 2028).fromMs);
  assert.deepEqual(wishWindow(null, 2026), { fromMs: at(2026, 1, 1, 0), toMs: at(2027, 1, 1, 0) });
  assert.deepEqual(wishWindow(ymdToMs({ y: 2000, m: 2, d: 29 }), 2027), { fromMs: at(2027, 2, 25, 0), toMs: at(2028, 2, 26, 0) });
});

test("tenure: 第 N 天与蜡烛数（至少 1 根，最多 12 根）", () => {
  assert.equal(tenure(null, at(2026, 10, 12)), null);
  assert.deepEqual(tenure(ymdToMs({ y: 2026, m: 10, d: 12 }), at(2026, 10, 12)), { days: 1, candles: 1 });
  assert.deepEqual(tenure(ymdToMs({ y: 2023, m: 10, d: 13 }), at(2026, 10, 12)), { days: 1096, candles: 2 });
  assert.deepEqual(tenure(ymdToMs({ y: 2000, m: 1, d: 1 }), at(2026, 10, 12))?.candles, 12);
  assert.equal(tenure(ymdToMs({ y: 2027, m: 1, d: 1 }), at(2026, 10, 12)), null);
});

test("dueActions: 生日卡片没发成功，生日后 2 天内补发（年份记生日那年），第 3 天起放弃", () => {
  const t = teacher({ askedYear: 2026 });
  assert.deepEqual(dueActions([t], at(2026, 10, 13)).map((a) => [a.kind, a.daysLeft, a.date.d]), [["celebrate", -1, 12]]);
  assert.deepEqual(dueActions([t], at(2026, 10, 14)).map((a) => [a.kind, a.daysLeft]), [["celebrate", -2]]);
  assert.deepEqual(dueActions([t], at(2026, 10, 15)), []);
  assert.deepEqual(dueActions([teacher({ askedYear: 2026, celebratedYear: 2026 })], at(2026, 10, 13)), []);
  const dec = teacher({ birthMs: ymdToMs({ y: 1990, m: 12, d: 31 }), askedYear: 2026 });
  assert.deepEqual(dueActions([dec], at(2027, 1, 1)).map((a) => [a.kind, a.date.y]), [["celebrate", 2026]]);
});
