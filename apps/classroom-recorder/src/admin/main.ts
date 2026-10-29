/**
 * 菁仕课堂后台（/classroom/admin/）：
 * - 课程：录音、转写、家长总结、学情报告（报告直接嵌线上 report.html）
 * - 提示词：草稿只存在本机浏览器，试生成时草稿和线上各跑一次对比；「应用到全部老师」才写入新版本
 * 接口：classroom-api 的 /admin/*，飞书登录后 token 放 localStorage。
 */
import './styles.css';

type Stage = 'recording' | 'queued' | 'transcribing' | 'summarizing' | 'done' | 'failed' | 'empty';
/** 课堂时间档案（logic.ts Archive）；时间是录音里的秒 */
interface Stats { first: number; last: number; learn: number; brk: number; chat: number; share: number }
interface Archive {
  segments: Array<{ start: number; end: number; kind: string; title: string; detail: string }>; moments: unknown[]; stats: Stats;
  /** 合并反馈的各节：秒数 t 的真实时刻 = clock0 + t × 1000 */
  parts?: Array<{ lessonId: string; start: number; end: number; clock0: number; plan: number }>;
}
interface Row { _id: string; student: string; course: string; kind?: 'lesson' | 'adhoc' | 'meeting' | 'merged'; teacherName: string; startAt: number; endAt: number; audioSec?: number | null; stage: Stage; attempts: number; promptVersion: number | null; stats?: Stats | null }
interface Detail extends Row {
  error?: string; transcript?: string; transcriptEdited?: boolean; summary?: string; editedSummary?: string;
  mins: number; gapMinutes?: number; fileName: string; audioUrl: string | null; audioDeletedAt?: number | null; reportUrl: string | null;
  archive?: Archive | null; recStart: number;
  /** 合并反馈由哪几节合并 */
  sourceLessons?: Array<{ _id: string; startAt: number; endAt: number }>;
}
interface Prompts { rules: string; parent: string; report: string; meeting: string }
interface Version extends Prompts { version: number; createdAt: number; createdBy: string }
interface Result { parentSummary: string; reportData: unknown }
interface Out { busy?: string; error?: string; label?: string; at?: number; meeting?: boolean; draft?: Result | string; live?: Result | string }

const API = '/classroom-api';
const TOKEN_KEY = 'classroom-admin-token';
const DRAFT_KEY = 'classroom-admin-draft';
const KEYS = ['parent', 'report', 'rules', 'meeting'] as const;
const KEY_NAMES: Record<keyof Prompts, string> = { parent: '家长总结', report: '学情报告', rules: '通用规则', meeting: '会议纪要' };
const UPLOAD_CHUNK = 1_000_000;

const ICON = {
  lessons: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  prompts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m7 10 5 5 5-5"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
};

