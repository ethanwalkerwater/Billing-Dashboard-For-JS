import test from "node:test";
import assert from "node:assert/strict";

import { syncCumulativeTeacherScores } from "../scripts/sync-cumulative-teacher-scores.mjs";

test("cumulative score sync updates three card dimensions and keeps unrelated content", () => {
  const cards = `姓名: 马怡婷
简介: 保留这段介绍
学习提升: 1.0
责任心: 1.0
个人魅力: 1.0

---

姓名: 未评分老师
学习提升: 4.0
责任心: 4.0
个人魅力: 4.0
`;
  const scores = `排名,老师,学习提升效果,责任心与服务态度,个人魅力,总评分
1,马,4.96,4.98,4.94,4.96
2,不在卡片中,5,5,5,5`;

  const result = syncCumulativeTeacherScores(cards, scores);

  assert.match(result.cardText, /姓名: 马怡婷[\s\S]*学习提升: 5\.0[\s\S]*责任心: 5\.0[\s\S]*个人魅力: 4\.9/);
  assert.match(result.cardText, /姓名: 未评分老师[\s\S]*学习提升: 4\.0/);
  assert.match(result.cardText, /简介: 保留这段介绍/);
  assert.deepEqual(result.matchedTeachers, ["马怡婷"]);
  assert.deepEqual(result.unmatchedSourceNames, ["不在卡片中"]);
});

test("cumulative score sync preserves card separators when score values are blank", () => {
  const cards = `姓名: 高志勇
学习提升:
责任心:
个人魅力:

---

姓名: 李寅鑫
学习提升: 4.5
责任心: 4.9
个人魅力: 4.7
`;
  const scores = `排名,老师,学习提升效果,责任心与服务态度,个人魅力,总评分
1,高志勇,4.865,4.977,4.913,4.918`;

  const result = syncCumulativeTeacherScores(cards, scores);

  assert.match(
    result.cardText,
    /姓名: 高志勇\n学习提升: 4\.9\n责任心: 5\.0\n个人魅力: 4\.9\n\n---\n\n姓名: 李寅鑫/,
  );
});
