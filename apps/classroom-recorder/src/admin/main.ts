/**
 * 菁仕课堂后台（/classroom/admin.html）：
 * - 课程：录音、转写、家长总结、学情报告（报告直接嵌线上 report.html）
 * - 提示词：草稿只存在本机浏览器，试生成时草稿和线上各跑一次对比；「应用到全部老师」才写入新版本
 * 接口：classroom-api 的 /admin/*，飞书登录后 token 放 localStorage。
 */
import './styles.css';

type Stage = 'recording' | 'queued' | 'transcribing' | 'summarizing' | 'done' | 'failed';
interface Row { _id: string; student: string; course: string; kind?: 'lesson' | 'adhoc' | 'meeting'; teacherName: string; startAt: number; endAt: number; stage: Stage; attempts: number; promptVersion: number | null }
interface Detail extends Row {
  error?: string; transcript?: string; summary?: string; editedSummary?: string;
  mins: number; gapMinutes?: number; fileName: string; audioUrl: string | null; audioDeletedAt?: number | null; reportUrl: string | null;
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
  history.replaceState(null, '', `${location.pathname}#/lessons`);
}
let token = store.get(TOKEN_KEY) ?? hashToken ?? '';

function showLogin() {
  app.innerHTML = `<div class="login"><div class="card">
    <div class="brand" style="padding:0"><div class="logo">菁</div>菁仕课堂后台</div>
    <a class="btn pri" href="${API}/admin/login">用飞书登录</a></div></div>`;
}
function logout() {
  token = '';
  store.del(TOKEN_KEY);
  showLogin();
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) };
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
function shell(name: string) {
  app.innerHTML = `<div class="app">
    <aside>
      <div class="brand"><div class="logo">菁</div><span>菁仕课堂后台</span></div>
      <a class="nav" href="#/lessons" data-nav="lessons">${ICON.lessons}课程</a>
      <a class="nav" href="#/prompts" data-nav="prompts">${ICON.prompts}提示词</a>
      <div class="me"><span>${esc(name)}</span><button id="logout">退出</button></div>
    </aside>
    <main id="main"></main></div>`;
  main = $('#main');
}

function route() {
  const [, page = 'lessons', id] = location.hash.match(/^#\/(lessons|prompts)(?:\/(rec\w+|adhoc-[0-9a-f]{16}))?/) ?? [];
  document.querySelectorAll('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', false));
  document.querySelector(`[data-nav="${page}"]`)?.setAttribute('aria-current', 'page');
  const run = page === 'prompts' ? showPrompts() : id ? showLesson(id) : showLessons();
  run.catch((error: Error) => { if (token) main.innerHTML = `<div class="card empty err">${esc(error.message)}</div>`; });
}

// ---------- 课程列表 ----------

const list = { rows: [] as Row[], q: '', stage: 'all', more: false, seq: 0 };

function status(row: Row): [string, string] {
  if (row.stage === 'done') return ['已完成', 'b-ok'];
  if (row.stage === 'recording') return ['录制中', 'b-warn'];
  if (row.stage === 'failed') return row.attempts >= 3 ? ['失败', 'b-bad'] : ['重试中', 'b-warn'];
  return [row.stage === 'summarizing' ? '生成中' : '转写中', 'b-info'];
}
const badge = (row: Row) => {
  const [text, cls] = status(row);
  return `<span class="badge ${cls}"><i></i>${text}</span>`;
};

