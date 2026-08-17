import fs from "node:fs";

export {
  canonicalTeacherName,
  mergeTeacherScores,
  normalizeTeacherName,
  parseTeacherScoresCsv,
} from "./teacher-scores-core.mjs";

import { mergeTeacherScores } from "./teacher-scores-core.mjs";

export function mergeTeacherScoresFromFile(teachers, scoresPath) {
  return mergeTeacherScores(teachers, fs.readFileSync(scoresPath, "utf8"));
}
