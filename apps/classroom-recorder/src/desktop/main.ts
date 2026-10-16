import './styles.css';
import { call, isMeeting, on, onLevel, subscribe, type AppState, type Lesson } from './bridge';
import { esc, MIC_SVG, ordered, shanghaiToday, tick } from './format';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.className = 'main';
const mac = navigator.userAgent.includes('Mac');
const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

let S: AppState | null = null;
let at = 0;
let sel: string | null = null;
let asked: string | null = null; // 上一次 state.selectedLessonId，只在它变化时跟随
let sheetOpen = false;
let flash: string | null = null; // 刚复制过的课，按钮显示「已复制 ✓」
const drafts = new Map<string, string>();
let saveTimer = 0;
// 总结的保存 / 复制排队发：前一个请求还在路上时，后发的新版本不能先到、再被旧版本覆盖
let saving: Promise<unknown> = Promise.resolve();
const inOrder = (cmd: string, args: Record<string, unknown>) => (saving = saving.catch(() => {}).then(() => call(cmd, args)));
let note: { id: string; text: string } | null = null; // 手动开录失败的原因，显示在按钮下
const last = { shell: '', list: '', detail: '', sheet: '' };

const $ = <T extends HTMLElement>(s: string) => app.querySelector<T>(s);
const lessonOf = (id: string | null) => S?.lessons.find(l => l.id === id);
const swap = (key: keyof typeof last, el: HTMLElement | null, html: string) => {
  if (!el || last[key] === html) return false;
  last[key] = html;
  el.innerHTML = html;
  return true;
};

function render() {
  const s = S!;
  const titlebar = (who: string) => `<div class="titlebar${mac ? ' mac' : ''}" data-tauri-drag-region><span class="name" data-tauri-drag-region>菁仕课堂</span>${who}</div>`;
  if (!s.teacher) {
    sheetOpen = false;
    last.list = last.detail = last.sheet = '';
    swap('shell', app, `${titlebar('')}<div class="login"><div class="login-card"><span class="appicon lg">${MIC_SVG}</span><h1>菁仕课堂</h1><p>用飞书登录后，课表会自动同步，到点自动录课</p>${
      s.loggingIn
        ? '<div class="waiting" role="status"><span class="spin dark"></span>已在浏览器打开飞书授权，完成后会自动回来</div>'
        : '<button class="primary" data-act="login">用飞书登录</button>'
    }</div></div>`);
    return;
  }
  if (swap('shell', app, `${titlebar(`<span class="who" data-tauri-drag-region>${esc(s.teacher.name)} · 飞书已登录</span><button class="iconbtn" data-act="settings" title="设置" aria-label="设置">${GEAR}</button>`)}
    <div class="body"><div class="list" id="list"></div><div class="detail" id="detail"></div></div><div class="sheet hidden" id="sheet"></div>`)) {
    last.list = last.detail = last.sheet = '';
  }

  const rows = ordered(s.lessons, shanghaiToday());
  if (s.selectedLessonId !== asked) {
    asked = s.selectedLessonId;
    if (asked && lessonOf(asked)) sel = asked;
  }
  if (!lessonOf(sel)) sel = (rows.find(r => r.group === '今天') ?? rows[0])?.lesson.id ?? null;

  renderList(rows);
  renderDetail(lessonOf(sel));
  renderSheet();
  tick(s.rec, at);
}

/** 下课 10 分钟后还没录的课：Rust 不会再自动 / 手动开录，界面不能再显示「待开始」 */
const missed = (l: Lesson) => l.status === 'upcoming' && Date.now() > l.endAt + 10 * 60_000;
const EARLY = 30 * 60_000; // 与 engine.rs MANUAL_EARLY 一致
/** 会议纪要不发家长，不算「总结未发送」 */
const unsent = (l: Lesson) => l.status === 'done' && !l.copied && !isMeeting(l);
const tag = (l: Lesson) => (l.kind && !l.title.startsWith('随时录制') ? `<span class="tag">${isMeeting(l) ? '会议' : '随时录制'}</span>` : '');
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });

function renderList(rows: ReturnType<typeof ordered>) {
  const s = S!;
  const count = s.lessons.filter(unsent).length;
  let html = '', group = '';
  for (const { lesson: l, label, group: g } of rows) {
    if (g !== group) {
      html += `<div class="group"><span>${g}</span>${!group && count ? `<span class="unsent">${count} 节总结未发送</span>` : ''}</div>`;
      group = g;
    }
    const side =
      l.status === 'recording' ? `<span class="side rec num"${l.id === s.rec.lessonId ? ' data-sec' : ''}>${l.id === s.rec.lessonId ? '' : '录制中'}</span>`
      : l.needsName ? '<span class="side">待填主题</span>'
      : l.status === 'processing' ? '<span class="side">整理中</span>'
      : missed(l) ? '<span class="side">未录制</span>'
      : l.status === 'upcoming' ? '<span class="side">待开始</span>'
      : l.status === 'cancelled' ? '<span class="side">临时取消</span>'
      : `<span class="side">${unsent(l) ? '<span class="unread" title="总结还没复制"></span>' : ''}</span>`;
    html += `<button class="row ${l.id === sel ? 'sel' : ''} ${l.status}" data-id="${esc(l.id)}"><span class="st ${l.status}"></span><span><div class="title">${esc(l.title)}${tag(l)}</div><div class="time num">${g === '更早' ? `${label} ` : ''}${esc(l.start)}–${esc(l.end)}</div></span>${side}</button>`;
  }
  swap('list', $('#list'), html);
}