async function loadLessons(append = false) {
  const seq = ++list.seq;
  const params = new URLSearchParams();
  if (list.q) params.set('q', list.q);
  if (list.stage !== 'all') params.set('stage', list.stage);
  if (append && list.rows.length) params.set('before', String(list.rows.at(-1)!.startAt));
  const { lessons } = await api<{ lessons: Row[] }>(`/admin/lessons?${params}`);
  if (seq !== list.seq) return; // 搜索框连续输入：只认最后一次
  list.rows = append ? list.rows.concat(lessons) : lessons;
  list.more = lessons.length === 50;
  const rows = $('#rows');
  if (!rows) return;
  rows.innerHTML = list.rows.map((r) => `<tr data-id="${esc(r._id)}">
      <td class="mono">${when(r.startAt)}</td><td class="who">${esc(r.student || '—')}</td><td>${esc(r.course)}${kindTag(r)}</td><td>${esc(r.teacherName)}</td>
      <td class="mono muted">${Math.round((r.endAt - r.startAt) / 60_000) || "&lt;1"} 分钟</td><td>${badge(r)}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">${list.q || list.stage !== 'all' ? '没有符合条件的课程' : '还没有录过课'}</td></tr>`;
  $('#more').hidden = !list.more;
}

async function showLessons() {
  main.innerHTML = `
    <div class="head"><h1>课程</h1>
      <div class="row">
        <label class="input search" for="q">${ICON.search}<input id="q" placeholder="学生、课程或老师" value="${esc(list.q)}" autocomplete="off"></label>
        <select id="stage" class="input" aria-label="状态">
          ${[['all', '全部状态'], ['done', '已完成'], ['processing', '转写中'], ['recording', '录制中'], ['failed', '失败']]
            .map(([v, t]) => `<option value="${v}" ${list.stage === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="card tablewrap"><table>
      <thead><tr><th>上课时间</th><th>学生</th><th>课程</th><th>老师</th><th>时长</th><th>状态</th></tr></thead>
      <tbody id="rows"><tr><td colspan="6" class="empty"><span class="spin"></span></td></tr></tbody></table></div>
    <div class="more" id="more" hidden><button class="btn" id="loadMore">加载更多</button></div>`;
  await loadLessons();
}

/** 随时录制的标记；课表里的课不标 */
const kindTag = (r: Row) => (r.kind === 'meeting' ? ' <span class="badge">会议</span>' : r.kind === 'adhoc' ? ' <span class="badge">随时录制</span>' : '');

// ---------- 课程详情 ----------

let detail: Detail | null = null;
let detailTab = 'transcript';
const LINE = /^\[(老师|学生|说话人\d+) (\d+):(\d{2})-\d+:\d{2}\] (.*)$/;
const speakerClass = (who: string) => (who === '老师' ? 's1' : who === '学生' ? 's2' : `s${who.slice(3)}`);

async function showLesson(id: string) {
  main.innerHTML = `<div class="crumb"><a href="#/lessons">课程</a></div><div class="empty"><span class="spin"></span></div>`;
  const d = (detail = await api<Detail>(`/admin/lessons/${id}`));
  const done = d.stage === 'done';
  if (!d.transcript && detailTab === 'transcript' && done) detailTab = 'summary';
  if (!done && detailTab !== 'transcript') detailTab = 'transcript';
  const pending =
    d.stage === 'failed' ? `<div class="card panel" style="margin-bottom:16px"><div class="row" style="justify-content:space-between">
        <span class="err">${esc(d.error || '处理失败')}</span><button class="btn sm" id="retry">重新处理</button></div></div>`
    : d.stage === 'recording' ? '<div class="card empty">正在上课录制，下课后自动转写</div>'
    : !done && !d.transcript ? '<div class="card empty">正在转写，通常下课后几分钟内完成</div>'
    : '';
  const tabs = [['transcript', '转写', Boolean(d.transcript)], ['summary', d.kind === 'meeting' ? '会议纪要' : '家长总结', done], ['report', d.kind === 'meeting' ? '纪要网页' : '学情报告', done && Boolean(d.reportUrl)]]
    .filter(([, , show]) => show);
  main.innerHTML = `
    <div class="crumb"><a href="#/lessons">课程</a><span>/</span><span>${esc(d.student || d.course)}</span></div>
    <div class="head"><div><h1>${esc([d.student, d.course].filter(Boolean).join(' · '))}${kindTag(d)}</h1>
      <div class="muted" style="margin-top:4px">${esc(d.teacherName)} · ${when(d.startAt)}${d.promptVersion != null && done ? ` · 提示词 ${d.promptVersion ? `v${d.promptVersion}` : '默认'}` : ''}${d.gapMinutes ? ` · 录音缺失约 ${d.gapMinutes} 分钟` : ''}</div></div>
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
  if (detailTab === 'transcript') {
    $('#tabact').innerHTML = `<button class="btn sm" id="dltxt">${ICON.dl}下载转写</button>`;
    $('#tabbody').innerHTML = `<div class="card panel"><div class="lines">${(d.transcript ?? '').split('\n').map((line) => {
      const m = line.match(LINE);
      if (!m) return `<div class="line" style="cursor:default"><span></span><span></span><span>${esc(line)}</span></div>`;
      const at = Number(m[2]) * 60 + Number(m[3]);
      return `<button class="line" data-at="${at}"><span class="t mono">${mmss(at)}</span><span class="s ${speakerClass(m[1])}">${m[1]}</span><span>${esc(m[4])}</span></button>`;
    }).join('')}</div></div>`;
    highlight();
  } else if (detailTab === 'summary') {
    $('#tabact').innerHTML = `${d.editedSummary ? '<span class="badge">老师改过</span>' : ''}<button class="btn sm" id="copySummary">${ICON.copy}复制</button>`;
    $('#tabbody').innerHTML = `<div class="card panel"><pre class="summary">${esc(d.editedSummary || d.summary)}</pre></div>`;
  } else {
    $('#tabact').innerHTML = `<button class="btn sm" data-copy="${esc(d.reportUrl)}">${ICON.copy}复制链接</button>`;
    $('#tabbody').innerHTML = web(d.reportUrl!, '');
  }
}

function highlight() {
  const audio = $<HTMLAudioElement>('#audio');
  const lines = [...document.querySelectorAll<HTMLElement>('.line[data-at]')];
  if (!audio || !lines.length) return;
  let current: HTMLElement | undefined;
  for (const line of lines) if (Number(line.dataset.at) <= audio.currentTime) current = line;
  lines.forEach((line) => line.classList.toggle('on', line === current && audio.currentTime > 0));
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
const doneFor = () => pr.done.filter((l) => (l.kind === 'meeting') === meetingMode());
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

// ---------- 事件 ----------

let searchTimer = 0;
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest<HTMLElement>('button,tr[data-id]');
  if (!el) return;
  const { dataset: ds, id } = el;
  if (id === 'logout') return logout();
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
  if (id === 'dltxt') return download(new Blob([detail!.transcript ?? ''], { type: 'text/plain;charset=utf-8' }), `${detail!.fileName}_转写.txt`);
  if (id === 'copySummary') return void copy(detail!.editedSummary || detail!.summary || '', detail!.kind === 'meeting' ? '会议纪要' : '家长总结');
  if (ds.copy) return void copy(ds.copy, '报告链接');
  if (id === 'retry') {
    return void post(`/admin/lessons/${detail!._id}/retry`, {})
      .then(() => { toast('已重新排队，1 分钟内开始处理'); return showLesson(detail!._id); })
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
  if (target.id === 'stage') {
    list.stage = target.value;
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
window.addEventListener('hashchange', () => token && route());

// ---------- 启动 ----------

if (!token) showLogin();
else {
  api<{ name: string }>('/admin/me')
    .then(({ name }) => {
      shell(name);
      if (!/^#\/(lessons|prompts)/.test(location.hash)) history.replaceState(null, '', `${location.pathname}#/lessons`);
      route();
    })
    .catch((error: Error) => {
      if (token) app.innerHTML = `<div class="login"><div class="card err">${esc(error.message)}</div></div>`;
    });
}
