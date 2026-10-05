import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist-functions/feedback-api");

mkdirSync(outDir, { recursive: true });

// 依赖全部打进单文件，云函数包里不带 node_modules，部署快也不会有版本漂移。
await build({
  entryPoints: [resolve(root, "functions/feedback-api/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

writeFileSync(
  resolve(outDir, "package.json"),
  `${JSON.stringify({ name: "feedback-api", version: "1.0.0", main: "index.js", private: true }, null, 2)}\n`,
);

console.log(`feedback-api -> ${outDir}`);

// feedback-score 是 Python 函数：入口 + 老看板的两个评分脚本（单一来源，打包时复制，不另存一份）。
const scoreDir = resolve(root, "dist-functions/feedback-score");
const scripts = resolve(root, "../teacher-feedback/scripts");
mkdirSync(scoreDir, { recursive: true });
copyFileSync(resolve(root, "functions/feedback-score/index.py"), resolve(scoreDir, "index.py"));
for (const file of ["monthly_teacher_feedback.py", "cumulative_teacher_feedback.py"]) {
  copyFileSync(resolve(scripts, file), resolve(scoreDir, file));
}
console.log(`feedback-score -> ${scoreDir}`);
