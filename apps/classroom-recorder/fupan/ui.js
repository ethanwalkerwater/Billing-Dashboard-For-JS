const P = {
  inbox:
    "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11",
  cal: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  chev: "m9 18 6-6-6-6",
  chevs: "m7 15 5 5 5-5M7 9l5-5 5 5",
  back: "m15 18-6-6 6-6",
  x: "M18 6 6 18M6 6l12 12",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3",
  play: "M6 4l14 8-14 8z",
  pause: "M7 4h3v16H7zM14 4h3v16h-3z",
  rw: "M11 17l-5-5 5-5M18 17l-5-5 5-5",
  ff: "M13 17l5-5-5-5M6 17l5-5-5-5",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  text: "M17 6.1H3M21 12.1H3M15.1 18H3",
  pen: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
};
export const icon = (key) =>
  '<svg class="i" aria-hidden="true" viewBox="0 0 24 24"><path d="' +
  P[key] +
  '"/></svg>';
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const lessonLink = (id) => "#/lesson/" + encodeURIComponent(id);
export const timestamp = (value) => {
  const s = Math.max(0, Math.floor(Number(value) || 0));
  return (
    String(Math.floor(s / 60)).padStart(2, "0") +
    ":" +
    String(s % 60).padStart(2, "0")
  );
};
const iso = (ms) => new Date(ms + 8 * 3600000).toISOString();
export const dateAt = (ms) => iso(ms).slice(0, 10);
export function when(value) {
  if (!value) return "";
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? iso(ms).slice(0, 16).replace("T", " ") : "";
}
export const addDays = (date, days) =>
  new Date(Date.parse(date + "T00:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
export function badge(label) {
  const style =
    label === "紧急"
      ? "bad"
      : label === "重要" || String(label).startsWith("待复核")
        ? "warn"
        : label === "亮点"
          ? "good"
          : "sec";
  const shape = style === "bad" ? "sq" : style === "warn" ? "tri" : "ring";
  return (
    '<span class="badge ' +
    style +
    '"><i class="sh ' +
    shape +
    '"></i>' +
    esc(label) +
    "</span>"
  );
}
export const resultName = (value) =>
  ({ confirm: "已确认", refer: "已转办", dismiss: "已排除", close: "已关闭", resolve_confirm: "学科核对确认", resolve_dismiss: "学科核对排除" })[
    value
  ] || "";
export const empty = (message) =>
  '<div class="empty"><div class="empty-media">' +
  icon("inbox") +
  '</div><div class="empty-t">' +
  esc(message) +
  "</div></div>";
export const title = (text, meta = "", actions = "") =>
  '<div class="pgh"><div><h1>' +
  esc(text) +
  "</h1>" +
  (meta ? '<div class="meta">' + meta + "</div>" : "") +
  '</div><span class="grow"></span>' +
  actions +
  "</div>";
export const card = (heading, body) =>
  '<section class="card"><div class="card-h"><h3>' +
  esc(heading) +
  '</h3></div><div class="card-b">' +
  body +
  "</div></section>";
export const stat = (label, value) =>
  "<div><small>" +
  esc(label) +
  "</small><b>" +
  esc(value ?? "—") +
  "</b></div>";

export function relatedCourses(item) {
  const rows = item.relatedLessons || [];
  if (item.findingId !== "rule-missing" || !rows.length) return "";
  return '<details><summary>关联课程（' + rows.length + ' 节）</summary><ul class="history">' +
    rows.map((row, i) => '<li><a class="ulink" href="' + lessonLink(row.lessonId) + '">课程 ' +
      (i + 1) + ' · ' + esc(when(row.startAt)) + '</a></li>').join("") + '</ul></details>';
}

export function historicalEvidence(item) {
  return (item.evidence || [])
    .map((e) => {
      const clock =
        e.start == null
          ? ""
          : timestamp(e.start) + (e.end == null ? "" : "–" + timestamp(e.end));
      return (
        '<div class="qline"><span class="sm muted">' +
        clock +
        "</span><small>" +
        esc(e.speaker) +
        "</small><span>" +
        esc(e.text) +
        "</span></div>"
      );
    })
    .join("");
}
export function historicalStatus(item) {
  const state = { follow: "跟进中", closed: "已关闭" }[item.state] || "";
  return esc(
    [
      state,
      resultName(item.result),
      item.owner && "负责人 " + item.owner,
      item.note,
    ]
      .filter(Boolean)
      .join(" · "),
  );
}
