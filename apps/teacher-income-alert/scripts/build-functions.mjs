import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist-functions/income-api");

mkdirSync(outDir, { recursive: true });

// 依赖全部打进单文件，云函数包里不带 node_modules。
await build({
  entryPoints: [resolve(root, "functions/income-api/index.ts")],
  outfile: resolve(outDir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  logLevel: "info",
});

writeFileSync(
  resolve(outDir, "package.json"),
  `${JSON.stringify({ name: "income-api", version: "1.0.0", main: "index.js", private: true }, null, 2)}\n`,
);