function renderDetail(l: Lesson | undefined) {
  const s = S!;
  if (!l) return void swap('detail', $('#detail'), '<p class="empty">最近 7 天和明天都没有课</p>');
  const head = `<h2>${esc(l.title)}${tag(l)}</h2><div class="meta num">${l.date.slice(5).replace('-', '/')} · ${esc(l.start)}–${esc(l.end)}${l.topic ? ` · ${esc(l.topic)}` : ''}</div>`;
  let body = '';
  if (l.needsName) {
    body = `<div class="card"><div class="card-h">这段录音是关于什么？ <small>10 分钟不填按「课程」处理</small></div>
      <form class="name-form" data-name="${esc(l.id)}"><input name="topic" maxlength="30" placeholder="例如：教研周会、雅思口语试讲" autocomplete="off" aria-label="主题">
        <span class="seg" role="radiogroup" aria-label="类型"><button type="button" data-kind="adhoc" class="on">课程</button><button type="button" data-kind="meeting">会议</button></span>
        <button class="primary" type="submit">完成</button></form></div>
      <p class="empty">录音已在后台上传。选「课程」出家长总结和学情报告，选「会议」出会议纪要。</p>`;
  } else if (missed(l)) {
    body = '<div class="hero"><div class="sub lead">这节课没有录音</div><div class="sub">下课已超过 10 分钟，不会再自动录制</div></div>';
  } else if (l.status === 'upcoming') {
    body = `<div class="hero"><div class="big num">${esc(l.start)}</div><div class="sub">开课前 3 分钟自动开始录制，你什么都不用做</div>
      <div class="acts">${Date.now() < l.startAt - EARLY
        ? `<span class="sub">${hhmm(l.startAt - EARLY)} 起可以提前手动开始录制</span>`
        : '<button class="primary" data-act="start">现在开始录制</button>'}</div>${
        note?.id === l.id ? `<div class="sub err" role="alert">${esc(note.text)}</div>` : ''}</div>`;
  } else if (l.status === 'recording') {
    const r = s.rec;
    body = `<div class="hero rec"><div class="big red num" data-sec></div><div class="sub">${l.kind ? '随时录制 · 结束时再填主题，最长 3 小时' : `正在录制 · 预计 ${esc(r.autoStopAt)} 自动停止`}</div>
      <div class="chips"><span class="chip num">本机已保存 ${r.savedSegments} 段</span><span class="chip num">已上传 ${r.uploadedSegments} 段</span>${
        r.online ? '<span class="chip ok">● 网络正常</span>' : '<span class="chip warn">● 网络断开，恢复后自动补传</span>'}</div>
      <div class="acts"><button class="ghost" data-act="stop">结束录制</button></div></div>
      <p class="empty">可以关掉这个窗口，录音会继续；屏幕顶部的胶囊会一直陪着你。</p>`;
  } else if (l.status === 'processing') {
    body = '<div class="hero"><div class="sub lead">正在整理这节课…</div><div class="sub">录音已全部上传，总结一般 10 分钟内好，好了会通知你</div></div>';
  } else if (l.status === 'cancelled') {
    body = '<div class="hero"><div class="sub lead">这节课在课表上标了「临时取消」</div><div class="sub">不会自动录制</div></div>';
  } else {
    const copied = flash === l.id;
    const name = isMeeting(l) ? '会议纪要' : '家长总结';
    body = `<div class="card">
        <div class="card-h">${name} <small>可以直接修改，复制的是改过的版本</small></div>
        <textarea class="summary" id="sum" spellcheck="false" aria-label="${name}"></textarea>
        <div class="card-f"><span class="num" id="cnt"></span><span class="sp"></span>
          ${l.copied && !copied ? '<span>已复制过</span>' : ''}<button class="primary${copied ? ' ok' : ''}" data-act="copy">${copied ? '已复制 ✓' : copyLabel(l)}</button></div>
      </div>${l.reportUrl ? `
      <section class="card report-cta" aria-label="${isMeeting(l) ? '会议纪要网页' : '完整课堂学情报告'}">
        ${isMeeting(l) ? '<div><h3>会议纪要网页</h3><p>决定、待办、议题时间分布与发言占比 · 支持下载 PDF</p></div>' : '<div><h3>完整课堂学情报告</h3><p>学习内容、时间分布、掌握情况与课后建议 · 支持下载 PDF</p></div>'}
        <button class="primary cta" data-act="report">${isMeeting(l) ? '查看纪要网页' : '查看完整报告'} <span aria-hidden="true">↗</span></button>
      </section>` : ''}`;
  }
  const changed = swap('detail', $('#detail'), head + body);
  // 总结文本不进 key：老师正在输入时，服务端回推不会冲掉光标。
  const ta = $<HTMLTextAreaElement>('#sum');
  const text = drafts.get(l.id) ?? l.summary ?? '';
  if (ta && (changed || (document.activeElement !== ta && ta.value !== text))) { ta.value = text; fit(ta); }
}

const copyLabel = (l?: Lesson) => (isMeeting(l) ? '复制纪要' : '复制总结');

function fit(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
  $('#cnt')!.textContent = `${ta.value.length} 字`;
}