const app = document.getElementById('app')!;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const store = {
  get: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 隐私模式：草稿不保留 */ } },
  del: (key: string) => { try { localStorage.removeItem(key); } catch { /* 同上 */ } },
};
const dateFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const when = (ms: number) => {
  const p = Object.fromEntries(dateFmt.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const vname = (v: Version) => (v.version ? `v${v.version}` : '默认');

function toast(message: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}
async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}`);
  } catch {
    toast('复制失败，请手动选择文本');
  }
}

// ---------- 登录与接口 ----------

const hashToken = location.hash.match(/^#token=([\w-]+)$/)?.[1];
if (hashToken) {
  store.set(TOKEN_KEY, hashToken);
  history.replaceState(null, '', location.pathname); // 地址栏只留 /classroom/admin/
}
let token = store.get(TOKEN_KEY) ?? hashToken ?? '';

function showLogin() {
  app.innerHTML = `<div class="login"><div class="card">
    <div class="brand" style="padding:0"><div class="logo">菁</div>菁仕课堂后台</div>
    <p class="muted" style="margin:0">老师登录后看自己的课程和会议，可以改转写和报告</p>
    <a class="btn pri" href="${API}/admin/login">用飞书登录</a></div></div>`;
}
function logout() {
  token = '';
  try { sessionStorage.removeItem('classroom-admin-view'); } catch { /* 同上 */ }
  store.del(TOKEN_KEY);
  showLogin();
}

async function api<T = any>(path: string, init: RequestInit = {}, asSelf = false): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) };
  if (viewAs && !asSelf) headers['x-view-as'] = viewAs.openId;
  if (typeof init.body === 'string') headers['content-type'] = 'application/json';
  const response = await fetch(API + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    logout();
    throw new Error('登录已失效，请重新登录');
  }
  if (!response.ok) throw new Error(body.message || `请求失败（${response.status}）`);
  return body as T;
}
const post = <T = any>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });

let main: HTMLElement;
/** 超级管理员看全部、管提示词和管理员；老师只看自己的。超级管理员可以切到某位老师的视角，这时界面和权限都按老师来 */
let isAdmin = false;
let realAdmin = false;
let myName = '';
let viewAs: { openId: string; name: string } | null = (() => {
  try { return JSON.parse(sessionStorage.getItem('classroom-admin-view') ?? 'null'); } catch { return null; }
})();
let teacherList: { openId: string; name: string }[] = [];

function setView(next: typeof viewAs) {
  viewAs = next;
  try { if (next) sessionStorage.setItem('classroom-admin-view', JSON.stringify(next)); else sessionStorage.removeItem('classroom-admin-view'); } catch { /* 隐私模式：只在这一页有效 */ }
  isAdmin = realAdmin && !viewAs;
  Object.assign(list, { rows: [], q: '', stage: '', kind: '', teacher: '', student: '', people: null });
  shell(myName);
  if (location.hash.replace(/^#\/?/, '') && location.hash !== '#/lessons') history.replaceState(null, '', location.pathname);
  route();
}

function shell(name: string) {
  app.innerHTML = `<div class="app">
    <aside>
      <div class="brand"><div class="logo">菁</div><span>菁仕课堂后台</span></div>
      <a class="nav" href="#/lessons" data-nav="lessons">${ICON.lessons}课程</a>
      ${isAdmin ? `<a class="nav" href="#/prompts" data-nav="prompts">${ICON.prompts}提示词</a>
      <a class="nav" href="#/admins" data-nav="admins">${ICON.people}管理员</a>` : ''}
      ${realAdmin ? `<label class="view">查看视角<select id="viewAs">
        <option value="">全部老师（超级管理员）</option>
        ${teacherList.map((t) => `<option value="${esc(t.openId)}" ${viewAs?.openId === t.openId ? 'selected' : ''}>${esc(t.name)} 的视角</option>`).join('')}</select></label>` : ''}
      <div class="me"><span>${esc(name)}<small>${realAdmin ? '超级管理员' : '老师'}</small></span><button id="logout">退出</button></div>
    </aside>
    <main id="main"></main></div>`;
  main = $('#main');
}

function route() {
  let [, page = 'lessons', id] = location.hash.match(/^#\/(lessons|prompts|admins)(?:\/(rec\w+|adhoc-[0-9a-f]{16}|merged-[0-9a-f]{16}))?/) ?? [];
  if (!isAdmin && page !== 'lessons') page = 'lessons';
  document.querySelectorAll('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', false));
  document.querySelector(`[data-nav="${page}"]`)?.setAttribute('aria-current', 'page');
  const run = (page === 'prompts' ? showPrompts() : page === 'admins' ? showAdmins() : id ? showLesson(id) : showLessons())
    .then(() => { if (viewAs) main.insertAdjacentHTML('afterbegin', `<div class="viewas">正在以 <b>${esc(viewAs.name)}</b> 的视角查看，看到和能改的都和这位老师一样<button class="btn sm" id="viewExit">回到超级管理员</button></div>`); });
  run.catch((error: Error) => { if (token) main.innerHTML = `<div class="card empty err">${esc(error.message)}</div>`; });
}

// ---------- 课程列表 ----------

/** 表头筛选：空字符串 = 全部 */
const list = { rows: [] as Row[], q: '', stage: '', kind: '', teacher: '', student: '', people: null as { teacherName: string; student: string }[] | null, more: false, seq: 0 };
type FilterKey = 'stage' | 'kind' | 'teacher' | 'student';
const FILTER_KEYS: FilterKey[] = ['teacher', 'student', 'kind', 'stage'];
const STAGES = [['done', '已完成'], ['processing', '转写中'], ['recording', '录制中'], ['failed', '失败'], ['empty', '未计入']];
const KINDS = [['lesson', '课程'], ['meeting', '会议'], ['merged', '合并反馈']];

function status(row: Row): [string, string] {
  if (row.stage === 'done') return ['已完成', 'b-ok'];
  if (row.stage === 'recording') return ['录制中', 'b-warn'];
  if (row.stage === 'empty') return ['未计入', 'b-plain'];
  if (row.stage === 'failed') return row.attempts >= 3 ? ['失败', 'b-bad'] : ['重试中', 'b-warn'];
  return [row.stage === 'summarizing' ? '生成中' : '转写中', 'b-info'];
}
const badge = (row: Row) => {
  const [text, cls] = status(row);
  return `<span class="badge ${cls}"><i></i>${text}</span>`;
};
/** 有课堂时间档案：实际上课（第一句到最后一句）；否则实际录到的时长，合并录音前还不知道 */
const duration = (r: Row) => (r.stats ? `${Math.round((r.kind === 'merged' ? r.stats.learn + r.stats.brk + r.stats.chat : r.stats.last - r.stats.first) / 60)} 分钟` // 合并反馈不算两节之间
  : r.audioSec == null ? '—' : r.audioSec < 60 ? `${r.audioSec || '&lt;1'} 秒` : `${Math.round(r.audioSec / 60)} 分钟`);
/** 学习时间占上课时间（不含课间）；不到 70% 标黄：家长报告不显示「比计划多」，时长只算学习时间 */
const LEARN_SHARE = 0.7;
const share = (r: Row) => (r.stats ? `<span class="badge ${r.stats.share < LEARN_SHARE ? 'b-warn' : 'b-plain'}">${Math.round(r.stats.share * 100)}%</span>` : '<span class="muted">—</span>');

async function loadLessons(append = false) {
  const seq = ++list.seq;
  const params = new URLSearchParams();
  if (list.q) params.set('q', list.q);
  for (const key of FILTER_KEYS) if (list[key]) params.set(key, list[key]);
  if (append && list.rows.length) params.set('before', String(list.rows.at(-1)!.startAt));
  const { lessons } = await api<{ lessons: Row[] }>(`/admin/lessons?${params}`);
  if (seq !== list.seq) return; // 搜索框连续输入：只认最后一次
  list.rows = append ? list.rows.concat(lessons) : lessons;
  list.more = lessons.length === 50;
  const rows = $('#rows');
  if (!rows) return;
  rows.innerHTML = list.rows.map((r) => `<tr data-id="${esc(r._id)}">
      <td class="mono">${when(r.startAt)}</td><td class="who">${esc(r.student || '—')}</td><td>${esc(r.course)}${kindTag(r)}</td>
      <td>${r.kind === 'meeting' ? '会议' : r.kind === 'merged' ? '合并反馈' : '课程'}</td>${isAdmin ? `<td>${esc(r.teacherName)}</td>` : ''}<td class="mono muted">${duration(r)}</td><td class="mono">${share(r)}</td><td>${badge(r)}</td></tr>`).join('')
    || `<tr><td colspan="${isAdmin ? 8 : 7}" class="empty">${list.q || FILTER_KEYS.some((key) => list[key]) ? '没有符合条件的课程' : '还没有录过课'}</td></tr>`;
  $('#more').hidden = !list.more;
}

/** 表头里的筛选：原生下拉盖在列名上，选中后列名换成选中的值 */
function filterTh(key: FilterKey, label: string, options: string[][]) {
  const value = list[key];
  const shown = options.find(([v]) => v === value)?.[1] ?? value;
  return `<th><label class="thf${value ? ' on' : ''}"><span>${esc(value ? shown : label)}</span>${ICON.chev}
    <select data-filter="${key}" aria-label="筛选${label}"><option value="">全部${label}</option>
    ${options.map(([v, t]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label></th>`;
}

function renderHead() {
  const people = list.people ?? [];
  const uniq = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((v) => [v, v]);
  const teachers = uniq(people.map((p) => p.teacherName).concat(list.teacher));
  // 选了老师就只列这位老师的学生
  const students = uniq(people.filter((p) => !list.teacher || p.teacherName === list.teacher).map((p) => p.student).concat(list.student));
  $('#thead').innerHTML = `<tr><th>上课时间</th>${filterTh('student', '学生', students)}<th>课程</th>${filterTh('kind', '类型', KINDS)}
    ${isAdmin ? filterTh('teacher', '老师', teachers) : ''}<th>时长</th><th title="学习时间占上课时间（不含课间）">学习占比</th>${filterTh('stage', '状态', STAGES)}</tr>`;
}

async function showLessons() {
  main.innerHTML = `
    <div class="head"><h1>课程</h1>
      <label class="input search" for="q">${ICON.search}<input id="q" placeholder="${isAdmin ? '学生、课程或老师' : '学生或课程'}" value="${esc(list.q)}" autocomplete="off"></label>
    </div>
    <div class="card tablewrap"><table>
      <thead id="thead"></thead>
      <tbody id="rows"><tr><td colspan="${isAdmin ? 8 : 7}" class="empty"><span class="spin"></span></td></tr></tbody></table></div>
    <div class="more" id="more" hidden><button class="btn" id="loadMore">加载更多</button></div>`;
  renderHead();
  if (!list.people) {
    api<{ people: { teacherName: string; student: string }[] }>('/admin/people')
      .then(({ people }) => { list.people = people; if ($('#thead')) renderHead(); })
      .catch(() => { /* 候选项拿不到不影响列表，下拉里只剩「全部」 */ });
  }
  await loadLessons();
}

/** 随时录制的标记；课表里的课不标 */
const kindTag = (r: Row) => (r.kind === 'meeting' ? ' <span class="badge">会议</span>' : r.kind === 'adhoc' ? ' <span class="badge">随时录制</span>' : r.kind === 'merged' ? ' <span class="badge">合并反馈</span>' : '');

// ---------- 课程详情 ----------

let detail: Detail | null = null;
let detailTab = 'transcript';
/** 「[说话人 mm:ss-mm:ss] 文本」；说话人在后台可以改成任意名字（不含空格和方括号） */
const LINE = /^\[(.+?) ((\d+):(\d{2})-\d+:\d{2})\] (.*)$/;
const speakerClass = (who: string, names: string[]) =>
  who === '老师' ? 's1' : who === '学生' ? 's2' : /^说话人\d+$/.test(who) ? `s${who.slice(3)}` : `s${(names.indexOf(who) % 3) + 1}`;

/** 转写编辑：按行拆开，who 为空的是对不上格式的原样行 */
interface TLine { who: string; time: string; at: number; text: string }
let ed: { id: string; lines: TLine[]; undo: TLine[][]; dirty: boolean } | null = null;
/** 家长总结 / 会议纪要编辑：整段文字，同样支持划词全部替换 */
let sed: { id: string; text: string; undo: string[]; dirty: boolean } | null = null;
const parseLines = (t: string): TLine[] => t.split('\n').map((line) => {
  const m = line.match(LINE);
  return m ? { who: m[1], time: m[2], at: Number(m[3]) * 60 + Number(m[4]), text: m[5] } : { who: '', time: '', at: 0, text: line };
});
const joinLines = (lines: TLine[]) => lines.map((l) => (l.who ? `[${l.who} ${l.time}] ${l.text}` : l.text)).join('\n');
const speakerNames = (lines: TLine[]) => [...new Set(lines.map((l) => l.who).filter(Boolean))];

async function showLesson(id: string) {
  main.innerHTML = `<div class="crumb"><a href="#/lessons">课程</a></div><div class="empty"><span class="spin"></span></div>`;
  if (ed?.id !== id) ed = null;
  if (sed?.id !== id) sed = null;
  const d = (detail = await api<Detail>(`/admin/lessons/${id}`));
  const done = d.stage === 'done';
  if (!d.transcript && detailTab === 'transcript' && done) detailTab = 'summary';
  if (!done && detailTab !== 'transcript') detailTab = 'transcript';
  const pending =
    d.stage === 'failed' ? `<div class="card panel" style="margin-bottom:16px"><div class="row" style="justify-content:space-between">
        <span class="err">${esc(d.error || '处理失败')}</span><button class="btn sm" id="retry">重新处理</button></div></div>`
    : d.stage === 'recording' ? '<div class="card empty">正在上课录制，下课后自动转写</div>'
    : d.stage === 'empty' ? '<div class="card empty">录音不到 5 分钟、几乎没人说话，不算录制，没有生成总结</div>'
    : !done && d.kind === 'merged' ? '<div class="card empty">正在生成合并反馈，通常 15 秒左右</div>'
    : !done && !d.transcript ? '<div class="card empty">正在转写，通常下课后几分钟内完成</div>'
    : '';
  const tabs = [['transcript', '转写', Boolean(d.transcript)], ['summary', d.kind === 'meeting' ? '会议纪要' : '家长总结', done], ['report', d.kind === 'meeting' ? '纪要网页' : '学情报告', done && Boolean(d.reportUrl)], ['archive', '时间档案', done && Boolean(d.archive)]]
    .filter(([, , show]) => show);
  main.innerHTML = `
    <div class="crumb"><a href="#/lessons">课程</a><span>/</span><span>${esc(d.student || d.course)}</span></div>
    <div class="head"><div><h1>${esc([d.student, d.course].filter(Boolean).join(' · '))}${kindTag(d)}</h1>
      <div class="muted" style="margin-top:4px">${esc(d.teacherName)} · ${when(d.startAt)}${d.promptVersion != null && done ? ` · 提示词 ${d.promptVersion ? `v${d.promptVersion}` : '默认'}` : ''}${d.gapMinutes ? ` · 录音缺失约 ${d.gapMinutes} 分钟` : ''}</div>
      ${d.sourceLessons ? `<div class="muted" style="margin-top:4px">由 ${d.sourceLessons.length} 节合并：${d.sourceLessons.map((l) => `<a href="#/lessons/${esc(l._id)}">${when(l.startAt)}</a>`).join('、')}，单节课的总结和报告都保留</div>` : ''}</div>
      ${badge(d)}</div>
    ${d.audioUrl ? `<div class="card player"><audio id="audio" controls preload="metadata" src="${esc(d.audioUrl)}"></audio>
      <a class="btn sm" href="${esc(`${d.audioUrl}&download=${encodeURIComponent(`${d.fileName}.mp3`)}`)}">${ICON.dl}MP3</a></div>`
      : d.audioDeletedAt ? '<div class="card empty" style="margin-bottom:16px">录音已超过 30 天自动删除，转写和总结仍保留</div>' : ''}
    ${pending}
    ${tabs.length ? `<div class="row" style="justify-content:space-between;margin-bottom:12px">
      <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${detailTab === k}">${t}</button>`).join('')}</div>
      <div class="row" id="tabact"></div></div><div id="tabbody"></div>` : ''}`;
  $('#audio')?.addEventListener('timeupdate', highlight);
  if (tabs.length) renderTab();
}

function renderTab() {
  const d = detail!;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === detailTab)));
  if (detailTab === 'transcript' && ed) {
    $('#tabact').innerHTML = `<span class="muted edhint">选中文字可全部替换，点说话人可改名</span>
      ${ed.undo.length ? '<button class="btn sm ghost" id="edUndo">撤销</button>' : ''}<button class="btn sm" id="edCancel">取消</button>
      <button class="btn sm pri" id="edSave" ${ed.dirty ? '' : 'disabled'}>保存</button>`;
    const names = speakerNames(ed.lines);
    const box = document.querySelector('#tabbody .lines');
    const top = box?.scrollTop ?? 0;
    $('#tabbody').innerHTML = `<div class="card panel"><div class="lines editing">${ed.lines.map((l, i) => `<div class="line" data-i="${i}">${l.who
      ? `<button class="t mono" data-at="${l.at}" title="从这里播放">${mmss(l.at)}</button><button class="s ${speakerClass(l.who, names)}" data-who="${i}" title="改名">${esc(l.who)}</button>`
      : '<span></span><span></span>'}<span class="tx" contenteditable="plaintext-only" spellcheck="false">${esc(l.text)}</span></div>`).join('')}</div></div>`;
    document.querySelector('#tabbody .lines')!.scrollTop = top;
    highlight();
  } else if (detailTab === 'transcript') {
    $('#tabact').innerHTML = `${d.transcriptEdited ? '<span class="badge">改过</span>' : ''}<button class="btn sm" id="edStart">编辑</button><button class="btn sm" id="dltxt">${ICON.dl}下载转写</button>`;
    const lines = parseLines(d.transcript ?? '');
    const names = speakerNames(lines);
    $('#tabbody').innerHTML = `<div class="card panel"><div class="lines">${lines.map((l) => l.who
      ? `<button class="line" data-at="${l.at}"><span class="t mono">${mmss(l.at)}</span><span class="s ${speakerClass(l.who, names)}">${esc(l.who)}</span><span>${esc(l.text)}</span></button>`
      : `<div class="line" style="cursor:default"><span></span><span></span><span>${esc(l.text)}</span></div>`).join('')}</div></div>`;
    highlight();
  } else if (detailTab === 'summary') {
    // 总结本身就是可编辑的文字：直接改、选中即可全部替换，停手 1 秒自动保存（和 App 一样）
    if (sed?.id !== d._id) sed = { id: d._id, text: d.editedSummary || d.summary || '', undo: [], dirty: false };
    $('#tabact').innerHTML = `<span class="muted edhint" id="sumState">${d.editedSummary ? '老师改过 · ' : ''}直接修改，选中文字可全部替换</span>
      ${sed.undo.length ? '<button class="btn sm ghost" id="sumUndo">撤销替换</button>' : ''}<button class="btn sm" id="copySummary">${ICON.copy}复制</button>`;
    $('#tabbody').innerHTML = `<div class="card panel"><div class="summary sumed" contenteditable="plaintext-only" spellcheck="false" aria-label="${d.kind === 'meeting' ? '会议纪要' : '家长总结'}">${esc(sed.text)}</div></div>`;
  } else if (detailTab === 'archive') {
    $('#tabact').innerHTML = '<span class="muted edhint">只在后台：老师本人和超级管理员可见</span>';
    $('#tabbody').innerHTML = archiveView(d);
  } else {
    $('#tabact').innerHTML = `<a class="btn sm" id="editReport" href="${esc(d.reportUrl)}&edit=1" target="_blank" rel="noopener">${ICON.edit}编辑</a>
      <button class="btn sm" data-copy="${esc(d.reportUrl)}">${ICON.copy}复制链接</button>`;
    $('#tabbody').innerHTML = web(d.reportUrl!, '');
  }
}

