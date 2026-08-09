import teachersData from "../../data/teachers.json";
import {
  buildRawScheduleLookup,
  buildStudentMonthReports,
  parseCompleteBillingCsv,
} from "../../src/student-billing-batch-data.mjs";
import { mergeTeacherScores } from "../../src/teacher-scores-core.mjs";
import { prepareReportForEditing } from "./report-model.js";

async function compressedSize(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") return bytes.byteLength;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

self.addEventListener("message", async (event) => {
  try {
    const {
      billingFiles,
      scheduleFile,
      scoreFile,
    } = event.data;

    const billingRows = billingFiles.flatMap((file) => (
      parseCompleteBillingCsv(file.text, file.name)
    ));
    if (!billingRows.length) throw new Error("学生课时 CSV 中没有可用课程行");

    const scheduleLookup = buildRawScheduleLookup(scheduleFile.text);
    const reports = buildStudentMonthReports(billingRows, scheduleLookup)
      .map(prepareReportForEditing)
      .sort((a, b) => (
        a.month.localeCompare(b.month)
        || a.studentName.localeCompare(b.studentName, "zh-CN")
      ));

    const scoreMerge = mergeTeacherScores(teachersData.teachers, scoreFile.text);
    const files = await Promise.all([
      ...billingFiles.map(async (file) => ({
        kind: "billing",
        name: file.name,
        originalSize: file.size,
        compressedSize: await compressedSize(file.text),
      })),
      {
        kind: "schedule",
        name: scheduleFile.name,
        originalSize: scheduleFile.size,
        compressedSize: await compressedSize(scheduleFile.text),
      },
      {
        kind: "scores",
        name: scoreFile.name,
        originalSize: scoreFile.size,
        compressedSize: await compressedSize(scoreFile.text),
      },
    ]);

    self.postMessage({
      ok: true,
      reports,
      teachers: scoreMerge.teachers,
      scoreMatch: {
        matched: scoreMerge.matched,
        unmatchedSourceNames: scoreMerge.unmatchedSourceNames,
      },
      files,
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
