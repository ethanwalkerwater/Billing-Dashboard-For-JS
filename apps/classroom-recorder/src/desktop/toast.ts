import './styles.css';
import { call, isMeeting, subscribe, type AppState } from './bridge';
import { MIC_SVG } from './format';

const el = document.querySelector<HTMLDivElement>('#toast')!;
const $ = (s: string) => el.querySelector<HTMLElement>(s)!;
$('.appicon').innerHTML = MIC_SVG;
const copy = $('#toastCopy');
let S: AppState | null = null;
let shown = '';

subscribe(s => {
  S = s;
  const t = s.toast;
  if (!t) { shown = ''; el.classList.add('hidden'); return; }
  const key = `${t.lessonId}\n${t.title}\n${t.body}`;
  if (key === shown) return;
  shown = key;
  $('#toastTitle').textContent = t.title;
  $('#toastBody').textContent = t.body;
  copy.textContent = isMeeting(s.lessons.find(l => l.id === t.lessonId)) ? '复制纪要' : '复制总结';
  // 先以隐藏态排版一帧，再移除 hidden，才有 MVP 的滑入动画。
  el.classList.add('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('hidden')));
});

const close = (delay: number) => setTimeout(() => {
  el.classList.add('hidden');
  setTimeout(() => void call('hide_toast'), 450); // 等滑出动画结束再隐藏窗口
}, delay);

copy.addEventListener('click', async () => {
  const t = S?.toast;
  if (!t) return;
  const text = S!.lessons.find(l => l.id === t.lessonId)?.summary ?? t.body;
  await call('copy_summary', { lessonId: t.lessonId, text });
  copy.textContent = '已复制 ✓';
  close(900);
});
$('#toastClose').addEventListener('click', () => close(0));
$('#toastView').addEventListener('click', () => {
  const t = S?.toast;
  if (!t) return;
  void call('open_main', { lessonId: t.lessonId });
  void call('hide_toast');
});