// ---------- 课堂时间档案（后台）：真实时钟、全部环节（含闲聊）、晚开始、学习占比 ----------

const LEARN_KINDS = ['讲解', '讲题', '练习', '答疑', '复习总结', '学习规划'];
const KIND_CLASS: Record<string, string> = { 讲解: 'z1', 讲题: 'z1', 练习: 'z2', 答疑: 'z3', 复习总结: 'z4', 学习规划: 'z5', 课堂交流: 'z6', 课间休息: 'zr', 课前: 'zr', 课后: 'zr' };
const KIND_ORDER = ['讲解', '讲题', '练习', '答疑', '复习总结', '学习规划', '课堂交流', '课间休息', '课前', '课后'];
const clockOf = (ms: number) => when(ms).slice(6);
const mins = (s: number) => `${Math.max(Math.round(s / 60), s > 0 ? 1 : 0)} 分钟`;

function archiveView(d: Detail) {
  const a = d.archive!;
  const st = a.stats;
  const segs = a.segments;
  // 合并反馈：秒数落在哪一节就按哪一节的真实时刻显示；时长按各节相加
  const part = (s: number) => a.parts?.filter((p) => p.start <= s).at(-1);
  const at = (s: number) => clockOf((part(s)?.clock0 ?? d.recStart) + s * 1000);
  const end = segs.at(-1)!.end;
  const span = a.parts ? a.parts.reduce((sum, p) => sum + p.end - p.start, 0) : st.last - st.first;
  const plan = a.parts ? a.parts.reduce((sum, p) => sum + p.plan, 0) : (d.endAt - d.startAt) / 1000;
  const planned = d.kind === 'lesson' || d.kind === 'merged';
  const late = Math.round((d.recStart + st.first * 1000 - d.startAt) / 60_000);
  const low = st.share < LEARN_SHARE;
  const by = KIND_ORDER.map((k) => [k, segs.filter((s) => s.kind === k).reduce((sum, s) => sum + s.end - s.start, 0)] as const).filter(([, v]) => v);
  const kv = [
    ['计划', a.parts ? `${a.parts.length} 节共 ${mins(plan)}` : d.kind === 'lesson' ? `${clockOf(d.startAt)}–${clockOf(d.endAt)}` : '随时录制'],
    ['实际（第一句–最后一句）', `${at(st.first)}–${at(st.last)}`],
    ['实际上课', `${mins(span)}${planned ? `（${span >= plan ? '+' : '−'}${mins(Math.abs(span - plan))}）` : ''}`],
    ['开始', d.kind !== 'lesson' ? '—' : late > 2 ? `晚 ${late} 分钟` : late < -2 ? `早 ${-late} 分钟` : '准时'],
    ['学习时间', `${mins(st.learn)} · ${Math.round(st.share * 100)}%`],
    ['课堂交流', mins(st.chat)],
    ['课间', st.brk ? mins(st.brk) : '无'],
    ['环节 / 课堂瞬间', `${segs.length} / ${a.moments.length}`],
  ];
  return `<div class="card panel arch">
    <div class="note ${low ? 'warn' : 'ok'}">${low
      ? `课堂交流 ${mins(st.chat)}，学习时间只占上课时间（不含课间）的 ${Math.round(st.share * 100)}%。家长报告不显示「比计划多」，时长只算学习时间；闲聊的内容不会出现在家长报告里。`
      : `学习时间占上课时间（不含课间）的 ${Math.round(st.share * 100)}%。家长报告的时长按整节课算${span - plan >= 180 && planned ? `，并显示「比计划多 ${Math.round((span - plan) / 60)} 分钟」` : ''}。`}</div>
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="rtl" role="img" aria-label="${esc(by.map(([k, v]) => `${k}${mins(v)}`).join('，'))}">${segs.map((s) => `<i class="${KIND_CLASS[s.kind] ?? 'z6'}" style="left:${(s.start / end) * 100}%;width:${((s.end - s.start) / end) * 100}%" title="${esc(`${at(s.start)}–${at(s.end)} ${s.kind} · ${s.title}`)}"></i>`).join('')}</div>
    <div class="axis mono"><span>${at(0)} 开始录音</span><span>${at(end / 2)}</span><span>${at(end)}</span></div>
    <ul class="lg">${by.map(([k, v]) => `<li><i class="${KIND_CLASS[k]}"></i>${k}<b>${mins(v)}</b></li>`).join('')}</ul>
    <table class="segs"><tbody>${segs.map((s) => `<tr class="${LEARN_KINDS.includes(s.kind) ? '' : 'off'}"><td class="mono">${at(s.start)}–${at(s.end)}</td><td><i class="${KIND_CLASS[s.kind] ?? 'z6'}"></i>${esc(s.kind)}</td><td><b>${esc(s.title)}</b>　${esc(s.detail)}</td></tr>`).join('')}</tbody></table>
  </div>`;
}

