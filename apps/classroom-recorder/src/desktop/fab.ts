// 屏幕右侧的「随时录制」悬浮按钮：点一下开录（不需要课表），4 秒不碰就淡下去，悬停展开并恢复。
// 窗口显隐由 Rust 决定（登录了、设置没关、没有胶囊时才显示）。
import './styles.css';
import { call, startDragging, subscribe } from './bridge';

const fab = document.querySelector<HTMLButtonElement>('#fab')!;
// 窗口 = 按钮 + body padding（styles.css .fab-page），展开时向左变宽、右边缘不动
const NARROW = 64, WIDE = 156, H = 64;
let idleT = 0, shrinkT = 0;
let down: { x: number; y: number } | null = null;
let dragged = false;

function wake() {
  fab.classList.remove('idle');
  clearTimeout(idleT);
  idleT = window.setTimeout(() => { if (!fab.matches(':hover')) fab.classList.add('idle'); }, 4000);
}

fab.addEventListener('mouseenter', () => {
  clearTimeout(shrinkT);
  wake();
  void call('resize_fab', { width: WIDE, height: H }).then(() => fab.classList.add('open'));
});
fab.addEventListener('mouseleave', () => {
  fab.classList.remove('open');
  wake();
  shrinkT = window.setTimeout(() => void call('resize_fab', { width: NARROW, height: H }), 320); // 等收起动画
});

// 按下后移动超过 4px 算拖动（交给系统拖窗口），否则松开算点击
fab.addEventListener('pointerdown', e => { if (e.button === 0) { down = { x: e.clientX, y: e.clientY }; dragged = false; } });
fab.addEventListener('pointermove', e => {
  if (!down || dragged || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
  dragged = true;
  startDragging();
});
fab.addEventListener('pointerup', () => { down = null; });
fab.addEventListener('click', () => {
  if (dragged) return;
  fab.classList.remove('open');
  void call('start_adhoc').catch(err => { fab.title = String(err); });
});

// 每次重新出现（录完一段、刚登录）先完整显示几秒再淡下去
let shown = false;
subscribe(s => {
  const visible = Boolean(s.teacher) && s.fab && (s.rec.mode === 'idle' || s.rec.mode === 'gone');
  if (visible && !shown) wake();
  shown = visible;
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
wake();
