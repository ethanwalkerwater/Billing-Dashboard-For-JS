import test from "node:test";
import assert from "node:assert/strict";

import { mergeTeacherScores } from "../src/teacher-scores.mjs";

test("mergeTeacherScores maps feedback score columns onto teacher cards", () => {
  const teachers = [
    { name: "Valentina Lin", scores: {} },
    { name: "马怡婷", scores: {} },
    { name: "黄钢", scores: {} },
  ];

  const result = mergeTeacherScores(teachers, `老师,学习提升效果,责任心与服务态度,个人魅力
Valentina林,4.9,4.92,4.89
马,4.8,4.8,4.8
黄钢,4.99,5.0,4.99
未入库老师,5,5,5`);

  assert.deepEqual(result.matched, [
    { teacher: "Valentina Lin", sourceName: "Valentina林" },
    { teacher: "马怡婷", sourceName: "马" },
    { teacher: "黄钢", sourceName: "黄钢" },
  ]);
  assert.deepEqual(result.unmatchedSourceNames, ["未入库老师"]);
  assert.deepEqual(result.teachers[0].scores, {
    "学习提升": "4.9",
    "责任心": "4.9",
    "个人魅力": "4.9",
  });
  assert.deepEqual(result.teachers[1].scores, {
    "学习提升": "4.8",
    "责任心": "4.8",
    "个人魅力": "4.8",
  });
});
