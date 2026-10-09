import assert from "node:assert/strict";
import test from "node:test";

import {
  CancellationError,
  createIntent,
  listLessonsForLink,
  processRequest,
} from "../src/cancellation/service";
import type { CancelIntent, CancelRequest, CancellationDeps, IntentOutcome } from "../src/cancellation/service";
import type { CancellableLesson } from "../src/cancellation/rules";
import type { FeishuCard } from "../src/cancellation/messages";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-09T19:30:00+08:00");

function harness(overrides: { lesson?: Partial<CancellableLesson>; now?: number } = {}) {
  let now = overrides.now ?? START - 3 * HOUR;
  const lesson: CancellableLesson = {
    recordId: "recLesson",
    studentRecordIds: ["stuA"],
    teacherName: "黄钢",
    teacherOpenId: "ou_teacher",
    courseName: "IG英语",
    startMs: START,
    endMs: START + 2 * HOUR,
    cancellation: "",
    ...overrides.lesson,
  };
  const intents = new Map<string, CancelIntent>();
  const outcomes: IntentOutcome[] = [];
  const requests = new Map<string, CancelRequest>();
  const results = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  const userCards: Array<[string, FeishuCard]> = [];
  const groupCards: FeishuCard[] = [];
  let ids = 0;
  const deps: CancellationDeps = {
    now: () => now,
    randomId: () => `intent${++ids}`,
    formUrl: "https://example.feishu.cn/share/base/form/shrTest",
    links: {
      find: async (token) => (token === "tokA" ? { token, studentKey: "stuA", studentName: "Kiki", active: true } : null),
    },
    intents: {
      create: async (intent) => void intents.set(intent.intentId, intent),
      get: async (id) => intents.get(id) ?? null,
      finish: async (id, outcome) => {
        const intent = intents.get(id);
        if (!intent || intent.status !== "pending") return false;
        intents.set(id, { ...intent, status: outcome.status });
        outcomes.push(outcome);
        return true;
      },
    },
    schedule: {
      listWindow: async () => [lesson],
      get: async (id) => (id === lesson.recordId ? lesson : null),
      writeCancellation: async (id, tier) => {
        writes.push([id, tier]);
        lesson.cancellation = tier;
      },
    },
    requests: {
      get: async (id) => {
        const request = requests.get(id);
        return request ? { ...request, processed: results.has(id) } : null;
      },
      writeResult: async (id, result) => void results.set(id, result),
    },
    notify: {
      user: async (openId, card) => void userCards.push([openId, card]),
      group: async (card) => void groupCards.push(card),
    },
  };
  const submit = (recordId: string, intentId: string, reason: "personal" | "sick" = "personal") =>
    requests.set(recordId, { recordId, intentId, reason, note: "", hasSickProof: false, submittedMs: now, processed: false });
  return {
    deps, lesson, intents, outcomes, results, writes, userCards, groupCards, submit,
    setNow: (value: number) => { now = value; },
  };
}

const text = (card: FeishuCard) => JSON.stringify(card);

test("happy path: link → intent → form submission writes the tier and notifies teacher and group", async () => {
  const h = harness({ now: START - 2.2 * HOUR });
  const listed = await listLessonsForLink(h.deps, "tokA");
  assert.equal(listed.studentName, "Kiki");
  assert.equal(listed.lessons[0].preview.tier, "6h-30%");

  const { intentId, formUrl } = await createIntent(h.deps, "tokA", "recLesson");
  assert.match(formUrl, /prefill_%E5%8F%96%E6%B6%88%E7%BC%96%E5%8F%B7=intent1/);
  assert.match(formUrl, /hide_%E5%8F%96%E6%B6%88%E7%BC%96%E5%8F%B7=1/);

  // 选课时提示 30%，学生拖到开课前 1.9 小时才提交：按提交时间算 50%
  h.setNow(START - 1.9 * HOUR);
  h.submit("recReq1", intentId);
  const result = await processRequest(h.deps, "recReq1");
  assert.deepEqual(result, { status: "applied", tier: "2h-50%" });
  assert.deepEqual(h.writes, [["recLesson", "2h-50%"]]);
  assert.match(h.results.get("recReq1")!, /^已生效：2h-50%/);
  assert.equal(h.userCards[0][0], "ou_teacher");
  assert.match(text(h.userCards[0][1]), /Kiki 取消了一节课/);
  assert.match(text(h.groupCards[0]), /老师已收到私聊通知/);
});

test("the same submission or intent is never applied twice", async () => {
  const h = harness();
  const { intentId } = await createIntent(h.deps, "tokA", "recLesson");
  h.submit("recReq1", intentId);
  await processRequest(h.deps, "recReq1");
  assert.equal((await processRequest(h.deps, "recReq1")).status, "skipped");

  h.submit("recReq2", intentId);
  const second = await processRequest(h.deps, "recReq2");
  assert.equal(second.status, "rejected");
  assert.equal(h.writes.length, 1);
});

test("invalid, expired or stale submissions are rejected without touching the schedule", async () => {
  const h = harness();
  h.submit("recNoIntent", "forged");
  assert.match((await processRequest(h.deps, "recNoIntent") as { message: string }).message, /取消编号无效/);

  const { intentId } = await createIntent(h.deps, "tokA", "recLesson");
  h.setNow(START - 3 * HOUR + 31 * 60_000);
  h.submit("recLate", intentId);
  assert.match((await processRequest(h.deps, "recLate") as { message: string }).message, /过期/);

  const h2 = harness();
  const fresh = await createIntent(h2.deps, "tokA", "recLesson");
  h2.lesson.cancellation = "6h-30%"; // 教务在此期间已手动取消
  h2.submit("recStale", fresh.intentId);
  assert.match((await processRequest(h2.deps, "recStale") as { message: string }).message, /已经取消过/);

  assert.deepEqual([...h.writes, ...h2.writes], []);
  assert.match(text(h.groupCards[0]), /需要人工处理/);
});

test("intent creation refuses links, lessons and students that do not match", async () => {
  const h = harness({ lesson: { studentRecordIds: ["stuB"] } });
  await assert.rejects(createIntent(h.deps, "bad", "recLesson"), (error: unknown) => error instanceof CancellationError && error.code === "INVALID_LINK");
  await assert.rejects(createIntent(h.deps, "tokA", "missing"), /没有找到这节课/);
  await assert.rejects(createIntent(h.deps, "tokA", "recLesson"), /不属于该学生/);
});

test("sick leave is written as 学生病假-0% and a teacher without Feishu account triggers a manual reminder", async () => {
  const h = harness({ lesson: { teacherOpenId: null } });
  const { intentId } = await createIntent(h.deps, "tokA", "recLesson");
  h.submit("recSick", intentId, "sick");
  assert.deepEqual(await processRequest(h.deps, "recSick"), { status: "applied", tier: "学生病假-0%" });
  assert.equal(h.userCards.length, 0);
  assert.match(text(h.groupCards[0]), /没能私聊通知老师/);
  assert.match(text(h.groupCards[0]), /病假证明/);
});

test("a failed schedule write keeps the request pending and alerts the group", async () => {
  const h = harness();
  h.deps.schedule.writeCancellation = async () => { throw new Error("飞书接口失败：Forbidden"); };
  const { intentId } = await createIntent(h.deps, "tokA", "recLesson");
  h.submit("recFail", intentId);
  const result = await processRequest(h.deps, "recFail");
  assert.equal(result.status, "rejected");
  assert.match(h.results.get("recFail")!, /^待处理：写入课表失败/);
  assert.equal(h.userCards.length, 0);
  assert.match(text(h.groupCards[0]), /手动在课表/);
});