function highlight() {
  const audio = $<HTMLAudioElement>('#audio');
  const lines = [...document.querySelectorAll<HTMLElement>('.lines [data-at]')];
  if (!audio || !lines.length) return;
  let current: HTMLElement | undefined;
  for (const line of lines) if (Number(line.dataset.at) <= audio.currentTime) current = line;
  lines.forEach((line) => line.closest('.line')!.classList.toggle('on', line === current && audio.currentTime > 0));
}

function web(url: string, label: string) {
  const full = new URL(url, location.href).href;
  return `<div class="web"><div class="web-bar">${label ? `<span class="lbl">${label}</span>` : ''}<span class="url mono">${esc(full.replace(/^https?:\/\//, '').replace(/#.*$/, ''))}</span>
    <a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">${ICON.open}打开</a></div>
    <iframe src="${esc(url)}" title="${esc(label || '学情报告')}" loading="lazy"></iframe></div>`;
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ---------- 提示词 ----------

const pr = {
  versions: [] as Version[],
  draft: null as Prompts | null,
  tab: 'parent' as keyof Prompts,
  src: 'lesson' as 'lesson' | 'upload' | 'paste',
  lessonId: '',
  done: [] as Row[],
  file: null as File | null,
  fileTranscript: '',
  paste: '',
  out: null as Out | null,
  kind: 'summary' as 'summary' | 'report',
  compare: true,
  busy: false,
};
const live = () => pr.versions[0];
const pick = (p: Prompts): Prompts => ({ rules: p.rules, parent: p.parent, report: p.report, meeting: p.meeting });
/** 选中「会议纪要」栏时，测试用会议、生成会议纪要；其余三栏测试课程 */
const meetingMode = () => pr.tab === 'meeting';
const doneFor = () => pr.done.filter((l) => l.kind !== 'merged' && (l.kind === 'meeting') === meetingMode()); // 合并反馈没有转写，试不了提示词
const changed = () => KEYS.filter((k) => pr.draft![k] !== live()[k]);

async function showPrompts() {
  main.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  const [{ versions }, { lessons }] = await Promise.all([
    api<{ versions: Version[] }>('/admin/prompts'),
    api<{ lessons: Row[] }>('/admin/lessons?stage=done'),
  ]);
  pr.versions = versions;
  pr.done = lessons;
  try {
    const saved = JSON.parse(store.get(DRAFT_KEY) ?? 'null') as Prompts | null;
    pr.draft = saved && KEYS.every((k) => typeof saved[k] === 'string') ? pick(saved) : pick(live());
  } catch {
    pr.draft = pick(live());
  }
  renderPrompts();
}

function renderPrompts() {
  const dirty = changed().length > 0;
  main.innerHTML = `
    <div class="head"><div class="row" style="gap:12px"><h1>提示词</h1><span class="badge b-ok"><i></i>线上 ${vname(live())}</span></div>
      <div class="row"><button class="btn" id="hist">${ICON.hist}历史版本</button><button class="btn pri" id="apply" ${dirty ? '' : 'disabled'}>应用到全部老师</button></div></div>
    <div class="split">
      <div class="card editor">
        <div class="bar2"><div class="tabs" role="tablist">${KEYS.map((k) => `<button class="tab" role="tab" data-ptab="${k}" aria-selected="${pr.tab === k}">${tabName(k)}</button>`).join('')}</div>
          <span class="saved" id="saved">${savedState()}</span></div>
        <textarea class="code" id="ed" spellcheck="false" aria-label="${KEY_NAMES[pr.tab]}提示词">${esc(pr.draft![pr.tab])}</textarea>
        <div class="hint">${meetingMode() ? '会议主题和日期会自动带上；输出的 JSON 结构写在代码里，这里只改文字要求。「通用规则」不用于会议' : '{学生} {课程} {日期} {老师} 会换成每节课的信息'}</div>
      </div>
      <div class="card test">
        <div class="row" style="justify-content:space-between"><h2>测试</h2>
          <div class="tabs">${([['lesson', '已有课程'], ['upload', '上传音频'], ['paste', '粘贴转写']] as const)
            .map(([k, t]) => `<button class="tab" data-src="${k}" aria-selected="${pr.src === k}">${t}</button>`).join('')}</div></div>
        ${sourceInput()}
        <button class="btn pri" id="gen">${ICON.spark}用草稿生成</button>
      </div>
    </div>
    <div id="out" class="out"></div>`;
  updateGen();
  renderOut();
}

const tabName = (k: keyof Prompts) => `${KEY_NAMES[k]}${pr.draft![k] !== live()[k] ? ' •' : ''}`;
const savedState = () => (changed().length ? '<span class="dot"></span>草稿，未生效<button class="btn ghost sm" id="discard">放弃</button>' : '与线上一致');

function sourceInput() {
  if (pr.src === 'lesson') {
    const done = doneFor();
    if (!done.some((l) => l._id === pr.lessonId)) pr.lessonId = done[0]?._id ?? '';
    return done.length
      ? `<select id="srcLesson" class="input" aria-label="选择${meetingMode() ? '会议' : '课程'}">${done.map((l) => `<option value="${esc(l._id)}" ${pr.lessonId === l._id ? 'selected' : ''}>${when(l.startAt)} ${esc([l.student, l.course].filter(Boolean).join(' · '))}</option>`).join('')}</select>`
      : `<div class="muted small">还没有已完成的${meetingMode() ? '会议' : '课程'}，可以上传音频或粘贴转写</div>`;
  }
  if (pr.src === 'upload') {
    return `<label class="drop" for="file">${pr.file ? `<b>${esc(pr.file.name)}</b>${pr.fileTranscript ? ' · 已转写' : ''}` : '选择 MP3 / M4A / WAV'}</label>
      <input type="file" id="file" accept="audio/*" hidden>`;
  }
  return `<textarea class="paste" id="paste" placeholder="把${meetingMode() ? '会议' : '课堂'}转写粘贴到这里">${esc(pr.paste)}</textarea>`;
}

function updateGen() {
  const ready = pr.src === 'lesson' ? Boolean(pr.lessonId) : pr.src === 'upload' ? Boolean(pr.file) : Boolean(pr.paste.trim());
  const gen = $<HTMLButtonElement>('#gen');
  if (gen) gen.disabled = pr.busy || !ready;
}

function editorChanged() {
  const dirty = changed().length > 0;
  $('#saved').innerHTML = savedState();
  $<HTMLButtonElement>('#apply').disabled = !dirty;
  document.querySelector(`[data-ptab="${pr.tab}"]`)!.textContent = tabName(pr.tab);
  if (dirty) store.set(DRAFT_KEY, JSON.stringify(pr.draft));
  else store.del(DRAFT_KEY);
}

function renderOut() {
  const el = $('#out');
  const o = pr.out;
  if (!el) return;
  if (!o) return void (el.innerHTML = '');
  if (o.busy) return void (el.innerHTML = `<div class="card steps"><div><span class="spin"></span> ${esc(o.busy)}</div></div>`);
  if (o.error) return void (el.innerHTML = `<div class="card steps err">${esc(o.error)}</div>`);
  const col = (which: 'draft' | 'live') => {
    const result = o[which];
    const label = which === 'draft' ? '草稿' : `线上 ${vname(live())}`;
    if (typeof result === 'string' || !result) return `<div class="card"><div class="tag">${label}</div><div class="err">${esc(result || '没有结果')}</div></div>`;
    if (pr.kind === 'summary') return `<div class="card"><div class="tag">${label}</div><pre class="summary">${esc(result.parentSummary)}</pre></div>`;
    return web(`report.html?p=${o.at}#preview=${which}`, label);
  };
  el.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div class="row" style="gap:12px"><h2>测试结果</h2><span class="muted small">${esc(o.label)}</span></div>
      <div class="row" style="gap:16px">
        <div class="tabs">${(o.meeting ? [['summary', '纪要文字'], ['report', '纪要网页']] as const : [['summary', '家长总结'], ['report', '学情报告']] as const).map(([k, t]) => `<button class="tab" data-kind="${k}" aria-selected="${pr.kind === k}">${t}</button>`).join('')}</div>
        <label class="sw"><input type="checkbox" id="cmp" ${pr.compare ? 'checked' : ''}>对比线上</label></div></div>
    <div class="cmp ${pr.compare ? 'two' : ''}"><div>${col('draft')}</div>${pr.compare ? `<div>${col('live')}</div>` : ''}</div>`;
}

const setBusy = (text: string) => {
  pr.out = { busy: text };
  renderOut();
};

/** 测试音频：分块传到云端拼回原文件 → 腾讯云识别 → 轮询拿转写 */
async function transcribe(file: File): Promise<string> {
  const uid = crypto.randomUUID().replaceAll('-', '');
  const parts = Math.ceil(file.size / UPLOAD_CHUNK);
  if (!parts || parts > 100) throw new Error('音频为空或超过 100 MB');
  for (let i = 0; i < parts; i++) {
    setBusy(`上传音频 ${i + 1}/${parts}`);
    await api(`/admin/uploads/${uid}/${i}`, { method: 'POST', body: file.slice(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK), headers: { 'content-type': 'audio/mpeg' } });
  }
  setBusy('提交转写');
  const { taskId } = await post<{ taskId: number }>(`/admin/uploads/${uid}/finish`, { parts });
  const started = Date.now();
  for (;;) {
    setBusy(`腾讯云转写中，已等 ${Math.round((Date.now() - started) / 1000)} 秒（1 小时的录音约需几分钟）`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const s = await api<{ status: string; transcript?: string; message?: string }>(`/admin/asr/${taskId}`);
    if (s.status === 'failed') throw new Error(s.message);
    if (s.status === 'done') {
      if (!s.transcript?.trim()) throw new Error('录音里没有识别到语音');
      return s.transcript;
    }
  }
}

async function generate() {
  pr.busy = true;
  updateGen();
  try {
    let source: Record<string, string>;
    let label: string;
    const meeting = meetingMode();
    if (pr.src === 'lesson') {
      const lesson = pr.done.find((l) => l._id === pr.lessonId)!;
      source = { lessonId: lesson._id };
      label = `${when(lesson.startAt)} ${[lesson.student, lesson.course].filter(Boolean).join(' · ')}`;
    } else if (pr.src === 'upload') {
      if (!pr.fileTranscript) pr.fileTranscript = await transcribe(pr.file!);
      source = { transcript: pr.fileTranscript };
      label = pr.file!.name;
    } else {
      source = { transcript: pr.paste };
      label = '粘贴的转写';
    }
    setBusy('草稿和线上提示词各生成一次，约 1 分钟');
    const [draft, current] = await Promise.allSettled([
      post<Result>('/admin/preview', { prompts: pr.draft, kind: meeting ? 'meeting' : 'lesson', ...source }),
      post<Result>('/admin/preview', { prompts: pick(live()), kind: meeting ? 'meeting' : 'lesson', ...source }),
    ]);
    const value = (r: PromiseSettledResult<Result>) => (r.status === 'fulfilled' ? r.value : (r.reason as Error).message);
    pr.out = { label, at: Date.now(), meeting, draft: value(draft), live: value(current) };
    // 学情报告预览用线上 report.html 渲染：同域，数据经 localStorage 交过去
    for (const which of ['draft', 'live'] as const) {
      const r = pr.out[which];
      if (r && typeof r !== 'string') store.set(`classroom-preview:${which}`, JSON.stringify(r.reportData));
    }
  } catch (error) {
    pr.out = { error: (error as Error).message };
  } finally {
    pr.busy = false;
    renderOut();
    updateGen();
  }
}

function applyDialog() {
  const next = live().version + 1;
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form method="dialog" class="body">
    <h2>应用 v${next} 到全部老师？</h2>
    <div class="row">${changed().map((k) => `<span class="badge">${KEY_NAMES[k]}</span>`).join('')}</div>
    <div class="muted">之后下课生成的报告都会用新版本，已生成的不变。</div>
    <div class="row" style="justify-content:flex-end"><button class="btn" value="cancel">取消</button><button class="btn pri" value="ok" autofocus>应用</button></div></form>`;
  document.body.append(dialog);
  dialog.addEventListener('close', async () => {
    dialog.remove();
    if (dialog.returnValue !== 'ok') return;
    try {
      const { version } = await post<{ version: number }>('/admin/prompts', { prompts: pr.draft, base: live().version });
      pr.versions = (await api<{ versions: Version[] }>('/admin/prompts')).versions;
      pr.draft = pick(live());
      store.del(DRAFT_KEY);
      renderPrompts();
      toast(`已应用 v${version}，之后下课的报告都用新版本`);
    } catch (error) {
      toast((error as Error).message);
    }
  });
  dialog.showModal();
}

function historySheet() {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.innerHTML = `<div class="body">
    <div class="row" style="justify-content:space-between"><h2>历史版本</h2><form method="dialog"><button class="btn ghost sm">关闭</button></form></div>
    <div>${pr.versions.map((v, i) => `<div class="ver"><div>
        <div class="row"><span class="who">${vname(v)}</span>${i === 0 ? '<span class="badge b-ok">线上</span>' : ''}</div>
        <div class="muted mono small">${v.createdAt ? `${when(v.createdAt)} · ` : ''}${esc(v.createdBy)}</div></div>
      ${i === 0 ? '' : `<button class="btn sm" data-load="${v.version}">载入为草稿</button>`}</div>`).join('')}</div></div>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) return dialog.close(); // 点遮罩关闭
    const load = (event.target as HTMLElement).closest<HTMLElement>('[data-load]');
    if (!load) return;
    const version = pr.versions.find((v) => v.version === Number(load.dataset.load))!;
    pr.draft = pick(version);
    store.set(DRAFT_KEY, JSON.stringify(pr.draft));
    dialog.close();
    renderPrompts();
    toast(`${vname(version)} 已载入草稿`);
  });
  dialog.showModal();
}

// ---------- 管理员名单（只有超级管理员能进） ----------

interface Person { openId: string; name: string }
async function showAdmins() {
  const { owners, admins, people } = await api<{ owners: Person[]; admins: Array<Person & { addedBy: string }>; people: Person[] }>('/admin/admins');
  const ownerIds = new Set(owners.map((p) => p.openId));
  const adminIds = new Set(admins.map((p) => p.openId));
  const others = people.filter((p) => !ownerIds.has(p.openId) && !adminIds.has(p.openId));
  const row = (p: Person, role: string, action: string) =>
    `<tr style="cursor:default"><td class="who">${esc(p.name || '（还没登录过）')}</td><td class="muted">${role}</td><td style="text-align:right">${action}</td></tr>`;
  main.innerHTML = `
    <div class="head"><h1>管理员</h1></div>
    <p class="muted" style="margin:-8px 0 16px">超级管理员能看到所有老师的录音和报告，能改提示词和这份名单；老师用飞书登录后只看自己的课程和会议。老师要先登录过一次 App 或后台，才会出现在下面。</p>
    <div class="card tablewrap"><table><thead><tr><th>姓名</th><th>身份</th><th></th></tr></thead><tbody>
      ${owners.map((p) => row(p, '超级管理员 · 创建者', '<span class="muted">不能移除</span>')).join('')}
      ${admins.map((p) => row(p, `超级管理员 · ${esc(p.addedBy)} 添加`, `<button class="btn sm" data-unadmin="${esc(p.openId)}">取消管理员</button>`)).join('')}
      ${others.map((p) => row(p, '老师', `<button class="btn sm" data-admin="${esc(p.openId)}" data-name="${esc(p.name)}">设为超级管理员</button>`)).join('')}
    </tbody></table></div>`;
}

// ---------- 转写编辑：改错字、划词全部替换、说话人改名 ----------

const pop = document.body.appendChild(document.createElement('div'));
pop.className = 'pop';
pop.hidden = true;
let picked = '';
const hidePop = () => { picked = ''; pop.hidden = true; };
const short = (t: string) => (t.length > 12 ? `${t.slice(0, 12)}…` : t);
const countIn = (lines: TLine[], text: string) => lines.reduce((n, l) => n + l.text.split(text).length - 1, 0);

function place(x: number, y: number) {
  pop.style.left = `${Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(y, innerHeight - pop.offsetHeight - 8))}px`;
}
function edited() {
  ed!.dirty = true;
  $<HTMLButtonElement>('#edSave')?.removeAttribute('disabled');
}
/** 批量操作前先存一份，供「撤销」 */
function bulk(apply: () => void) {
  const before = ed!.lines.map((l) => ({ ...l }));
  apply();
  ed!.undo.push(before);
  ed!.dirty = true;
  renderTab();
}

/** 只要在一句话里选中了字就弹出（拖选、双击、Shift+方向键都算） */
/** 选中的字在哪份文字里出现几次：转写编辑时数整份转写，总结编辑时数整段总结 */
const countPicked = (text: string) => (pickIn === 'sum' ? sed!.text.split(text).length - 1 : countIn(ed!.lines, text));
let pickIn: 'tx' | 'sum' = 'tx';

function checkPick() {
  if (!(ed || sed) || !pop.hidden && pop.querySelector('form')) return;
  const sel = getSelection();
  const box = sel?.anchorNode?.parentElement?.closest('.tx, .sumed');
  const text = sel?.toString() ?? '';
  if (!sel || !box || !text.trim() || box !== sel.focusNode?.parentElement?.closest('.tx, .sumed')) return hidePop();
  pickIn = box.classList.contains('sumed') ? 'sum' : 'tx';
  if (pickIn === 'tx' && text.includes('\n')) return hidePop(); // 转写一句一行，跨句的选择不算
  if (text === picked && !pop.hidden) return;
  picked = text;
  pop.innerHTML = `<button class="link" data-p="open">全部替换 · ${countPicked(text)} 处</button>`;
  pop.hidden = false;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  place(r.right - 20, r.bottom + 6);
}
document.addEventListener('mouseup', () => setTimeout(checkPick));
document.addEventListener('keyup', (e) => { if ((e.target as HTMLElement).closest?.('.tx, .sumed')) checkPick(); });
document.addEventListener('mousedown', (e) => {
  if (pop.contains(e.target as Node)) { if ((e.target as HTMLElement).tagName === 'BUTTON') e.preventDefault(); } // 不让句子丢掉选区
  else if (pop.querySelector('form')) hidePop();
});

function renameForm(i: number, at: HTMLElement) {
  const who = ed!.lines[i].who;
  const n = ed!.lines.filter((l) => l.who === who).length;
  pop.innerHTML = `<form data-rename="${i}"><label>把「${esc(short(who))}」改成</label>
    <input value="${esc(who)}" list="whoList" aria-label="新名字" maxlength="20"><datalist id="whoList">${speakerNames(ed!.lines).map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    ${n > 1 ? '<button type="button" class="btn sm" data-p="one">只改这句</button>' : ''}<button class="btn sm pri" data-p="all">${n > 1 ? `全部 ${n} 句` : '改名'}</button></form>`;
  pop.hidden = false;
  const r = at.getBoundingClientRect();
  place(r.left, r.bottom + 6);
  const input = pop.querySelector('input')!;
  input.focus();
  input.select();
}

pop.addEventListener('click', (e) => {
  const p = (e.target as HTMLElement).closest<HTMLElement>('[data-p]')?.dataset.p;
  if (p === 'open' && (ed || sed) && picked) {
    pop.innerHTML = `<form data-replace><label>把 ${countPicked(picked)} 处「${esc(short(picked))}」改成</label>
      <input value="${esc(picked)}" aria-label="替换成"><button class="btn sm pri">全部替换</button></form>`;
    place(pop.offsetLeft, pop.offsetTop);
    pop.querySelector('input')!.focus();
    pop.querySelector('input')!.select();
  }
  if (p === 'one') submitRename(true);
});
pop.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = pop.querySelector('form')!;
  if (form.dataset.rename) return submitRename(false);
  const to = pop.querySelector('input')!.value;
  const from = picked;
  hidePop();
  if (!from || to === from) return;
  if (pickIn === 'sum' && sed) {
    sed.undo.push(sed.text);
    sed.text = sed.text.split(from).join(to);
    sed.dirty = true;
    renderTab();
    return queueSummarySave(0);
  }
  if (ed) bulk(() => ed!.lines.forEach((l) => { l.text = l.text.split(from).join(to); }));
});
function submitRename(one: boolean) {
  const i = Number(pop.querySelector<HTMLElement>('form')!.dataset.rename);
  const to = pop.querySelector('input')!.value.replace(/[\s[\]]/g, '').slice(0, 20); // 名字里不能有空格和方括号，否则行格式会乱
  const from = ed!.lines[i].who;
  hidePop();
  if (!to || to === from) return;
  bulk(() => (one ? [ed!.lines[i]] : ed!.lines.filter((l) => l.who === from)).forEach((l) => { l.who = to; }));
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function saveTranscript() {
  const d = detail!;
  const transcript = joinLines(ed!.lines);
  await api(`/admin/lessons/${d._id}/transcript`, { method: 'PUT', body: JSON.stringify({ transcript, base: await sha256(d.transcript ?? '') }) });
  Object.assign(d, { transcript, transcriptEdited: true });
  ed = null;
  toast('转写已保存');
  renderTab();
}
let sumTimer = 0;
let sumSaving: Promise<void> | null = null;
function queueSummarySave(delay = 1000) {
  clearTimeout(sumTimer);
  sumTimer = window.setTimeout(() => void saveSummary(), delay);
}
async function saveSummary() {
  if (sumSaving) await sumSaving; // 一次只存一份，前一份存完再比较
  if (!sed?.dirty) return;
  const d = detail!;
  const state = (t: string) => { const el = $('#sumState'); if (el) el.textContent = t; };
  const text = sed.text.replace(/\r/g, '').trim();
  if (!text) return state('总结不能为空，内容没有保存');
  sed.dirty = false;
  state('保存中…');
  sumSaving = (async () => {
    try {
      await api(`/admin/lessons/${d._id}/summary`, { method: 'PUT', body: JSON.stringify({ text, base: await sha256(d.editedSummary || d.summary || '') }) });
      d.editedSummary = text;
      state(d.kind === 'meeting' ? '已保存' : '已保存 · 老师在 App 里看到的也是这一版');
    } catch (e) {
      if (sed) sed.dirty = true;
      state((e as Error).message);
    }
  })();
  await sumSaving;
  sumSaving = null;
}
const dirty = () => Boolean(ed?.dirty || sed?.dirty);
const leaveEditor = () => {
  if (sed?.dirty) { clearTimeout(sumTimer); void saveSummary(); } // 总结是自动保存的，离开前把最后几个字存掉
  return !ed?.dirty || confirm('转写还没保存，确定放弃这些修改？');
};
window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });

// ---------- 事件 ----------

let searchTimer = 0;
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest<HTMLElement>('button,tr[data-id]');
  if (!el) return;
  const { dataset: ds, id } = el;
  if (id === 'logout') return logout();
  if (id === 'viewExit') return setView(null);
  // 课程
  if (ds.id) return void (location.hash = `#/lessons/${ds.id}`);
  if (id === 'loadMore') return void loadLessons(true).catch((e: Error) => toast(e.message));
  if (ds.tab) return (detailTab = ds.tab), renderTab();
  if (ds.at) {
    const audio = $<HTMLAudioElement>('#audio');
    if (audio) {
      audio.currentTime = Number(ds.at);
      void audio.play();
    }
    return;
  }
  if (id === 'edStart') return (ed = { id: detail!._id, lines: parseLines(detail!.transcript ?? ''), undo: [], dirty: false }), renderTab();
  if (id === 'edCancel') return void (leaveEditor() && ((ed = null), hidePop(), renderTab()));
  if (id === 'edUndo' && ed?.undo.length) return (ed.lines = ed.undo.pop()!), (ed.dirty = true), renderTab();
  if (id === 'edSave') {
    (el as HTMLButtonElement).disabled = true;
    return void saveTranscript().catch((e: Error) => { toast(e.message); (el as HTMLButtonElement).disabled = false; });
  }
  if (ds.who && ed) return renameForm(Number(ds.who), el);
  if (id === 'sumUndo' && sed?.undo.length) return (sed.text = sed.undo.pop()!), (sed.dirty = true), renderTab(), queueSummarySave(0);
  if (id === 'dltxt') return download(new Blob([detail!.transcript ?? ''], { type: 'text/plain;charset=utf-8' }), `${detail!.fileName}_转写.txt`);
  if (id === 'copySummary') return void copy(sed?.text || detail!.editedSummary || detail!.summary || '', detail!.kind === 'meeting' ? '会议纪要' : '家长总结');
  if (ds.copy) return void copy(ds.copy, '报告链接');
  if (ds.admin) {
    if (!confirm(`把 ${ds.name} 设为超级管理员？他将能看到所有老师的录音和报告，并能修改提示词。`)) return;
    return void api(`/admin/admins/${ds.admin}`, { method: 'PUT', body: JSON.stringify({ name: ds.name }) }).then(showAdmins).catch((e: Error) => toast(e.message));
  }
  if (ds.unadmin) return void api(`/admin/admins/${ds.unadmin}`, { method: 'DELETE' }).then(showAdmins).catch((e: Error) => toast(e.message));
  if (id === 'retry') {
    return void post(`/admin/lessons/${detail!._id}/retry`, {})
      .then(() => { toast('已重新开始处理，几分钟内出结果'); return showLesson(detail!._id); })
      .catch((e: Error) => toast(e.message));
  }
  // 提示词
  if (ds.ptab) return (pr.tab = ds.ptab as keyof Prompts), renderPrompts();
  if (ds.src) return (pr.src = ds.src as typeof pr.src), renderPrompts();
  if (ds.kind) return (pr.kind = ds.kind as typeof pr.kind), renderOut();
  if (id === 'discard') return (pr.draft = pick(live())), store.del(DRAFT_KEY), renderPrompts();
  if (id === 'gen') return void generate();
  if (id === 'apply') return applyDialog();
  if (id === 'hist') return historySheet();
});

