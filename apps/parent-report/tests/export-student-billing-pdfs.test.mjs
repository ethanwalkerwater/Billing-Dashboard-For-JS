import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildStudentBillingPdfExportOptions,
  deriveStudentBillingPdfOutputPath,
  listStudentBillingHtmlFiles,
} from "../src/export-student-billing-pdfs.mjs";

test("deriveStudentBillingPdfOutputPath writes pdfs to generated pdf folder", () => {
  const result = deriveStudentBillingPdfOutputPath(
    "outputs/parent_reports/generated/Daniel 周恩东-2026-03.html",
  );

  assert.equal(
    result,
    path.resolve("outputs/parent_reports/generated_pdfs/Daniel 周恩东-2026-03.pdf"),
  );
});

test("deriveStudentBillingPdfOutputPath honors a custom output directory", () => {
  const result = deriveStudentBillingPdfOutputPath(
    "/tmp/generated/Ivy-2026-03.html",
    "/tmp/pdfs",
  );

  assert.equal(result, "/tmp/pdfs/Ivy-2026-03.pdf");
});

test("listStudentBillingHtmlFiles returns sorted html files only", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jingshi-html-list-"));
  fs.writeFileSync(path.join(tmp, "Mobby-2026-03.html"), "<html></html>", "utf8");
  fs.writeFileSync(path.join(tmp, "Archer-2026-03.html"), "<html></html>", "utf8");
  fs.writeFileSync(path.join(tmp, "ignore.pdf"), "", "utf8");

  assert.deepEqual(
    listStudentBillingHtmlFiles(tmp).map((file) => path.basename(file)),
    ["Archer-2026-03.html", "Mobby-2026-03.html"],
  );
});

test("buildStudentBillingPdfExportOptions exports each report section as its own page", () => {
  assert.deepEqual(
    buildStudentBillingPdfExportOptions({ widthPx: 1120 }),
    {
      widthPx: 1120,
      sectionSelector: ".page",
      variableSectionPages: true,
      optimizeForPreview: true,
    },
  );
});
