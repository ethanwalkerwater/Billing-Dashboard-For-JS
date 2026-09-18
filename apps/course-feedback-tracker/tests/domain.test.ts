import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FORM_PREFILL_KEYS,
  assertTaskStatusTransition,
  buildPrefilledFormUrl,
  collectionMonthToCourseMonth,
  createDeterministicPublicToken,
  groupScheduleIntoTasks,
  monthRangeInShanghai,
} from "../src/domain/index";
import type { ScheduleRecord, StudentRecord } from "../src/domain/index";

const students: StudentRecord[] = [
  { recordId: "student-1", name: "姚凯榕" },
  { recordId: "student-2", name: "Lucas Zhang" },
];

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    recordId: "lesson-1",
    startsAt: "2026-08-12T10:00:00+08:00",
    studentRecordIds: ["student-1"],
    teacherNames: ["应雁心"],
    courseNames: ["IG数学"],
    teachingTypes: ["1v1"],
    cancellationTags: [],
    ...overrides,
  };
}

describe("month rules", () => {
  it("maps collection month to previous course month across year boundary", () => {
    assert.equal(collectionMonthToCourseMonth("2026-09"), "2026-08");
    assert.equal(collectionMonthToCourseMonth("2026-01"), "2025-12");
  });

  it("creates an exclusive Shanghai month range", () => {
    assert.deepEqual(monthRangeInShanghai("2026-08"), {
      month: "2026-08",
      startInclusive: "2026-08-01T00:00:00+08:00",
      endExclusive: "2026-09-01T00:00:00+08:00",
    });
  });
});

describe("task grouping", () => {
  it("deduplicates student-teacher pairs and merges course names", async () => {
    const result = await groupScheduleIntoTasks(
      [
        schedule(),
        schedule({ recordId: "lesson-2", courseNames: ["数学刷题班"] }),
        schedule({ recordId: "lesson-3", studentRecordIds: ["student-2"] }),
      ],
      students,
      { collectionMonth: "2026-09" },
    );

    assert.equal(result.tasks.length, 2);
    const yao = result.tasks.find((task) => task.studentName === "姚凯榕");
    assert.deepEqual(new Set(yao?.courseNames), new Set(["IG数学", "数学刷题班"]));
    assert.equal(yao?.courseMonth, "2026-08");
    assert.equal(yao?.collectionMonth, "2026-09");
    assert.match(yao?.taskId ?? "", /^ft_202608_[a-f0-9]{24}$/);
  });

  it("excludes cancelled and administrative records", async () => {
    const result = await groupScheduleIntoTasks(
      [
        schedule({ recordId: "cancelled", cancellationTags: ["2h-50%"] }),
        schedule({ recordId: "meeting", courseNames: ["申请规划跟进会议"] }),
        // 非授课判断要看「授课类型」，不能只看「课程类型」。
        schedule({ recordId: "self-study", courseNames: ["数学"], teachingTypes: ["自习"] }),
        schedule({ recordId: "lesson" }),
      ],
      students,
      { collectionMonth: "2026-09" },
    );

    assert.deepEqual(
      result.excludedRecords.map((record) => record.recordId).sort(),
      ["cancelled", "meeting", "self-study"],
    );
    assert.match(result.excludedRecords[0].reason, /临时取消/);
    assert.equal(result.tasks.length, 1);
  });

  it("still creates a task for an ambiguous course type but flags it for review", async () => {
    const result = await groupScheduleIntoTasks(
      // 有老师的作业课可能是真辅导，漏发比误发更难补救，所以照常生成任务再让教务复核。
      [schedule({ recordId: "homework", courseNames: ["作业课"] })],
      students,
      { collectionMonth: "2026-09" },
    );

    assert.equal(result.tasks.length, 1);
    assert.deepEqual(
      result.reviewRecords.map((record) => record.recordId),
      ["homework"],
    );
  });

  /**
   * 真实课表里「请假」「模拟考试」「例会」这类记录本来就没有老师或学生。
   * 如果先查缺字段再查排除规则，一个月会有近 300 条被误报成"课表数据有问题"，异常清单就废了。
   */
  it("treats a non-teaching record without a teacher as excluded, not as broken data", async () => {
    const result = await groupScheduleIntoTasks(
      [
        schedule({ recordId: "leave", teacherNames: [], courseNames: ["请假"] }),
        schedule({ recordId: "mock", teacherNames: [], courseNames: ["模拟考试"], teachingTypes: ["学生模测"] }),
        schedule({ recordId: "staff-meeting", teacherNames: [], studentRecordIds: [], courseNames: ["例会"] }),
        schedule({ recordId: "real-lesson-no-teacher", teacherNames: [], courseNames: ["IG数学"] }),
      ],
      students,
      { collectionMonth: "2026-09" },
    );

    assert.deepEqual(
      result.excludedRecords.map((record) => record.recordId).sort(),
      ["leave", "mock", "staff-meeting"],
    );
    // 看起来是正常课却缺老师，才是真正需要去飞书修的数据问题。
    assert.deepEqual(result.invalidRecords, [{ recordId: "real-lesson-no-teacher", reasons: ["缺少老师"] }]);
  });

  it("skips other months quietly and only flags a record with no lesson time", async () => {
    const result = await groupScheduleIntoTasks(
      [
        schedule({ recordId: "july", startsAt: "2026-07-12T10:00:00+08:00" }),
        schedule({ recordId: "no-time", startsAt: "" }),
      ],
      students,
      { collectionMonth: "2026-09" },
    );

    assert.equal(result.tasks.length, 0);
    assert.deepEqual(result.invalidRecords, [{ recordId: "no-time", reasons: ["缺少上课时间"] }]);
    assert.equal(result.excludedRecords.length, 0);
  });

  it("reports missing linked student records instead of silently dropping them", async () => {
    const result = await groupScheduleIntoTasks(
      [schedule({ recordId: "broken", studentRecordIds: ["missing"] })],
      students,
      { collectionMonth: "2026-09" },
    );

    assert.equal(result.tasks.length, 0);
    assert.deepEqual(result.invalidRecords, [
      { recordId: "broken", reasons: ["学生关联不存在：missing"] },
    ]);
  });
});

