import { card, dateAt, empty, esc, icon, lessonLink } from "./ui.js";
import {
  inbox,
  issueRows,
  lesson,
  lessons,
  teacher,
  teachers,
} from "./views.js";
import { closeForm, reviewForm, teacherForm } from "./forms.js";
import { openPlayer, stopPlayer } from "./player.js";

const root = document.getElementById("root"),
  notice = document.getElementById("notice");
const apiBase = "/classroom-api/fupan";
const navigation = [
  ["inbox", "待处理", "inbox"],
  ["lessons", "课程", "cal"],
  ["teachers", "老师", "users"],
];
let lessonSearch = "",
  actor = null,
  epoch = 0,
  pageContext = {},
  openCount = null,
  teacherCount = null;
let requests = new AbortController(),
  noticeTimeout;
const deniedAtLogin = location.hash === "#denied";
if (location.hash.startsWith("#token=") || deniedAtLogin)
  history.replaceState(null, "", location.pathname);

function access(message = "", retry = false) {
  document.title = "课堂复盘 · 菁仕教育";
  root.innerHTML = `<main class="access card" id="main" tabindex="-1"><span class="logo" aria-hidden="true">菁</span><h1>课堂复盘</h1>
    <p>${esc(message || "仅指定教学主管可查看。")}</p>${retry ? '<button class="btn" data-retry>重新连接</button>' : '<a class="btn" href="' + apiBase + '/login">用飞书登录</a>'}</main>`;
}
function exit(message = "") {
  epoch++;
  requests.abort();
  requests = new AbortController();
  actor = null;
  pageContext = {};
  lessonSearch = "";
  openCount = null;
  teacherCount = null;
  stopPlayer();
  closeForm();
  notice.replaceChildren();
  history.replaceState(null, "", location.pathname + location.search);
  access(message);
}
async function api(path, params, body) {
  const session = requests;
  const url = new URL(apiBase + path, location.origin);
  if (params) url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "X-Fupan-Request": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    signal: session.signal,
  });
  if (session !== requests) throw Error("登录已变更。");
  if (response.status === 401 || response.status === 403) {
    const reason =
      response.status === 403
        ? "当前飞书账号没有课堂复盘权限。"
        : actor
          ? "登录已过期，请重新用飞书登录。"
          : "仅指定教学主管可查看。";
    exit(reason);
    throw Error(reason);
  }
  const data = await response.json().catch(() => null);
  if (session !== requests) throw Error("登录已变更。");
  if (!response.ok || data === null)
    throw Object.assign(
      Error(
        response.status === 409
          ? data?.message || "记录已变更。关闭弹窗并刷新后再试。"
          : data?.message || "请求未完成，请重试。",
      ),
      { status: response.status },
    );
  return data;
}
function notify(message) {
  clearTimeout(noticeTimeout);
  notice.innerHTML = "<span>" + esc(message) + "</span>";
  notice.className = "notice-on";
  noticeTimeout = setTimeout(() => notice.replaceChildren(), 3500);
}
function locationRoute() {
  const [path = "", search = ""] = location.hash
    .replace(/^#\/?/, "")
    .split("?");
  const [name = "inbox", id = ""] = path.split("/");
  let decoded;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    decoded = "";
  }
  return {
    page: name || "inbox",
    id: decoded,
    filters: new URLSearchParams(search),
  };
}
function shell(section, heading, body) {
  const nav = (mobile) =>
    navigation
      .map(([key, label, symbol]) => {
        const count =
          key === "inbox"
            ? openCount
            : key === "teachers"
              ? teacherCount
              : null;
        return (
          '<a class="' +
          (mobile ? "tab" : "sb-btn") +
          (section === key ? " on" : "") +
          '" ' +
          (section === key ? 'aria-current="page"' : "") +
          ' href="#/' +
          key +
          '">' +
          (mobile ? "" : icon(symbol)) +
          label +
          (count == null
            ? ""
            : '<span class="cnt">' + Number(count) + "</span>") +
          "</a>"
        );
      })
      .join("");
  const label = navigation.find((x) => x[0] === section)?.[1] || "课堂复盘";
  const crumb = heading
    ? '<a href="#/' +
      section +
      '">' +
      label +
      "</a>" +
      icon("chev") +
      "<b>" +
      esc(heading) +
      "</b>"
    : "<b>" + label + "</b>";
  return `<div class="app"><aside class="sidebar"><div class="sb-h"><div class="sb-btn lg"><span class="logo">菁</span><span class="tx"><b>菁仕教育</b><span>课堂复盘</span></span></div></div>
    <nav aria-label="主导航" class="sb-c"><div class="sb-group">${nav(false)}</div></nav><div class="sb-f"><div class="sb-btn lg"><span class="ava">${esc(actor.name?.[0])}</span>
    <span class="tx"><b>${esc(actor.name)}</b><span>教学主管</span></span><button class="btn sm ghost" data-logout>退出</button></div></div></aside>
    <div class="inset"><header class="header"><nav class="bc" aria-label="面包屑">${crumb}</nav></header><div class="mtop"><nav class="bc" aria-label="当前位置">${crumb}</nav><button class="btn sm ghost mobile-logout" data-logout>退出</button></div>
    <nav class="mnav" aria-label="移动端主导航">${nav(true)}</nav><main id="main" tabindex="-1" class="main">${body}</main></div></div>`;
}
async function render() {
  if (!actor) return;
  const task = ++epoch,
    { page, id, filters } = locationRoute();
  const section =
    page === "lesson" ? "lessons" : page === "teacher" ? "teachers" : page;
  stopPlayer();
  closeForm();
  pageContext = {};
  root.innerHTML = shell(
    section,
    "",
    '<div class="empty" role="status">正在读取…</div>',
  );
  let body = "",
    heading = "",
    ctx = {};
  try {
    switch (page) {
      case "inbox": {
        const state = ["follow", "closed"].includes(filters.get("state"))
          ? filters.get("state")
          : "open";
        const index = Math.max(1, parseInt(filters.get("page"), 10) || 1);
        const data = await api("/inbox", { state, page: index });
        if (task !== epoch) return;
        if (!data.items.length && index > 1) {
          location.replace(
            "#/inbox?state=" +
              state +
              "&page=" +
              Math.max(1, Math.ceil(data.total / data.pageSize)),
          );
          return;
        }
        openCount = data.counts.open;
        ctx.issues = data.items;
        body = inbox(data, state, index);
        break;
      }
      case "lessons": {
        const date = filters.get("date") || dateAt(Date.now());
        const query = { date };
        filters.delete("q");
        if (lessonSearch) filters.set("q", lessonSearch);
        for (const key of ["q", "teacherId", "grade", "subject", "issues"])
          if (filters.get(key)) query[key] = filters.get(key);
        const data = lessonSearch
          ? await api("/lessons/search", null, query)
          : await api("/lessons", query);
        body = lessons(
          data,
          filters,
          filters.get("view") === "table" ? "table" : "cards",
        );
        break;
      }
      case "lesson": {
        const data = await api("/lesson", { id });
        const issues = data.reviewable === false ? { items: [] } : await api("/issues", { lessonId: id });
        heading = "课程详情";
        ctx.lesson = data;
        const previous = (issues.previousItems || []).map((it) => ({
          ...it,
          historical: true,
        }));
        ctx.issues = [...issues.items, ...previous];
        body =
          lesson(data, issues.items) +
          (previous.length
            ? card("历史版本的复核记录", issueRows(previous, true, ctx.issues))
            : "");
        break;
      }
      case "teachers": {
        const data = await api("/teachers");
        if (task !== epoch) return;
        teacherCount = data.items.length;
        body = teachers(data, filters.get("state") === "open");
        break;
      }
      case "teacher": {
        const data = await api("/teacher", { id });
        heading = data.name;
        ctx.teacherId = data.id;
        body = teacher(data);
        break;
      }
      default:
        body =
          empty("找不到这个页面") +
          '<a class="btn outline" href="#/inbox">返回待处理</a>';
    }
    if (task !== epoch) return;
    pageContext = ctx;
    root.innerHTML = shell(section, heading, body);
    document.title =
      ((page === "teacher" ? "老师详情" : heading) ||
        navigation.find((n) => n[0] === page)?.[1] ||
        "页面") + " · 课堂复盘";
  } catch (err) {
    if (task !== epoch || !actor) return;
    root.innerHTML = shell(
      section,
      heading,
      empty(err.message) +
        '<button class="btn outline" data-retry>重新读取</button>',
    );
  }
}
async function boot() {
  if (deniedAtLogin) {
    access("当前飞书账号没有课堂复盘权限。");
    return;
  }
  const before = epoch;
  try {
    const me = await api("/me");
    if (epoch !== before) return;
    actor = me;
    await render();
  } catch (err) {
    if (epoch === before) access("暂时无法连接课堂复盘。", true);
  }
}
function refresh(message) {
  if (!actor) return;
  notify(message);
  render();
}
function changeLessonFilters(changes) {
  const { filters } = locationRoute();
  filters.delete("q");
  for (const [key, value] of Object.entries(changes)) {
    if (key === "q") {
      lessonSearch = value || "";
      continue;
    }
    if (value) filters.set(key, value);
    else filters.delete(key);
  }
  const url = "#/lessons?" + filters.toString();
  if (location.hash === url) render();
  else location.hash = url;
}
const play = (id, time, start = true) =>
  openPlayer(
    api,
    id,
    time,
    start,
    pageContext.lesson,
    (pageContext.issues || []).filter(
      (i) => !i.historical && i.lessonId === id,
    ),
  );
