import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ScoreResponse } from "../src/server/scores/recompute";

const APP = resolve(import.meta.dirname, "..");

/** 在本机跑 functions/feedback-score/index.py（和云函数同一份代码）。脚本会往 stdout 打日志，所以结果走临时文件。 */
export function computeLocally(event: Record<string, unknown>): ScoreResponse {
  const dir = mkdtempSync(join(tmpdir(), "feedback-score-"));
  writeFileSync(join(dir, "in.json"), JSON.stringify(event));
  const run = spawnSync(
    "python3",
    ["-c", "import json,sys,index; json.dump(index.main(json.load(open(sys.argv[1]))), open(sys.argv[2], 'w'), ensure_ascii=False)", join(dir, "in.json"), join(dir, "out.json")],
    { cwd: resolve(APP, "functions/feedback-score"), env: { ...process.env, PYTHONPATH: resolve(APP, "../teacher-feedback/scripts") }, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`评分脚本失败：${run.stderr}`);
  return JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as ScoreResponse;
}
