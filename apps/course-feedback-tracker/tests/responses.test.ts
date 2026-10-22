import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { describe, it } from "node:test";

import { feishuSignature, verifyFeishuEvent } from "../functions/feedback-api/feishu-event";
import type { FeedbackResponseRecord } from "../src/server/feishu/parsers";
import { matchResponsesToTasks, reconcileResponses, releaseDeletedResponses } from "../src/server/sync/reconcile-responses";
import type { FeedbackTaskRepository } from "../src/server/tasks/repository";
import type { StoredFeedbackTask } from "../src/server/tasks/types";

function task(overrides: Partial<StoredFeedbackTask> = {}): StoredFeedbackTask {
  return {
    taskId: "ft_202608_aaa",
    courseMonth: "2026-08",
    collectionMonth: "2026-09",
    studentRecordId: "student-1",
    studentName: "姚凯榕",
    teacherSourceName: "应雁心",
    teacherCanonicalName: "应雁心",
    courseNames: ["IG数学"],
    scheduleRecordIds: ["lesson-1"],
    status: "sent",
    publicToken: "token-1",
    responseRecordIds: [],
    validationIssues: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function response(overrides: Partial<FeedbackResponseRecord> = {}): FeedbackResponseRecord {
  return {
    recordId: "rec-1",
    taskId: null,
    studentNames: ["姚凯榕"],
    teacherNames: ["应雁心"],
    identity: ["学生本人"],
    submittedAt: "2026-09-03T02:00:00.000Z",
    courseMonth: null,
    ...overrides,
  };
}

describe("response matching by name", () => {
  /**
   * 业务方决定不往飞书反馈表加字段、不用任务 ID。答卷只按（学生姓名, 老师姓名）匹配。
   * 实测 9 月 182 份里 168 份规范化后精确相等；剩下的靠别名表和手动绑定，不做模糊匹配。
   */
  it("binds by normalized student + teacher name and ignores the task ID field", () => {
    const outcomes = matchResponsesToTasks({
      responses: [
        response({ recordId: "rec-exact" }),
        response({ recordId: "rec-spacing", studentNames: ["姚 凯榕"], teacherNames: ["应雁心 "] }),
        response({ recordId: "rec-with-stale-id", taskId: "ft_something_else" }),
      ],
      tasks: [task()],
    });
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.responseRecordId, outcome.syncStatus, outcome.taskId, outcome.boundBy]),
      [
        ["rec-exact", "matched", "ft_202608_aaa", "name"],
        ["rec-spacing", "duplicate", "ft_202608_aaa", "name"],
        ["rec-with-stale-id", "duplicate", "ft_202608_aaa", "name"],
      ],
    );
  });

  it("resolves aliases before matching (Valentina 林 → Valentina Lin)", () => {
    const outcomes = matchResponsesToTasks({
      responses: [response({ recordId: "rec-alias", teacherNames: ["Valentina 林"] })],
      tasks: [task({ teacherCanonicalName: "Valentina Lin", teacherSourceName: "Valentina Lin" })],
      aliases: [{ kind: "teacher", alias: "Valentina 林", canonical: "Valentina Lin" }],
    });
    assert.equal(outcomes[0].syncStatus, "matched");
    assert.equal(outcomes[0].boundBy, "name");
  });

  it("reports an unmatched name with the raw text so staff can bind it manually", () => {
    const outcomes = matchResponsesToTasks({
      responses: [response({ recordId: "rec-unknown", studentNames: ["Arwen姚若澜"] })],
      tasks: [task()],
    });
    assert.equal(outcomes[0].syncStatus, "unlinked");
    assert.equal(outcomes[0].studentName, "Arwen姚若澜");
    assert.equal(outcomes[0].teacherName, "应雁心");
    assert.equal(outcomes[0].taskId, null);
  });

  it("honours a manual binding over name matching and keeps it across re-runs", () => {
    const outcomes = matchResponsesToTasks({
      responses: [response({ recordId: "rec-manual", studentNames: ["顾子言"] })],
      tasks: [task()],
      manualBindings: [{ responseRecordId: "rec-manual", taskId: "ft_202608_aaa" }],
    });
    assert.equal(outcomes[0].syncStatus, "matched");
    assert.equal(outcomes[0].boundBy, "manual");
  });

  it("keeps one student answer and one parent answer per task, marks extras duplicate", () => {
    const outcomes = matchResponsesToTasks({
      responses: [
        response({ recordId: "rec-student", identity: ["学生本人"], submittedAt: "2026-09-03T02:00:00.000Z" }),
        response({ recordId: "rec-parent", identity: ["家长/监护人"], submittedAt: "2026-09-04T02:00:00.000Z" }),
        response({ recordId: "rec-student-again", identity: ["学生本人"], submittedAt: "2026-09-05T02:00:00.000Z" }),
      ],
      tasks: [task()],
    });
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.responseRecordId, outcome.identity, outcome.syncStatus]),
      [
        ["rec-student", "student", "matched"],
        ["rec-parent", "parent", "matched"],
        ["rec-student-again", "student", "duplicate"],
      ],
    );
  });

  it("is idempotent: a stored slot stays primary and needs no rewrite", () => {
    const stored = task({ status: "completed", studentResponseId: "rec-first" });
    const outcomes = matchResponsesToTasks({
      responses: [
        response({ recordId: "rec-late", submittedAt: "2026-09-05T02:00:00.000Z" }),
        response({ recordId: "rec-first", submittedAt: "2026-09-03T02:00:00.000Z" }),
      ],
      tasks: [stored],
    });
    const primary = outcomes.find((outcome) => outcome.syncStatus === "matched");
    assert.equal(primary?.responseRecordId, "rec-first");
    // 稳态重跑零写入，定时对账不会反复更新数据库。
    assert.equal(primary?.taskNeedsUpdate, false);
  });

  it("overrides a declined task when a real answer arrives", () => {
    const outcomes = matchResponsesToTasks({ responses: [response()], tasks: [task({ status: "declined" })] });
    assert.equal(outcomes[0].syncStatus, "matched");
    assert.equal(outcomes[0].taskNeedsUpdate, true);
  });

  it("assigns each answer to a collection month by Shanghai submit time", () => {
    // 2026-09-01 00:30 +08:00 在 UTC 里还是 8 月 31 日，必须归到 9 月这一轮收集。
    const outcomes = matchResponsesToTasks({
      responses: [response({ recordId: "rec-edge", submittedAt: "2026-08-31T16:30:00.000Z" })],
      tasks: [],
    });
    assert.equal(outcomes[0].collectionMonth, "2026-09");
  });

  it("assigns an answer with a prefilled feedback month to that month's round, whenever it was submitted", () => {
    const outcomes = matchResponsesToTasks({
      responses: [
        // 10 月 20 日提前评 10 月的课 → 11 月那一轮（10 月课程）
        response({ recordId: "rec-early", submittedAt: "2026-10-20T02:00:00.000Z", courseMonth: "2026-10" }),
        // 同一天交的老二维码（没有月份）→ 按提交月，评的是 9 月的课
        response({ recordId: "rec-legacy", submittedAt: "2026-10-20T02:00:00.000Z" }),
      ],
      tasks: [],
    });
    assert.deepEqual(outcomes.map((o) => o.collectionMonth), ["2026-11", "2026-10"]);
  });

  it("keeps two rounds of the same student and teacher apart", async () => {
    const applied: string[] = [];
    const repository = {
      listByCollectionMonth: async () => [task({ taskId: "ft_202610_x", courseMonth: "2026-10", collectionMonth: "2026-11" })],
      listAliases: async () => [],
      listManualBindings: async () => [],
      listResponseIds: async () => [],
      deleteResponses: async () => {},
      updateTaskSlots: async () => {},
      applyResponseOutcomes: async (outcomes: Array<{ responseRecordId: string; syncStatus: string }>) =>
        void applied.push(...outcomes.map((o) => `${o.responseRecordId}:${o.syncStatus}`)),
      saveSnapshot: async () => {},
    } as unknown as FeedbackTaskRepository;
    const at = Date.parse("2026-10-20T02:00:00.000Z");
    const records = [
      { record_id: "rec-sept", fields: { 学生姓名: "姚凯榕", 老师姓名: "应雁心", 提交时间: at } },
      { record_id: "rec-oct", fields: { 学生姓名: "姚凯榕", 老师姓名: "应雁心", 提交时间: at, 反馈课程月份: "2026-10" } },
    ];
    const result = await reconcileResponses({ client: {} as never, config: {} as never, repository, collectionMonth: "2026-11", records });
    // 9 月那份不进 10 月课程这一轮，也不会把 10 月那份挤成「重复」
    assert.deepEqual(applied, ["rec-oct:matched"]);
    assert.equal(result.duplicate, 0);
  });
});

