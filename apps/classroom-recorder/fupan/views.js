import {
  icon,
  esc,
  badge,
  timestamp,
  when,
  dateAt,
  lessonLink,
  empty,
  title,
  stat,
  card,
  addDays,
  resultName,
  historicalEvidence,
  historicalStatus,
} from "./ui.js";

export function issueRows(items, detail = false, all = items) {
  return items
    .map((it) => {
      const index = all.indexOf(it);
      const missing = /^missing-(\d{4}-\d{2}-\d{2})$/.exec(it.lessonId);
      const times = it.evidence || [];
      const timeButton = (ev) =>
        '<button class="ev" data-play="' +
        esc(it.lessonId) +
        '" data-time="' +
        Number(ev.start) +
        '" title="回听这段原音">' +
        timestamp(ev.start) +
        "</button>";
      const history = (it.history || [])
        .map(
          (event) =>
            "<li>" +
            esc(
              [
                when(event.at),
                event.by,
                resultName(event.action),
                event.owner,
                event.note,
              ]
                .filter(Boolean)
                .join(" · "),
            ) +
            "</li>",
        )
        .join("");
      return `<article class="item2"><div class="sevc">${badge(it.priority)}<span class="ty">${esc(it.category)}</span></div>
      <div class="grow"><div class="t">${esc(it.title)}${it.historical ? ' <span class="badge sec pill">历史版本</span>' : ""}${times.length > 1 ? '<span class="badge sec pill">同一节课 ' + times.length + " 处</span>" : ""}</div>
      ${it.historical ? historicalEvidence(it) : detail ? '<div class="quotes spaced">' + times.map((e) => '<div class="qline">' + timeButton(e) + "<small>" + esc(e.speaker) + "</small><span>" + esc(e.text) + "</span></div>").join("") + "</div>" : times.length ? '<blockquote class="q">「' + esc(times[0].text) + "」</blockquote>" : ""}
      <div class="d">${esc([it.teacherName, it.course, when(it.startAt)].filter(Boolean).join(" · "))} ${detail || it.historical ? "" : times.map(timeButton).join(" ")}</div>
      ${(detail || it.historical) && it.check ? '<p class="sm">待核实 · ' + esc(it.check) + "</p>" : ""}
      ${it.state !== "open" ? '<div class="d">' + (it.historical ? historicalStatus(it) : esc([resultName(it.result), it.owner, it.note].filter(Boolean).join(" · "))) + "</div>" : ""}
      ${history ? '<details><summary>处理历史</summary><ul class="history">' + history + "</ul></details>" : ""}</div>
      <div class="acts">${it.state === "closed" || (it.historical && it.state !== "follow") ? "" : '<button class="btn sm" data-review="' + index + '">' + (it.state === "follow" ? "记录结果" : "复核") + "</button>"}
      ${detail ? (times.length && !it.historical ? '<button class="btn sm outline" data-play="' + esc(it.lessonId) + '" data-time="' + Math.max(0, Number(times[0].start) - 10) + '">从前 10 秒回听</button>' : "") : '<a class="btn sm outline" href="' + (missing ? "#/lessons?date=" + missing[1] : lessonLink(it.lessonId)) + '">' + (missing ? "查看当天课程" : "查看课程") + "</a>"}</div></article>`;
    })
    .join("");
}

