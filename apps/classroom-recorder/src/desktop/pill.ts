import './styles.css';
import { call, onLevel, startDragging, subscribe, type AppState } from './bridge';
import { esc, hms, holdToEnd, tick } from './format';

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
  pill.classList.toggle('warn', rec.mode === 'warn' || rec.mode === 'quiet');
  pill.classList.toggle('form', rec.mode === 'naming');
  pill.classList.toggle('confirm', rec.mode === 'confirm');
  pill.classList.toggle('paused', rec.mode === 'paused');
  const adhoc = Boolean(l?.kind);
  let h = '';
  if (rec.mode === 'pre') h = `<span class="col"><span class="t1">${esc(l?.start)} ${title}</span><span class="t2">${esc(rec.autoStartAt)} 自动开始录制 · 麦克风正常</span></span>${WAVE('green')}<button class="btn" data-act="start">现在开始</button>`;
  // 「暂停」是实心按钮，「结束」是不显眼的文字按钮；结束要在确认卡片上按住 1 秒
  else if (rec.mode === 'recording') h = `<span class="dot"></span><span class="timer num" data-sec></span>${WAVE('red')}<span class="more"><span class="t2">${adhoc ? '随时录制' : `${title} · 拖堂会接着录`}</span><button class="btn pause" data-act="pause">暂停</button><button class="btn soft" data-act="stop">结束</button></span>`;
  else if (rec.mode === 'paused' && rec.nudge === 'long') h = '<span class="pz"></span><span class="col"><span class="t1">已经暂停 <span class="num" data-pz></span> 了</span><span class="t2">回来上课记得点继续，暂停的这段不会录音</span></span><button class="btn white" data-act="resume">继续录</button>';
  else if (rec.mode === 'paused' && rec.nudge === 'voice') h = `<span class="pz"></span><span class="col"><span class="t1">好像开始讲课了？还在暂停中</span><span class="t2">只听了音量，没有录音</span></span>${WAVE('amber')}<button class="btn white" data-act="resume">继续录</button><button class="btn soft" data-act="still">还在聊</button>`;
  else if (rec.mode === 'paused') h = '<span class="pz"></span><span class="col"><span class="t1 num">已暂停 <span data-pz></span></span><span class="t2 num">这段不录音 · 已录 <span data-sec></span></span></span><button class="btn white" data-act="resume">继续录</button><button class="btn soft" data-act="stop">结束</button>';
  else if (rec.mode === 'confirm') h = `<span class="t1">${adhoc ? '结束这段录制？' : '结束这节课的录制？'}</span>
    <span class="t2 num">已录 <span data-sec></span> · 结束后录音提交整理，${adhoc ? '这段' : '这节课'}不能再接着录</span>
    <span class="row2">${rec.paused ? '' : '<button class="link" data-act="pause">只是想停一会儿？改成暂停</button>'}<span class="sp"></span>
      <button class="btn hold" data-hold><span>按住 1 秒结束</span></button>${rec.paused ? '<button class="btn white" data-act="cancel">保持暂停</button>' : '<button class="btn white" data-act="resume">继续录</button>'}</span>`;
  else if (rec.mode === 'warn') h = `<span>⚠</span><span class="col"><span class="t1">没听到声音</span><span class="t2">录音仍在继续 · 检查一下麦克风</span></span>${WAVE('flat')}<select data-act="mic" aria-label="切换麦克风">${S!.mics
    .map(m => `<option value="${esc(m)}"${m === S!.mic ? ' selected' : ''}>${m === S!.mic ? '' : '切换到 '}${esc(m)}</option>`).join('')}</select>`;
  else if (rec.mode === 'quiet') h = '<span class="dot"></span><span class="col"><span class="t1">好像下课了，要结束录制吗？</span><span class="t2 num" data-end></span></span><button class="btn" data-act="keep">继续录</button><button class="btn red" data-act="end">结束</button>';
  else if (rec.mode === 'ending') h = '<span class="dot"></span><span class="col"><span class="t1 num" data-end></span><span class="t2 num">已到下课后 30 分钟 · 已录 <span data-sec></span></span></span><button class="btn red" data-act="end">现在停止</button>';
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
  else if (act === 'pause') void call('pause_recording');
  else if (act === 'still') void call('still_chatting');
  else if (act === 'cancel') void call('cancel_stop');
  else if (act === 'end') void call('end_recording');
  else if (act === 'keep') void call('keep_recording');
});
holdToEnd(pill, () => void call('end_recording'));
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