root.addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  const attrs = button.dataset;
  if ("logout" in attrs) {
    exit();
    root.innerHTML = '<main class="card access" id="main">正在退出…</main>';
    const logoutEpoch = epoch;
    try {
      await api("/logout", null, {});
      if (logoutEpoch === epoch) access();
    } catch {
      if (logoutEpoch === epoch)
        root.innerHTML =
          '<main class="card access" id="main"><h1>退出未完成</h1><p>连接恢复后请重试。</p><button class="btn" data-logout>重试退出</button></main>';
    }
    return;
  }
  if ("retry" in attrs) {
    if (actor) render();
    else boot();
    return;
  }
  if (!actor) return;
  if ("review" in attrs) {
    const item = pageContext.issues?.[Number(attrs.review)];
    if (item) reviewForm(item, api, refresh, play);
  }
  if ("play" in attrs) play(attrs.play, Number(attrs.time));
  if ("transcript" in attrs && pageContext.lesson)
    play(pageContext.lesson.id, 0, false);
  if ("add" in attrs) teacherForm(api, refresh);
  if ("random" in attrs) {
    const turn = epoch;
    button.disabled = true;
    try {
      const { id } = await api(
        "/random",
        pageContext.teacherId ? { teacherId: pageContext.teacherId } : {},
      );
      if (turn !== epoch) return;
      if (id) location.hash = lessonLink(id);
      else notify("当前范围暂无可抽听的录音。");
    } catch (err) {
      if (turn === epoch) notify(err.message);
    } finally {
      button.disabled = false;
    }
  }
  if ("day" in attrs) changeLessonFilters({ date: attrs.day });
  if ("view" in attrs) changeLessonFilters({ view: attrs.view });
  if ("reset" in attrs)
    changeLessonFilters({ q: null, grade: null, subject: null, issues: null });
});
root.addEventListener("submit", (e) => {
  if (e.target.id !== "filter-lessons") return;
  e.preventDefault();
  const data = new FormData(e.target);
  changeLessonFilters({
    q: data.get("q").trim(),
    grade: data.get("grade").trim(),
    subject: data.get("subject").trim(),
    issues: data.has("issues") ? "1" : null,
  });
});
root.addEventListener("change", (e) => {
  if (e.target.matches("[data-date]") && e.target.value)
    changeLessonFilters({ date: e.target.value });
});
document.querySelector(".skip").onclick = (e) => {
  e.preventDefault();
  document.getElementById("main")?.focus();
};
window.addEventListener("hashchange", () => {
  if (actor) render();
});
window.addEventListener("pagehide", () => {
  epoch++;
  requests.abort();
  requests = new AbortController();
  actor = null;
  pageContext = {};
  lessonSearch = "";
  openCount = null;
  teacherCount = null;
  stopPlayer();
  closeForm();
  notice.replaceChildren();
  root.replaceChildren();
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) boot();
});
boot();
