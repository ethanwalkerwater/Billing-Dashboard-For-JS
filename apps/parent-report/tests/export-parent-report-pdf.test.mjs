import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuousPdfOptions,
  derivePdfOutputPath,
} from "../src/export-parent-report-pdf.mjs";

test("derivePdfOutputPath defaults to a sibling pdf file", () => {
  assert.equal(
    derivePdfOutputPath("/tmp/parent/ivy-2488-2026-03.html"),
    "/tmp/parent/ivy-2488-2026-03.pdf",
  );
  assert.equal(
    derivePdfOutputPath("/tmp/parent/ivy-2488-2026-03.html", "/tmp/out/custom.pdf"),
    "/tmp/out/custom.pdf",
  );
});

test("buildContinuousPdfOptions creates a vector PDF config for a long web page", () => {
  assert.deepEqual(
    buildContinuousPdfOptions({ widthPx: 1000, heightPx: 4180 }),
    {
      width: "1000px",
      height: "4180px",
      printBackground: true,
      margin: {
        top: "0",
        right: "0",
        bottom: "0",
        left: "0",
      },
      preferCSSPageSize: false,
      tagged: true,
    },
  );
});
