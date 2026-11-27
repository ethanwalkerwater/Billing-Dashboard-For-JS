import assert from "node:assert/strict";
import { test } from "node:test";

import { filterTeachers, hasCourseTag, makeCode, missingTeachers, parseShareInput, SHARE_CODE } from "../src/domain/share";
import type { ShareRow, SiteTeacher } from "../src/domain/share";
import { createHandler } from "../src/server/handler";
import type { AdminRow, HandlerDeps, Store } from "../src/server/handler";

const KEY = "k".repeat(40);

function memoryStore(): Store & { rows: ShareRow[] } {
  const rows: ShareRow[] = [];
  return {
    rows,
    async list() {
      return [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    async insert(row) {
      if (rows.some((r) => r.code === row.code)) return undefined;
      rows.push({ ...row });
      return { ...row };
    },
    async update(code, expect, patch) {
      const row = rows.find((r) => r.code === code && r.updated_at === expect);
      if (!row) return undefined;
      Object.assign(row, patch);
      return { ...row };
    },
  };
}

function setup(opts: { uid?: string; admin?: AdminRow; refreshed?: boolean; bytes?: number[][] } = {}) {
  const store = memoryStore();
  const bytes = opts.bytes ?? [];
  let tick = 0;
  let refreshes = 0;
  const deps: HandlerDeps = {
    currentUid: () => ("uid" in opts ? opts.uid : "u1"),
    findAdmin: async () => ("admin" in opts ? opts.admin : { display_name: "王教务", role: "admin" }),
    store,
    refreshSite: async () => {
      refreshes++;
      return opts.refreshed ?? true;
    },
    siteKey: KEY,
    now: () => new Date(Date.UTC(2026, 10, 27, 1, 0, tick++)),
    randomBytes: (n) => Uint8Array.from(bytes.shift() ?? Array.from({ length: n }, (_, i) => i + tick * 9)),
    log: () => undefined,
  };
  return { handle: createHandler(deps), store, refreshes: () => refreshes };
}

const input = { title: "雅思语培", intro: "这几位老师专门带雅思", teachers: ["刘峥", "唐择运"] };

test("parseShareInput：去空格、去重，标题、老师必填，超长报人话", () => {
  assert.deepEqual(parseShareInput({ title: " 雅思 ", intro: " ", teachers: ["刘峥", " 刘峥 ", "", 3] }), { title: "雅思", intro: "", teachers: ["刘峥"] });
  assert.throws(() => parseShareInput({ title: "  ", teachers: ["a"] }), /请填写标题/);
  assert.throws(() => parseShareInput({ title: "a", teachers: [] }), /至少选一位/);
  assert.throws(() => parseShareInput({ title: "字".repeat(31), teachers: ["a"] }), /最多 30/);
  assert.throws(() => parseShareInput({ title: "a", intro: "字".repeat(401), teachers: ["a"] }), /最多 400/);
  assert.throws(() => parseShareInput({ title: "a", teachers: Array.from({ length: 31 }, (_, i) => `t${i}`) }), /最多 30 位/);
});

test("makeCode：8 位、只用好认的字母数字", () => {
  const code = makeCode(Uint8Array.from([0, 1, 2, 3, 255, 254, 100, 57]));
  assert.match(code, SHARE_CODE);
  assert.doesNotMatch(code, /[0O1l]/);
});

test("hasCourseTag：AP 不中 EAP，雅思全科、竞赛物理能中", () => {
  assert.equal(hasCourseTag("雅思全科 · 托福 · 学术英语 EAP", "AP"), false);
  assert.equal(hasCourseTag("IGCSE · A-Level · AP 经济", "AP"), true);
  assert.equal(hasCourseTag("雅思全科 · 托福口语 & 写作", "雅思"), true);
  assert.equal(hasCourseTag("IGCSE · A-Level · AP · 竞赛物理", "竞赛"), true);
  assert.equal(hasCourseTag("GCSE 地理 · 历史", "IGCSE"), false);
  assert.equal(hasCourseTag("A-Level English", "a-level"), true);
});

test("filterTeachers：名字、学科、标签都要中，名师/严选分开", () => {
  const t = (name: string, subject: string, courses: string, pool: SiteTeacher["pool"] = "名师"): SiteTeacher => ({ name, subject, courses, pool, photo: null, degree: "", hours: "", ielts: null });
  const all = [t("刘峥", "英语", "雅思全科 · 托福"), t("应雁心", "数学", "IGCSE · A-Level · IB · AP 数学"), t("Cherry老师", "数学", "IGCSE · A-Level 数学", "严选")];
  assert.deepEqual(filterTeachers(all, { query: "", subject: null, tags: ["雅思"], pool: null }).map((x) => x.name), ["刘峥"]);
  assert.deepEqual(filterTeachers(all, { query: "", subject: "数学", tags: ["A-Level"], pool: "严选" }).map((x) => x.name), ["Cherry老师"]);
  assert.deepEqual(filterTeachers(all, { query: "cherry", subject: null, tags: [], pool: null }).map((x) => x.name), ["Cherry老师"]);
  assert.deepEqual(filterTeachers(all, { query: "", subject: null, tags: ["IB", "AP"], pool: null }).map((x) => x.name), ["应雁心"]);
});

test("missingTeachers：官网上没有了的老师", () => {
  assert.deepEqual(missingTeachers({ teachers: ["刘峥", "已走"] }, new Set(["刘峥"])), ["已走"]);
});

test("只有教务能用：没登录、老师账号、名单里没有都拦下", async () => {
  const reason = async (s: ReturnType<typeof setup>) => ((await s.handle({ action: "list" })) as { reason?: string }).reason;
  assert.equal(await reason(setup({ uid: undefined })), "LOGIN");
  assert.equal(await reason(setup({ admin: { role: "teacher" } })), "NO_ACCESS");
  assert.equal(await reason(setup({ admin: undefined })), "NO_ACCESS");
  const ok = (await setup({ admin: { role: "super", email: "li@x.com" } }).handle({ action: "list" })) as { ok: boolean; me: string };
  assert.deepEqual([ok.ok, ok.me], [true, "li"]);
});

test("新建：生成编号、记建的人、通知官网；编号撞了换一个", async () => {
  const same = [5, 5, 5, 5, 5, 5, 5, 5];
  const s = setup({ bytes: [same, same, [9, 9, 9, 9, 9, 9, 9, 9]] });
  const first = (await s.handle({ action: "save", ...input })) as { ok: boolean; share: ShareRow; refreshed: boolean };
  assert.equal(first.ok, true);
  assert.equal(first.refreshed, true);
  assert.equal(first.share.created_by, "王教务");
  assert.equal(first.share.active, true);
  const second = (await s.handle({ action: "save", ...input, title: "第二条" })) as { share: ShareRow };
  assert.notEqual(second.share.code, first.share.code);
  assert.equal(s.store.rows.length, 2);
  assert.equal(s.refreshes(), 2);
});

test("修改：编号不变；别人先改过返回 STALE，不覆盖", async () => {
  const s = setup();
  const { share } = (await s.handle({ action: "save", ...input })) as { share: ShareRow };
  const edited = (await s.handle({ action: "save", code: share.code, updatedAt: share.updated_at, title: "雅思 8 分老师", intro: "", teachers: ["刘峥"] })) as { share: ShareRow };
  assert.equal(edited.share.code, share.code);
  assert.equal(edited.share.title, "雅思 8 分老师");
  assert.equal(edited.share.created_by, "王教务");
  const stale = (await s.handle({ action: "save", code: share.code, updatedAt: share.updated_at, ...input })) as { ok: boolean; reason: string };
  assert.deepEqual([stale.ok, stale.reason], [false, "STALE"]);
  assert.equal(s.store.rows[0].title, "雅思 8 分老师");
  assert.equal(((await s.handle({ action: "save", code: "bad", updatedAt: "x", ...input })) as { error: string }).error, "链接编号不对，请刷新后再试");
});

test("停用 / 恢复；官网没通知到时 refreshed=false 让页面提示", async () => {
  const s = setup({ refreshed: false });
  const { share } = (await s.handle({ action: "save", ...input })) as { share: ShareRow };
  const off = (await s.handle({ action: "set-active", code: share.code, updatedAt: share.updated_at, active: false })) as { share: ShareRow; refreshed: boolean };
  assert.deepEqual([off.share.active, off.refreshed], [false, false]);
  const on = (await s.handle({ action: "set-active", code: share.code, updatedAt: off.share.updated_at, active: true })) as { share: ShareRow };
  assert.equal(on.share.active, true);
  assert.equal(((await s.handle({ action: "set-active", code: share.code, updatedAt: on.share.updated_at, active: "no" })) as { ok: boolean }).ok, false);
});

test("官网接口：要 x-site-key，只给有效的分享页、只给官网要的字段", async () => {
  const s = setup();
  const a = ((await s.handle({ action: "save", ...input })) as { share: ShareRow }).share;
  const b = ((await s.handle({ action: "save", ...input, title: "停用的" })) as { share: ShareRow }).share;
  await s.handle({ action: "set-active", code: b.code, updatedAt: b.updated_at, active: false });
  const get = (headers: Record<string, string>, path = "/share-api/site/shares") => s.handle({ httpMethod: "GET", path, headers }) as Promise<{ statusCode: number; body: string }>;
  assert.equal((await get({})).statusCode, 401);
  assert.equal((await get({ "x-site-key": "short" })).statusCode, 401);
  assert.equal((await get({ "X-Site-Key": KEY }, "/share-api/nope")).statusCode, 404);
  const ok = await get({ "X-Site-Key": KEY });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body).shares, [{ code: a.code, title: a.title, intro: a.intro, teachers: a.teachers }]);
});