export function inbox(data, state, page) {
  const labels = { open: "待复核", follow: "跟进中", closed: "已关闭" };
  const groups = state === "open" ? ["紧急", "重要", "一般"] : [""];
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    title("待处理", when(Date.now()).split(" ")[0]) +
    '<div class="tb"><div class="tabs">' +
    Object.entries(labels)
      .map(
        ([key, label]) =>
          '<a class="tab ' +
          (key === state ? "on" : "") +
          '" href="#/inbox?state=' +
          key +
          '">' +
          label +
          '<span class="n">' +
          Number(data.counts[key]) +
          "</span></a>",
      )
      .join("") +
    '</div></div><div class="card">' +
    (data.items.length
      ? groups
          .map((group) => {
            const items = data.items.filter(
              (row) => !group || row.priority === group,
            );
            if (!items.length) return "";
            return (
              (group ? '<div class="grp">' + group + "</div>" : "") +
              issueRows(items, false, data.items)
            );
          })
          .join("")
      : empty("暂无" + labels[state] + "事项")) +
    "</div>" +
    (pages > 1
      ? '<nav class="page-end" aria-label="事项分页">' +
        (page > 1
          ? '<a class="btn outline sm" href="#/inbox?state=' +
            state +
            "&amp;page=" +
            (page - 1) +
            '">上一页</a>'
          : "") +
        "<span>第 " +
        page +
        " / " +
        pages +
        " 页</span>" +
        (page < pages
          ? '<a class="btn outline sm" href="#/inbox?state=' +
            state +
            "&amp;page=" +
            (page + 1) +
            '">下一页</a>'
          : "") +
        "</nav>"
      : "")
  );
}

function lessonHeading(l) {
  return esc([l.course, l.student].filter(Boolean).join(" · ") || "未命名课程");
}
function lessonStatus(l) {
  return [l.recording, l.analysisStatus, l.pending ? "待复核 " + l.pending : ""]
    .filter(Boolean)
    .map((x) => badge(x))
    .join(" ");
}
function segmentBar(segments) {
  if (!segments?.length) return "";
  return (
    '<div class="timeline" aria-hidden="true">' +
    segments
      .map(
        (s) =>
          '<span data-kind="' +
          esc(s.kind) +
          '" title="' +
          esc(s.kind) +
          " · " +
          timestamp(s.start) +
          "–" +
          timestamp(s.end) +
          '" style="flex:' +
          Math.max(0, Number(s.end) - Number(s.start) || 0) +
          '"></span>',
      )
      .join("") +
    "</div>"
  );
}
function lessonCard(l) {
  const first = l.firstIssue;
  const ev = first?.evidence?.[0];
  return `<a class="lesson-card" href="${lessonLink(l.id)}">
  <span class="sm muted">${when(l.startAt)}${l.endAt ? " – " + when(l.endAt).split(" ").pop() : ""}</span>
  <strong>${lessonHeading(l)}</strong><span>${esc(l.teacherName)}</span><div>${lessonStatus(l)}</div>
  ${segmentBar(l.miniSegments)}
  ${first ? '<div class="lesson-snippet">' + badge(first.priority) + " " + esc(first.category) + "<br>" + esc(ev?.text || first.title) + (ev ? " · " + timestamp(ev.start) : "") + "</div>" : ""}
  ${l.metrics?.mode ? '<small class="muted">' + esc([l.metrics.mode, l.metrics.talkRatio != null ? "老师讲话 " + ratio(l.metrics.talkRatio) : "", l.metrics.questions != null ? "提问 " + l.metrics.questions + " 次" : ""].filter(Boolean).join(" · ")) + "</small>" : ""}</a>`;
}
function lessonTable(items) {
  return `<div class="tbl"><table><thead><tr><th>开课时间</th><th>课程 / 学员</th><th>老师</th><th>录音与分析</th></tr></thead><tbody>${items.map((l) => `<tr><td>${when(l.startAt)}</td><td><a class="ulink" href="${lessonLink(l.id)}">${lessonHeading(l)}</a></td><td>${esc(l.teacherName)}</td><td>${lessonStatus(l)}</td></tr>`).join("")}</tbody></table></div>`;
}
export function lessons(data, filters, view) {
  const { items, date } = data;
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  const monday = addDays(date, -(day + 6) % 7);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    const counts = data.weekCounts?.[d];
    return (
      '<button data-day="' +
      d +
      '"' +
      (d === date ? ' aria-current="date"' : "") +
      "><strong>周" +
      "一二三四五六日"[i] +
      "</strong><span>" +
      d.slice(5) +
      "</span>" +
      (counts
        ? "<small>" +
          Number(counts.analyzed) +
          "/" +
          Number(counts.total) +
          " 节" +
          (counts.pending ? " · " + Number(counts.pending) + " 节待处理" : "") +
          "</small>"
        : "") +
      "</button>"
    );
  }).join("");
  return (
    title(
      "课程",
      "",
      '<button class="btn outline" data-random ' +
        ">" +
        icon("shuffle") +
        "随机抽一节</button>",
    ) +
    `<form class="tb filters" id="filter-lessons"><input class="input" name="q" aria-label="搜索老师、课程或学员" placeholder="搜索老师、课程或学员" value="${esc(filters.get("q"))}">
      ${[
        ["grade", "年级", data.grades],
        ["subject", "学科", data.subjects],
      ]
        .map(
          ([name, label, options]) =>
            '<select class="input" name="' +
            name +
            '" aria-label="' +
            label +
            '"><option value="">全部' +
            label +
            "</option>" +
            Array.from(
              new Set([...(options || []), filters.get(name)].filter(Boolean)),
            )
              .map(
                (o) =>
                  '<option value="' +
                  esc(o) +
                  '" ' +
                  (filters.get(name) === o ? "selected" : "") +
                  ">" +
                  esc(o) +
                  "</option>",
              )
              .join("") +
            "</select>",
        )
        .join("")}
      <label><input type="checkbox" name="issues" ${filters.get("issues") === "1" ? "checked" : ""}> 只看疑似问题</label>
      <button class="btn sm outline">筛选</button>${["q", "grade", "subject", "issues"].some((k) => filters.get(k)) ? '<button type="button" class="btn ghost sm" data-reset>清除筛选</button>' : ""}</form>
    <div class="card"><div class="row wrap pad"><button class="btn sm outline" data-day="${dateAt(Date.now())}">今天</button>
    <button class="btn ghost sm" data-day="${addDays(date, -7)}" aria-label="上一周">‹</button><input class="input" type="date" data-date aria-label="选择课程日期" style="width:auto" value="${esc(date)}">
    <button class="btn ghost sm" data-day="${addDays(date, 7)}" aria-label="下一周">›</button><span class="grow"></span><div class="tabs">
    <button class="tab ${view === "cards" ? "on" : ""}" data-view="cards">卡片</button><button class="tab ${view === "table" ? "on" : ""}" data-view="table">课表</button></div></div><div class="week">${days}</div>
    <div class="pad"><div class="sm muted">${items.length} 节课程 · ${items.filter((l) => l.analysisStatus === "分析完成").length} 节已分析${data.scheduleAvailable ? "" : " · 当月暂无课表快照，仅列出录课记录"}</div><div class="spaced">
    ${items.length ? (view === "table" ? lessonTable(items) : '<div class="lesson-grid">' + items.map(lessonCard).join("") + "</div>") : empty("当天没有符合条件的课程")}</div></div></div>`
  );
}

