import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalName,
  parseTeacherScoresCsv,
} from "../../../packages/billing-core/src/payroll-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const DEFAULT_INPUT = path.resolve(
  REPO_ROOT,
  "outputs/teacher-feedback/cumulative/teacher_scores.csv",
);
const DEFAULT_OUTPUT = path.resolve(APP_ROOT, "web/assets/payroll/defaults.json");

export function withCumulativeTeacherScores(defaults, csvText) {
  const keyOf = (value) => canonicalName(value, defaults.nameAliases || {})
    .replace(/老师$/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  const byTeacher = new Map(
    (defaults.teacherScores || []).map((row) => [keyOf(row.teacher), row]),
  );
  for (const cumulative of parseTeacherScoresCsv(csvText, {
    nameAliases: defaults.nameAliases || {},
  })) {
    const key = keyOf(cumulative.teacher);
    const existing = byTeacher.get(key);
    const metrics = {
      learning: cumulative.metrics.learning ?? existing?.metrics?.learning ?? null,
      responsibility: cumulative.metrics.responsibility ?? existing?.metrics?.responsibility ?? null,
      charisma: cumulative.metrics.charisma ?? existing?.metrics?.charisma ?? null,
    };
    if (Object.values(metrics).every((value) => value == null)) continue;
    byTeacher.set(key, { ...existing, ...cumulative, metrics });
  }
  return {
    ...defaults,
    teacherScores: [...byTeacher.values()],
  };
}

function main() {
  const input = path.resolve(process.argv[2] || DEFAULT_INPUT);
  const output = path.resolve(process.argv[3] || DEFAULT_OUTPUT);
  if (!fs.existsSync(input)) throw new Error(`历史累计评分不存在：${input}`);
  if (!fs.existsSync(output)) throw new Error(`老师收入默认值不存在：${output}`);

  const defaults = JSON.parse(fs.readFileSync(output, "utf8"));
  const updated = withCumulativeTeacherScores(defaults, fs.readFileSync(input, "utf8"));
  fs.writeFileSync(output, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  console.log(`已同步 ${updated.teacherScores.length} 位历史累计评分 → ${output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