describe("form URL", () => {
  it("encodes only teacher and student with the exact Feishu prefill keys", () => {
    const value = buildPrefilledFormUrl({
      baseUrl: "https://example.feishu.cn/share/base/form/demo",
      teacherName: "应雁心",
      studentName: "姚凯榕",
    });
    const url = new URL(value);
    assert.equal(url.searchParams.get(FORM_PREFILL_KEYS.teacher), "应雁心");
    assert.equal(url.searchParams.get(FORM_PREFILL_KEYS.student), "姚凯榕");
    // 业务方决定不用任务 ID，也不往飞书表加字段，URL 里不能出现它。
    assert.equal([...url.searchParams.keys()].length, 2);
  });
});

describe("status transitions", () => {
  it("keeps response-backed tasks completed", () => {
    assert.throws(
      () =>
        assertTaskStatusTransition({
          current: "completed",
          next: "sent",
          source: "manual",
          hasResponse: true,
        }),
      /不能改为未完成状态/,
    );
  });

  it("lets response sync complete any unfinished task", () => {
    assert.doesNotThrow(() =>
      assertTaskStatusTransition({
        current: "declined",
        next: "completed",
        source: "response-sync",
        hasResponse: false,
      }),
    );
  });
});

describe("public task token", () => {
  it("creates a stable opaque HMAC token without storing the public token", async () => {
    const pepper = "a-production-secret-must-be-at-least-32-characters";
    const first = await createDeterministicPublicToken("ft_202608_demo", pepper);
    const second = await createDeterministicPublicToken("ft_202608_demo", pepper);
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, await createDeterministicPublicToken("ft_202608_other", pepper));
  });
});
