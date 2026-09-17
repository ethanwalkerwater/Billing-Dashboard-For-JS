import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalTeacherName,
  parseTeacherScoresCsv,
} from "../src/teacher-scores.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const DEFAULT_INPUT = path.resolve(
  REPO_ROOT,
  "outputs/teacher-feedback/cumulative/teacher_scores.csv",
);
const DEFAULT_CARDS = path.resolve(APP_ROOT, "assets/teacher/老师卡片.txt");
const SCORE_FIELDS = ["学习提升", "责任心", "个人魅力"];

function replaceScore(block, field, value) {
  if (value == null || value === "") return block;
  const line = new RegExp(`^${field}[:：][ \\t]*[^\\r\\n]*$`, "m");
  if (line.test(block)) return block.replace(line, `${field}: ${value}`);
  return `${block.trimEnd()}\n${field}: ${value}`;
}

export function syncCumulativeTeacherScores(cardText, scoreCsvText) {
  const scores = parseTeacherScoresCsv(scoreCsvText);
  const matchedSourceNames = new Set();
  const matchedTeachers = [];
  const blocks = cardText.split(/(^---[ \t]*$)/m);

  for (let index = 0; index < blocks.length; index += 1) {
    if (/^---[ \t]*$/m.test(blocks[index])) continue;
    const name = blocks[index].match(/^姓名[:：]\s*(.+)$/m)?.[1]?.trim();
    if (!name) continue;
    const score = scores.get(canonicalTeacherName(name));
    if (!score) continue;

    let updated = blocks[index];
    for (const field of SCORE_FIELDS) updated = replaceScore(updated, field, score[field]);
    blocks[index] = updated;
    matchedTeachers.push(name);
    matchedSourceNames.add(score.sourceName);
  }

  const unmatchedSourceNames = [...scores.values()]
    .map((score) => score.sourceName)
    .filter((name) => !matchedSourceNames.has(name));

  return {
    cardText: blocks.join(""),
    matchedTeachers,
    unmatchedSourceNames,
  };
}

function main() {
  const input = path.resolve(process.argv[2] || DEFAULT_INPUT);
  const cards = path.resolve(process.argv[3] || DEFAULT_CARDS);
  if (!fs.existsSync(input)) {
    throw new Error(`历史累计评分不存在：${input}`);
  }

  const result = syncCumulativeTeacherScores(
    fs.readFileSync(cards, "utf8"),
    fs.readFileSync(input, "utf8"),
  );
  fs.writeFileSync(cards, result.cardText, "utf8");
  console.log(`已用历史累计评分更新 ${result.matchedTeachers.length} 张师资卡 ← ${input}`);
  if (result.unmatchedSourceNames.length) {
    console.warn("⚠ 累计评分未匹配到师资卡:", result.unmatchedSourceNames.join(", "));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
