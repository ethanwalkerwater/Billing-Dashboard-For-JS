import fs from "node:fs";

import { cleanText, parseCsv } from "@jingshi/billing-core";

const SCORE_COLUMNS = {
  "学习提升": ["学习提升", "学习提升效果"],
  "责任心": ["责任心", "责任心与服务态度"],
  "个人魅力": ["个人魅力"],
};

const NAME_ALIASES = new Map([
  ["valentina林", "valentinalin"],
  ["马", "马怡婷"],
]);

function normalizeTeacherName(value) {
  return cleanText(value)
    .replace(/老师$/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function scoreValue(value) {
  const text = cleanText(value);
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return number.toFixed(1);
}

function pickScore(row, columns) {
  for (const column of columns) {
    const value = scoreValue(row[column]);
    if (value) return value;
  }
  return null;
}

export function parseTeacherScoresCsv(csvText) {
  const rows = parseCsv(csvText);
  const scores = new Map();

  for (const row of rows) {
    const rawName = cleanText(row["老师"]);
    if (!rawName) continue;

    const normalizedName = normalizeTeacherName(rawName);
    const key = NAME_ALIASES.get(normalizedName) || normalizedName;
    scores.set(key, {
      "学习提升": pickScore(row, SCORE_COLUMNS["学习提升"]),
      "责任心": pickScore(row, SCORE_COLUMNS["责任心"]),
      "个人魅力": pickScore(row, SCORE_COLUMNS["个人魅力"]),
      sourceName: rawName,
    });
  }

  return scores;
}

export function mergeTeacherScores(teachers, csvText) {
  const scoresByName = parseTeacherScoresCsv(csvText);
  const matched = [];

  const mergedTeachers = teachers.map((teacher) => {
    const key = normalizeTeacherName(teacher.name);
    const score = scoresByName.get(key);
    if (!score) return teacher;

    matched.push({ teacher: teacher.name, sourceName: score.sourceName });
    return {
      ...teacher,
      scores: {
        "学习提升": score["学习提升"],
        "责任心": score["责任心"],
        "个人魅力": score["个人魅力"],
      },
    };
  });

  const matchedSourceNames = new Set(matched.map((entry) => entry.sourceName));
  const unmatchedSourceNames = [...scoresByName.values()]
    .map((score) => score.sourceName)
    .filter((name) => !matchedSourceNames.has(name));

  return {
    teachers: mergedTeachers,
    matched,
    unmatchedSourceNames,
  };
}

export function mergeTeacherScoresFromFile(teachers, scoresPath) {
  return mergeTeacherScores(teachers, fs.readFileSync(scoresPath, "utf8"));
}
