import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredFeedbackTask } from "../src/server/tasks/types";
import { pinNewTasks } from "../src/web/task-list";

function task(taskId: string, studentName: string): StoredFeedbackTask {
  return {
    taskId,
    courseMonth: "2026-10",
    collectionMonth: "2026-11",
    studentRecordId: taskId,
    studentName,
    teacherSourceName: "应雁心",
    teacherCanonicalName: "应雁心",
    courseNames: ["IG数学"],
    scheduleRecordIds: [],
    status: "unsent",
    publicToken: "t",
    responseRecordIds: [],
    validationIssues: [],
    createdAt: "",
    updatedAt: "",
  };
}

describe("pinNewTasks", () => {
  it("keeps order when nothing is new", () => {
    const rows = [task("a", "A"), task("b", "B")];
    assert.deepEqual(
      pinNewTasks(rows, new Set()).map((row) => row.taskId),
      ["a", "b"],
    );
  });

  it("moves new task ids to the front and keeps relative order", () => {
    const rows = [task("a", "A"), task("b", "B"), task("c", "C"), task("d", "D")];
    assert.deepEqual(
      pinNewTasks(rows, new Set(["c", "a"])).map((row) => row.taskId),
      ["a", "c", "b", "d"],
    );
  });
});
