import './styles.css';
import { call, onLevel, startDragging, subscribe, type AppState } from './bridge';
import { esc, hms, tick } from './format';

const pill = document.querySelector<HTMLDivElement>('#pill')!;
// body 的 padding（styles.css .pill-page）给阴影留位置，窗口尺寸 = 胶囊 + 这些边距。
const PAD_X = 36 * 2, PAD_Y = 20 + 44;
const WAVE = (tone: string) => `<span class="wave ${tone}" id="wave">${'<i></i>'.repeat(9)}</span>`;
let S: AppState | null = null;
let at = 0;
let html = '';
let size = '';

function render() {
  const { rec, lessons } = S!;
  const l = lessons.find(x => x.id === rec.lessonId);
  const title = esc(l?.title);
  pill.classList.toggle('hidden', rec.mode === 'idle' || rec.mode === 'gone');
  pill.classList.toggle('warn', rec.mode === 'warn');
  pill.classList.toggle('form', rec.mode === 'naming');
  const adhoc = Boolean(l?.kind);
  let h = '';
  if (rec.mode === 'pre') h = `<span class="col"><span class="t1">${esc(l?.start)} ${title}</span><span class="t2">${esc(rec.autoStartAt)} 自动开始录制 · 麦克风正常</span></span>${WAVE('green')}<button class="btn" data-act="start">现在开始</button>`;
  else if (rec.mode === 'recording') h = `<span class="dot"></span><span class="timer num" data-sec></span>${WAVE('red')}<span class="more"><span class="t2">${adhoc ? '随时录制' : `${title} · ${esc(rec.autoStopAt)} 自动停止`}</span><button class="btn red" data-act="stop">结束</button></span>`;
  else if (rec.mode === 'confirm') h = `<span class="t1">${adhoc ? '结束这段录制？' : '结束这节课的录制？'}</span><button class="btn" data-act="resume">继续录</button><button class="btn red" data-act="end">结束</button>`;
  else if (rec.mode === 'warn') h = `<span>⚠</span><span class="col"><span class="t1">没听到声音</span><span class="t2">录音仍在继续 · 检查一下麦克风</span></span>${WAVE('flat')}<select data-act="mic" aria-label="切换麦克风">${S!.mics
    .map(m => `<option value="${esc(m)}"${m === S!.mic ? ' selected' : ''}>${m === S!.mic ? '' : '切换到 '}${esc(m)}</option>`).join('')}</select>`;
  else if (rec.mode === 'ending') h = '<span class="dot"></span><span class="col"><span class="t1 num" data-end></span><span class="t2 num">已录 <span data-sec></span></span></span><button class="btn" data-act="extend">再录 15 分钟</button><button class="btn red" data-act="end">现在停止</button>';
  else if (rec.mode === 'processing') h = `<span class="spin"></span><span class="col"><span class="t1">${adhoc ? '已结束，正在整理…' : '已结束，正在整理课堂…'}</span><span class="t2">好了会通知你，可以合上电脑了</span></span>`;
  else if (rec.mode === 'naming') h = `<form data-name="${esc(rec.lessonId)}"><span class="t1">这段录音是关于什么？</span>
    <input name="topic" maxlength="30" placeholder="例如：教研周会、雅思口语试讲" autocomplete="off" aria-label="主题">
    <span class="seg" role="radiogroup" aria-label="类型"><button type="button" data-kind="adhoc" class="on">课程</button><button type="button" data-kind="meeting">会议</button></span>
    <span class="foot"><span class="t2 num">${rec.sec ? `已录 ${hms(rec.sec)} · ` : ''}录音已在上传</span><button class="btn red" type="submit">完成</button></span></form>`;
  if (h !== html) {
    html = h;
    pill.innerHTML = h;
    pill.querySelector('input')?.focus();
  }
  tick(rec, at);
  if (h) fit();
}

/**
 * 量胶囊尺寸，让 Rust 把窗口改成刚好包住它（窗口按中心缩放，胶囊在窗口里也居中，所以不会左右跳）。
 * 悬停时按 .more 完全展开后的宽度算，否则悬停期间来一次状态推送就会把窗口缩回去。
 */
function fit() {
  requestAnimationFrame(() => {
    const r = pill.getBoundingClientRect();
    const more = pill.matches(':hover') ? pill.querySelector<HTMLElement>('.more') : null;
    const width = Math.ceil(r.width) + (more ? more.scrollWidth - more.clientWidth : 0) + PAD_X, height = Math.ceil(r.height) + PAD_Y;
    if (`${width}x${height}` === size) return;
    size = `${width}x${height}`;
    void call('resize_pill', { width, height });
  });
}
pill.addEventListener('mouseenter', () => { if (pill.querySelector('.more')) fit(); });
pill.addEventListener('mouseleave', () => { if (pill.querySelector('.more')) setTimeout(fit, 380); });

pill.addEventListener('pointerdown', e => {
  if (e.button === 0 && !(e.target as HTMLElement).closest('button,select,input')) startDragging();
});
pill.addEventListener('click', e => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
  if (kind) return void kind.parentElement!.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('on', b === kind));
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act || act === 'mic' || !S) return;
  if (act === 'start') void call('start_recording', { lessonId: S.rec.lessonId });
  else if (act === 'stop') void call('request_stop');
  else if (act === 'resume') void call('resume_recording');
  else if (act === 'end') void call('end_recording');
  else if (act === 'extend') void call('extend_recording');
});
// 填主题：回车或「完成」；类型取当前选中的那个
pill.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const topic = (form.elements.namedItem('topic') as HTMLInputElement).value;
  const kind = form.querySelector<HTMLElement>('[data-kind].on')?.dataset.kind ?? 'adhoc';
  void call('name_adhoc', { lessonId: form.dataset.name, topic, kind });
});
pill.addEventListener('change', e => {
  const t = e.target as HTMLSelectElement;
  if (t.dataset.act === 'mic') void call('switch_mic', { name: t.value });
});

subscribe(s => { S = s; at = Date.now(); render(); });
onLevel(level => {
  const wave = document.querySelector('#wave');
  if (!wave) return;
  const flat = wave.classList.contains('flat');
  wave.querySelectorAll<HTMLElement>('i').forEach((b, i) => {
    b.style.height = `${flat ? 3 : 4 + Math.min(1, level * 1.6) * (5 + 10 * Math.abs(Math.sin(Date.now() / 180 + i * 0.9)))}px`;
  });
});
setInterval(() => S && tick(S.rec, at), 1000);
