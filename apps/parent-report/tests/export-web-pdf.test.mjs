import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildWebPdfOptions,
  deriveWebPdfOutputPath,
} from "../src/export-web-pdf.mjs";

test("deriveWebPdfOutputPath puts the pdf into the web output folder", () => {
  const result = deriveWebPdfOutputPath(
    "outputs/parent_reports/claude-ivy-2488-2026-03.html",
  );
  assert.equal(
    result,
    path.resolve("outputs/parent_reports_web/claude-ivy-2488-2026-03.pdf"),
  );
});

test("deriveWebPdfOutputPath honors a custom output directory", () => {
  const result = deriveWebPdfOutputPath(
    "/tmp/whatever/codex-ivy-2488-2026-03.html",
    "/tmp/out",
  );
  assert.equal(result, "/tmp/out/codex-ivy-2488-2026-03.pdf");
});

test("buildWebPdfOptions produces a vector continuous-page config", () => {
  assert.deepEqual(
    buildWebPdfOptions({ widthPx: 1000, heightPx: 6800 }),
    {
      width: "1000px",
      height: "6800px",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      preferCSSPageSize: false,
      tagged: true,
    },
  );
});