describe("responses deleted in Feishu", () => {
  it("frees the slot and reverts a task with no answers left to sent", () => {
    const { tasks, changed } = releaseDeletedResponses(
      [
        task({ taskId: "t-both", status: "completed", studentResponseId: "rec-gone", parentResponseId: "rec-kept" }),
        task({ taskId: "t-only", status: "completed", studentResponseId: "rec-gone-2", submittedAt: "2026-09-03T02:00:00.000Z", boundBy: "name" }),
        task({ taskId: "t-untouched", status: "completed", studentResponseId: "rec-other" }),
      ],
      new Set(["rec-gone", "rec-gone-2"]),
    );
    assert.deepEqual(changed.map((t) => t.taskId), ["t-both", "t-only"]);
    assert.equal(tasks[0].status, "completed");
    assert.equal(tasks[0].studentResponseId, undefined);
    assert.equal(tasks[0].parentResponseId, "rec-kept");
    assert.equal(tasks[1].status, "sent");
    assert.equal(tasks[1].submittedAt, undefined);
  });

  it("removes stored responses that are gone from Feishu or blank, keeps the rest", async () => {
    const calls: { deleted: string[]; slots: string[] } = { deleted: [], slots: [] };
    const repository = {
      listByCollectionMonth: async () => [task({ collectionMonth: "2026-10", status: "completed", studentResponseId: "rec-deleted" })],
      listAliases: async () => [],
      listManualBindings: async () => [],
      listResponseIds: async () => ["rec-live", "rec-deleted", "rec-blank"],
      deleteResponses: async (ids: string[]) => void calls.deleted.push(...ids),
      updateTaskSlots: async (tasks: StoredFeedbackTask[]) => void calls.slots.push(...tasks.map((t) => t.status)),
      applyResponseOutcomes: async () => {},
      saveSnapshot: async () => {},
    } as unknown as FeedbackTaskRepository;
    const at = Date.parse("2026-10-01T06:00:00.000Z");
    const client = {
      listAllRecords: async () => [
        { record_id: "rec-live", fields: { 学生姓名: "姚凯榕", 老师姓名: "应雁心", 提交时间: at } },
        { record_id: "rec-blank", fields: { 提交时间: at } },
      ],
    } as never;
    const result = await reconcileResponses({ client, config: {} as never, repository, collectionMonth: "2026-10" });
    assert.deepEqual(calls.deleted.sort(), ["rec-blank", "rec-deleted"]);
    // 被删的答卷腾出位置后，rec-live 重新占上去，任务仍是已填写
    assert.equal(result.removed, 2);
    assert.equal(result.unlinked, 0);
    assert.equal(result.matched, 1);
  });
});

