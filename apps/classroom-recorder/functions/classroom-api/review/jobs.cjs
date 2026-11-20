const { randomUUID } = require("node:crypto");
const { analyze, hash } = require("./analyze.cjs");
const TABLE = "classroom_content_reviews";
const eq = (s) => "eq." + encodeURIComponent(s);
async function rest(table, query, method = "GET", body) {
  const r = await fetch(
    "https://" +
      process.env.CLOUDBASE_ENV_ID +
      ".api.tcloudbasegateway.com/v1/rdb/rest/" +
      table +
      "?" +
      query,
    {
      method,
      headers: {
        authorization: "Bearer " + process.env.CLOUDBASE_API_KEY,
        "content-type": "application/json",
        prefer: "return=representation",
        "accept-profile": "public",
        "content-profile": "public",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok) throw Error("DATABASE_" + r.status);
  return r.json();
}
async function processReview(id) {
  const [doc] = await rest(
    "classroom_lessons",
    "_id=" + eq(id) + "&select=kind,transcript,student,teacherName",
  );
  if (!doc?.transcript || ["meeting", "merged"].includes(doc.kind)) return { status: "skip" };
  const h = hash(doc.transcript),
    now = new Date().toISOString();
  const key = "lesson_id=" + eq(id) + "&source_hash=" + eq(h) + "&version=eq.1";
  const [job] = await rest(TABLE, key + "&select=status,available_at,attempts");
  if (!job) return { status: "not_queued" };
  if (
    !["pending", "running", "failed"].includes(job.status) ||
    job.attempts >= 4 ||
    Date.parse(job.available_at) > Date.now()
  )
    return { status: job.status };
  const lease = randomUUID();
  const claimed = await rest(
    TABLE,
    key +
      "&status=" +
      eq(job.status) +
      "&attempts=eq." +
      job.attempts +
      "&available_at=lte." +
      encodeURIComponent(now) +
      "&select=status",
    "PATCH",
    {
      lease,
      status: "running",
      attempts: job.attempts + 1,
      available_at: new Date(Date.now() + 8 * 60000).toISOString(),
    },
  );
  if (!claimed.length) return { status: "busy" };
  const guard = key + "&lease=" + eq(lease) + "&select=status";
  try {
    const result = await analyze(doc);
    const saved = await rest(TABLE, guard, "PATCH", {
      ...result,
      status: "done",
      lease: null,
      error_code: null,
      completed_at: new Date().toISOString(),
    });
    if (!saved.length) return { status: "superseded" };
    return { status: "done", count: result.findings.length, usage: result.usage };
  } catch (err) {
    const message = String(err.message);
    const code =
      /^(MODEL_(HTTP_\d+|SCHEMA|EVIDENCE|INCOMPLETE|ENDPOINT)|TRANSCRIPT_FORMAT|DATABASE_\d+)$/.test(message)
        ? message
        : err instanceof SyntaxError
          ? "MODEL_JSON"
          : "REQUEST_ERROR";
    await rest(TABLE, guard, "PATCH", {
      status: "failed",
      lease: null,
      error_code: code,
      available_at: new Date(Date.now() + 15000 * (job.attempts + 1)).toISOString(),
    });
    throw Error(code);
  }
}
module.exports = { rest, processReview, TABLE };
