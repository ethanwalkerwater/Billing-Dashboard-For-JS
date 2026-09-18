import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { describe, it } from "node:test";

import { feishuSignature, verifyFeishuEvent } from "../functions/feedback-api/feishu-event";
import type { FeedbackResponseRecord } from "../src/server/feishu/parsers";
import { matchResponsesToTasks } from "../src/server/sync/reconcile-responses";
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