document.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'q') {
    list.q = target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => loadLessons().catch((e: Error) => toast(e.message)), 300);
  }
  if (target.classList.contains('sumed') && sed) {
    sed.text = target.textContent ?? '';
    sed.dirty = true;
    queueSummarySave();
  }
  if (target.classList.contains('tx') && ed) {
    const i = Number(target.closest<HTMLElement>('.line')!.dataset.i);
    ed.lines[i].text = (target.textContent ?? '').replace(/\s*\n\s*/g, ' ');
    edited();
  }
  if (target.id === 'ed') {
    pr.draft![pr.tab] = target.value;
    editorChanged();
  }
  if (target.id === 'paste') {
    pr.paste = target.value;
    updateGen();
  }
});
document.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'viewAs') {
    const t = teacherList.find((x) => x.openId === target.value);
    return setView(t ?? null);
  }
  const filter = target.dataset.filter as FilterKey | undefined;
  if (filter) {
    list[filter] = target.value;
    renderHead();
    loadLessons().catch((e: Error) => toast(e.message));
  }
  if (target.id === 'srcLesson') pr.lessonId = target.value;
  if (target.id === 'file' && target.files?.[0]) {
    pr.file = target.files[0];
    pr.fileTranscript = '';
    renderPrompts();
  }
  if (target.id === 'cmp') {
    pr.compare = target.checked;
    renderOut();
  }
});
// 在新标签页改完报告回来，把内嵌的报告刷新一下
let reportEdited = false;
document.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('#editReport')) reportEdited = true; });
window.addEventListener('focus', () => {
  const frame = document.querySelector<HTMLIFrameElement>('.web iframe');
  if (reportEdited && frame) frame.src = frame.src;
  reportEdited = false;
});
let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  if (!leaveEditor()) return history.replaceState(null, '', lastHash); // 留在编辑页，不触发路由
  if (ed && !location.hash.includes(ed.id)) ed = null;
  if (sed && !location.hash.includes(sed.id)) sed = null;
  lastHash = location.hash;
  if (token) route();
});
// 离开总结输入框立刻存，不等 1 秒
document.addEventListener('focusout', (e) => { if ((e.target as HTMLElement).classList?.contains('sumed') && sed?.dirty) queueSummarySave(0); });
// 句子里回车不换行（一句一行是转写的格式）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hidePop();
  if (e.key === 'Enter' && (e.target as HTMLElement).classList?.contains('tx')) e.preventDefault();
});

// ---------- 启动 ----------

if (!token) showLogin();
else {
  api<{ name: string; role: 'admin' | 'teacher' }>('/admin/me', {}, true)
    .then(async ({ name, role }) => {
      realAdmin = role === 'admin';
      myName = name;
      if (!realAdmin) viewAs = null;
      isAdmin = realAdmin && !viewAs;
      if (realAdmin) {
        // 切视角用的老师名单：上过课的老师（只取一次）
        const { people } = await api<{ people: { teacherName: string; teacherOpenId: string }[] }>('/admin/people', {}, true).catch(() => ({ people: [] }));
        teacherList = [...new Map(people.filter((p) => p.teacherOpenId).map((p) => [p.teacherOpenId, p.teacherName])).entries()]
          .map(([openId, n]) => ({ openId, name: n })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      }
      shell(name);
      if (location.hash && !/^#\/(lessons|prompts|admins)/.test(location.hash)) history.replaceState(null, '', location.pathname); // 没有 # = 课程列表
      route();
    })
    .catch((error: Error) => {
      if (token) app.innerHTML = `<div class="login"><div class="card err">${esc(error.message)}</div></div>`;
    });
}