export function lesson(l, issues) {
  const metrics = l.metrics || {},
    segments = l.segments || [];
  const btns =
    '<button class="btn outline" data-transcript ' +
    (l.hasTranscript || l.hasAudio ? "" : "disabled") +
    '>逐字稿与回听</button>';
  const cells = [
    ["待复核", l.pending],
    ["教学模式", metrics.mode],
    ["老师讲话占比", ratio(metrics.talkRatio)],
    [
      "老师提问",
      metrics.questions == null
        ? null
        : metrics.questions +
          " 次" +
          (metrics.openQuestions == null
            ? ""
            : " · 开放式 " + metrics.openQuestions),
    ],
    [
      "最长连续讲授",
      metrics.longestLectureSec == null
        ? null
        : timestamp(metrics.longestLectureSec),
    ],
  ];
  const timeline = segments.length
    ? segmentBar(segments) +
      '<div class="tbl"><table><thead><tr><th>录音时间</th><th>环节</th><th>说明</th></tr></thead><tbody>' +
      segments
        .map(
          (s) =>
            '<tr><td><button class="ev" data-play="' +
            esc(l.id) +
            '" data-time="' +
            Number(s.start) +
            '">' +
            timestamp(s.start) +
            "</button> – " +
            timestamp(s.end) +
            "</td><td>" +
            esc(s.kind) +
            "</td><td>" +
            esc([s.title, s.detail].filter(Boolean).join(" · ")) +
            "</td></tr>",
        )
        .join("") +
      "</tbody></table></div>"
    : '<span class="muted">暂无时间档案。</span>';
  const meta =
    "<span>" +
    when(l.startAt) +
    "</span>" +
    (l.recordingStart
      ? "<span>录音 " +
        when(l.recordingStart).split(" ").pop() +
        (l.recordingEnd ? "–" + when(l.recordingEnd).split(" ").pop() : "") +
        "</span>"
      : "") +
    '<a class="ulink" href="#/teacher/' +
    encodeURIComponent(l.teacherId) +
    '">' +
    esc(l.teacherName) +
    "</a>" +
    lessonStatus(l);
  return (
    title(
      [l.course, l.student].filter(Boolean).join(" · ") || "课程详情",
      meta,
      btns,
    ) +
    '<div class="stats auto">' +
    cells.map((x) => stat(...x)).join("") +
    "</div>" +
    (l.metrics
      ? '<p class="sm muted">教学指标由转写与时间档案估算。</p>'
      : "") +
    card(
      "疑似问题",
      issues.length
        ? issueRows(issues, true)
        : '<div class="muted">' +
            (l.analysisStatus === "分析完成"
              ? "本次分析未发现疑似问题。"
              : "当前分析状态 · " + esc(l.analysisStatus)) +
            "</div>",
    ) +
    card(
      "时间档案",
      (metrics.rt != null && metrics.ch != null
        ? '<p class="sm muted">S-T 教学模式估算 · Rt ' +
          Number(metrics.rt).toFixed(2) +
          " · Ch " +
          Number(metrics.ch).toFixed(2) +
          "</p>"
        : "") + timeline,
    )
  );
}

