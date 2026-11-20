const assert = require("node:assert/strict");
const { rest, processReview, TABLE } = require("../functions/classroom-api/review/jobs.cjs");
const { parseTranscript, hash } = require("../functions/classroom-api/review/analyze.cjs");
async function main() {
  const mode = process.argv[2];
  assert.ok(["pilot", "all", "audit"].includes(mode));
  const start = Date.parse("2026-11-11T00:00:00+08:00"),
    end = Date.parse("2026-11-21T00:00:00+08:00");
  const docs = await rest(
    "classroom_lessons",
    `select=_id,audioSec&startAt=gte.${start}&startAt=lt.${end}&or=(kind.in.(adhoc,lesson),kind.is.null)&transcript=neq.&order=audioSec.asc,_id.asc&limit=1000`,
  );
  assert.ok(docs.length >= 5 && docs.length < 1000);
  const existing =
    mode === "pilot"
      ? new Set(
          (await rest(TABLE, "select=lesson_id&status=eq.done&version=eq.1&limit=1000")).map(
            (r) => r.lesson_id,
          ),
        )
      : new Set();
  const pilotCandidates = [0, 0.25, 0.5, 0.75, 1].map((f) => docs[Math.round(f * (docs.length - 1))]);
  const jobs =
    mode === "pilot"
      ? [
          ...docs.filter((d) => existing.has(d._id)),
          ...pilotCandidates.filter((d) => !existing.has(d._id)),
        ].slice(0, 5)
      : docs;
  console.log(JSON.stringify({ mode, eligible: docs.length, selected: jobs.length }));
  let pos = 0,
    completed = 0,
    findings = 0,
    calls = 0,
    input = 0,
    output = 0;
  const failures = {};
  async function handle(doc) {
    if (mode !== "audit") await processReview(doc._id);
    const eq = encodeURIComponent(doc._id);
    const records = await rest(
      TABLE,
      "lesson_id=eq." + eq + "&version=eq.1&status=eq.done&select=source_hash,findings,usage",
    );
    if (!records.length) throw Error("NOT_DONE");
    const [source] = await rest("classroom_lessons", "_id=eq." + eq + "&select=transcript");
    const report = records.find((r) => r.source_hash === hash(source.transcript));
    assert.ok(report);
    const lines = parseTranscript(source.transcript);
    assert.equal(report.usage.lines, lines.length);
    for (const f of report.findings)
      for (const e of f.evidence)
        assert.deepEqual({ start: e.start, end: e.end, text: e.text, speaker: e.speaker }, lines[e.line]);
    completed++;
    findings += report.findings.length;
    calls += report.usage.calls;
    input += report.usage.input;
    output += report.usage.output;
  }
  await Promise.all(
    Array.from({ length: Math.min(jobs.length, 8) }, async () => {
      while (pos < jobs.length) {
        const doc = jobs[pos++];
        try {
          await handle(doc);
        } catch (e) {
          const c = /^(MODEL_[A-Z0-9_]+|DATABASE_\d+|TRANSCRIPT_FORMAT|REQUEST_ERROR|NOT_DONE)$/.test(
            e.message,
          )
            ? e.message
            : "VERIFY_ERROR";
          failures[c] = (failures[c] || 0) + 1;
        }
        if (mode === "pilot" || (completed && completed % 20 === 0))
          console.log(JSON.stringify({ completed, findings, failures }));
      }
    }),
  );
  console.log(
    JSON.stringify({ mode, total: jobs.length, completed, findings, calls, input, output, failures }),
  );
  if (completed !== jobs.length) process.exitCode = 1;
}
main().catch((e) => {
  console.error("批次执行失败", e.name, String(e.message).slice(0, 60));
  process.exitCode = 1;
});