describe("feishu webhook verification", () => {
  const encryptKey = "test-encrypt-key";
  const headers = (body: string) => {
    const timestamp = "1758000000";
    const nonce = "abc123";
    return {
      "X-Lark-Request-Timestamp": timestamp,
      "X-Lark-Request-Nonce": nonce,
      "X-Lark-Signature": feishuSignature({ timestamp, nonce, encryptKey, body }),
    };
  };

  it("answers the url_verification challenge", () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "hello", token: "vt" });
    const result = verifyFeishuEvent({ body, headers: headers(body), encryptKey, verificationToken: "vt" });
    assert.deepEqual(result, { ok: true, challenge: "hello" });
  });

  it("accepts an unsigned but encrypted url_verification (what Feishu sends when saving the URL)", () => {
    const key = createHash("sha256").update(encryptKey).digest();
    const iv = Buffer.alloc(16, 3);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const plain = JSON.stringify({ type: "url_verification", challenge: "hi", token: "vt" });
    const body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64") });
    assert.deepEqual(verifyFeishuEvent({ body, headers: {}, encryptKey, verificationToken: "vt" }), { ok: true, challenge: "hi" });
    // 不加密又不带签名的一律拒绝
    const forged = JSON.stringify({ type: "url_verification", challenge: "hi", token: "vt" });
    assert.deepEqual(verifyFeishuEvent({ body: forged, headers: {}, encryptKey, verificationToken: "vt" }), { ok: false, reason: "MISSING_SIGNATURE" });
  });

  it("rejects a forged signature", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const result = verifyFeishuEvent({
      body,
      headers: { ...headers(body), "X-Lark-Signature": "0".repeat(64) },
      encryptKey,
    });
    assert.deepEqual(result, { ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a wrong verification token", () => {
    const body = JSON.stringify({ type: "event_callback", token: "wrong" });
    const result = verifyFeishuEvent({ body, headers: headers(body), encryptKey, verificationToken: "vt" });
    assert.deepEqual(result, { ok: false, reason: "BAD_TOKEN" });
  });

  it("decrypts an encrypted event payload", () => {
    const plain = JSON.stringify({
      header: { token: "vt", event_type: "drive.file.bitable_record_changed_v1" },
      event: { action_list: [{ record_id: "rec-1" }] },
    });
    const key = createHash("sha256").update(encryptKey).digest();
    const iv = Buffer.alloc(16, 7);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
    const body = JSON.stringify({ encrypt: encrypted });

    const result = verifyFeishuEvent({ body, headers: headers(body), encryptKey, verificationToken: "vt" });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true ? result.payload?.event?.action_list?.[0]?.record_id : null, "rec-1");
  });
});