function ratio(v) {
  return v == null ? null : Math.round(Number(v) * 100) + "%";
}
export function teachers(data, pendingOnly) {
  const pendingTeachers = data.items.filter((t) => t.pending > 0),
    rows = pendingOnly ? pendingTeachers : data.items;
  return (
    title(
      "老师",
      esc(data.month),
      ' <button class="btn" data-add>添加老师</button>',
    ) +
    '<div class="tb"><div class="tabs"><a class="tab ' +
    (!pendingOnly ? "on" : "") +
    '" href="#/teachers">全部 ' +
    data.items.length +
    '</a><a class="tab ' +
    (pendingOnly ? "on" : "") +
    '" href="#/teachers?state=open">待复核 ' +
    pendingTeachers.length +
    "</a></div></div>" +
    `<div class="tbl"><table><thead><tr><th>老师</th><th>学科</th><th>任教班级</th><th class="num">${data.scheduleAvailable ? "本月课程数" : "本月有录音课程数"}</th><th>主要教学模式</th><th>疑似问题</th><th class="num" title="仅计入人工确认的老师问题">确定问题数</th><th aria-label="查看详情"></th></tr></thead><tbody>
    ${rows.map((t) => `<tr class="linked-row"><td><a class="row row-link" href="#/teacher/${encodeURIComponent(t.id)}"><span class="ava sm">${esc(t.name?.[0])}</span><strong>${esc(t.name)}</strong></a></td><td>${esc(t.subject) || "—"}</td><td>${esc([t.grade, ...(t.classes || [])].filter(Boolean).join(" · ")) || "—"}</td><td class="num">${esc(t.monthly ?? t.recordedMonthly)}</td><td>${esc(t.topMode) || "—"}</td><td>${t.pending ? badge("待复核 " + t.pending) : "—"}</td><td class="num">${Number(t.confirmed)}</td><td aria-hidden="true">${icon("chev")}</td></tr>`).join("") || '<tr><td colspan="8">' + empty("没有符合条件的老师") + "</td></tr>"}</tbody></table></div>`
  );
}
function teacherLessons(recent) {
  if (!recent.length) return empty("近两周暂无课程");
  const rows = recent.map(l => {
    const issue = l.firstIssue;
    const state = issue?.state === "open" ? "待复核" : issue?.state === "follow" ? "跟进中" : "已处理";
    const status = issue ? badge(issue.priority) + " " + esc(issue.category) + " · " + state
      : l.pending ? badge("待复核 " + l.pending) : !l.hasTranscript ? esc(l.recording) : "";
    return `<tr class="linked-row"><td>${esc(when(l.startAt).slice(5))}</td>
      <td><a class="row-link" href="${lessonLink(l.id)}">${esc(l.course || "查看课程")}</a>
      <div class="sm muted">${esc(l.student)}</div></td>
      <td>${segmentBar(l.miniSegments) || "—"}</td><td>${esc(l.metrics?.mode || "—")}</td><td>${status}</td></tr>`;
  });
  return `<div class="teacher-course-table" role="region" aria-label="近两周课程明细" tabindex="0"><table>
    <thead><tr>${["开课时间","课程 / 学员","时间档案","教学模式","问题状态"].map(h => "<th scope=\"col\">" + h + "</th>").join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;
}

export function teacher(t) {
  const modes = ["讲授型", "混合型", "对话型", "练习型"];
  const counts = modes.map(mode => Number(t.modes?.[mode] ?? 0));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const modeBars = modes.map((mode, i) => `<div class="mbar"><span>${mode}</span>
    <span class="mode-track" aria-hidden="true"><i style="width:${total ? 100 * counts[i] / total : 0}%"></i></span>
    <span class="num">${counts[i]}</span></div>`).join("");
  const issues = (t.issues || []).map(it => {
    const state = it.state === "open" ? "待复核" : it.state === "follow" ? "跟进中" : "已关闭";
    return `<a class="rec" href="${lessonLink(it.lessonId)}"><div class="row wrap">${badge(it.priority)}
      <strong>${esc(it.category)}</strong><span class="badge sec">${esc([resultName(it.result), state].filter(Boolean).join(" · "))}</span></div>
      <div class="spaced">${esc(it.title)}</div><small class="muted">${esc(when(it.startAt))}</small></a>`;
  }).join("");
  const meta = [t.subject,t.grade,...(t.classes || [])].filter(Boolean).join(" · ");
  const coverage = t.coverage;
  return `<div class="pgh teacher-heading"><span class="ava teacher-avatar" aria-hidden="true">${esc(t.name?.[0])}</span>
    <div><h1>${esc(t.name)}</h1><div class="meta">${esc(meta)}</div></div><span class="grow"></span>
    <button class="btn" data-random>${icon("shuffle")}抽一节课</button></div>
    <div class="stats teacher-stats"><div><small>本学期有录音</small><b>${esc(coverage?.recorded ?? "—")}
    <em>${coverage?.total != null ? "/ " + esc(coverage.total) + " 节" : "节"}</em></b>
    ${coverage?.total == null ? '<small>学期课表未齐，总数待补</small>' : ""}</div>
    ${stat("主要教学模式",t.topMode)}${stat("老师讲话中位数",ratio(t.medianTalkRatio))}
    <div><small>疑似问题</small><b>待复核 ${Number(t.pending)} <em>· 已确认 ${Number(t.confirmed)}</em></b></div></div>
    <div class="teacher-columns"><section class="card"><div class="card-h"><h3>近两周课程</h3></div>${teacherLessons(t.recentLessons || [])}</section>
    <aside>${card("教学模式分布",modeBars + (total ? "" : '<small class="muted">暂无可分析的课程</small>'))}
    ${card("问题记录",issues || '<span class="muted">暂无问题记录。</span>')}</aside></div>`;
}