function renderSheet() {
  const s = S!;
  const el = $('#sheet');
  el?.classList.toggle('hidden', !sheetOpen);
  if (!sheetOpen) return;
  swap('sheet', el, `<div class="panel" role="dialog" aria-label="设置">
    <div class="set"><div class="lab"><b>麦克风</b><span>说句话试试，绿条会跳</span><div class="meter"><i id="meter"></i></div></div>
      <select data-act="mic" aria-label="麦克风">${s.mics.map(m => `<option value="${esc(m)}"${m === s.mic ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
    <div class="set"><div class="lab"><b>悬浮录制按钮</b><span>不在课表里的会议、试讲也能随时录</span></div><button class="switch${s.fab ? '' : ' off'}" data-act="fab" role="switch" aria-checked="${s.fab}" aria-label="悬浮录制按钮"></button></div>
    <div class="set"><div class="lab"><b>开机自动启动</b><span>关掉后，没打开 App 就不会自动录课</span></div><button class="switch${s.autostart ? '' : ' off'}" data-act="autostart" role="switch" aria-checked="${s.autostart}" aria-label="开机自动启动"></button></div>
    <div class="set"><div class="lab"><b>${esc(s.teacher!.name)}</b><span>飞书账号</span></div><button class="logout" data-act="logout">退出登录</button></div>
    <div class="foot"><button class="ghost" data-act="close-settings">完成</button></div>
  </div>`);
}

function setSheet(open: boolean) {
  if (open === sheetOpen || !S?.teacher) return;
  sheetOpen = open;
  void call(open ? 'start_level_preview' : 'stop_level_preview');
  render();
}

function flushSave(id: string) {
  clearTimeout(saveTimer);
  const text = drafts.get(id);
  if (text !== undefined) void inOrder('save_summary', { lessonId: id, text });
}

app.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const kind = t.closest<HTMLElement>('[data-kind]');
  if (kind) return void kind.parentElement!.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('on', b === kind));
  const row = t.closest<HTMLElement>('.row');
  if (row) {
    if (sel) flushSave(sel);
    sel = row.dataset.id!;
    flash = null;
    return render();
  }
  if (t.classList.contains('sheet')) return setSheet(false);
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act || !S) return;
  const lessonId = sel;
  if (act === 'login') void call('login');
  else if (act === 'settings') setSheet(true);
  else if (act === 'close-settings') setSheet(false);
  else if (act === 'autostart') void call('set_autostart', { enabled: !S.autostart });
  else if (act === 'fab') void call('set_fab', { enabled: !S.fab });
  else if (act === 'logout') void call('logout');
  else if (act === 'start') {
    note = null;
    call('start_recording', { lessonId }).catch(err => { note = { id: lessonId!, text: String(err) }; render(); });
  }
  else if (act === 'stop') void call('request_stop');
  else if (act === 'report') void call('open_report', { lessonId });
  else if (act === 'copy') {
    const ta = $<HTMLTextAreaElement>('#sum');
    clearTimeout(saveTimer);
    void inOrder('copy_summary', { lessonId, text: ta?.value ?? '' }).then(() => {
      flash = lessonId; // 草稿留到服务端回推同样的文本时再清
      render();
    });
  }
});

app.addEventListener('change', e => {
  const t = e.target as HTMLSelectElement;
  if (t.dataset.act === 'mic') void call('switch_mic', { name: t.value });
});

app.addEventListener('input', e => {
  const ta = e.target as HTMLTextAreaElement;
  if (ta.id !== 'sum' || !sel) return;
  const id = sel;
  drafts.set(id, ta.value);
  fit(ta);
  if (flash === id) { flash = null; const b = $('[data-act="copy"]'); if (b) { b.textContent = copyLabel(lessonOf(id)); b.classList.remove('ok'); } }
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void inOrder('save_summary', { lessonId: id, text: ta.value }), 800);
});

// 随时录制填主题（主窗口里的那份表单，和胶囊上的是同一件事）
app.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const topic = (form.elements.namedItem('topic') as HTMLInputElement).value;
  const kind = form.querySelector<HTMLElement>('[data-kind].on')?.dataset.kind ?? 'adhoc';
  void call('name_adhoc', { lessonId: form.dataset.name, topic, kind });
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') setSheet(false); });
window.addEventListener('beforeunload', () => { if (sel) flushSave(sel); });

subscribe(s => {
  // 服务端已经是草稿内容时，草稿完成使命。
  for (const l of s.lessons) if (drafts.get(l.id) === l.summary) drafts.delete(l.id);
  S = s;
  at = Date.now();
  render();
});
void on('open-settings', () => setSheet(true));
onLevel(level => {
  const m = sheetOpen && $('#meter');
  if (m) m.style.width = `${Math.min(100, 4 + level * 90)}%`;
});
setInterval(() => S && tick(S.rec, at), 1000);
setInterval(() => S?.teacher && render(), 30_000); // 「可提前开录」「未录制」随时间变化；render 有 diff，没变不动 DOM
