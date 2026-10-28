import type { Lesson, AppState } from './bridge';

export const pad = (n: number) => String(n).padStart(2, '0');
export const hms = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
export const ms = (s: number) => `${Math.floor(s / 60)}:${pad(s % 60)}`;
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// 上海无夏令时，固定 +8。
export const shanghaiToday = (now = Date.now()) => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const WEEK = '日一二三四五六';

/** 「10/24 周六」 */
export const dateLabel = (date: string) => `${date.slice(5).replace('-', '/')} 周${WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function dayLabel(date: string, today: string) {
  const diff = dayNum(date) - dayNum(today);
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  if (diff === 1) return '明天';
  return dateLabel(date);
}

const GROUPS = ['今天', '明天', '昨天', '更早'];
export interface Row { lesson: Lesson; label: string; group: string }

/** MVP 排序：今天 → 明天 → 昨天 → 更早；今天/明天按开始时间正序，其余倒序。 */
export function ordered(lessons: Lesson[], today: string): Row[] {
  return lessons
    .map(lesson => {
      const label = dayLabel(lesson.date, today);
      return { lesson, label, group: GROUPS.includes(label) ? label : '更早' };
    })
    .sort((a, b) => {
      const g = GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group);
      if (g) return g;
      const ka = a.lesson.date + a.lesson.start, kb = b.lesson.date + b.lesson.start;
      return a.group === '今天' || a.group === '明天' ? ka.localeCompare(kb) : kb.localeCompare(ka);
    });
}

const LIVE = ['recording', 'warn', 'quiet', 'ending', 'confirm'];
/** Rust 只在状态变化时推快照；两次快照之间按本地时钟补秒。 */
export const elapsed = (at: number) => Math.floor((Date.now() - at) / 1000);
export const liveSec = (rec: AppState['rec'], at: number) => rec.sec + (LIVE.includes(rec.mode) && !rec.paused ? elapsed(at) : 0);

/** 填充 [data-sec] / [data-end] 计时文本；渲染后立即调用一次，再每秒调用。 */
export function tick(rec: AppState['rec'], at: number) {
  const sec = hms(liveSec(rec, at));
  document.querySelectorAll('[data-sec]').forEach(e => { e.textContent = sec; });
  const left = ms(Math.max(0, rec.endLeft - (rec.mode === 'quiet' || rec.mode === 'ending' ? elapsed(at) : 0)));
  document.querySelectorAll('[data-end]').forEach(e => { e.textContent = `${left} 后自动停止`; });
  const pz = rec.pausedSec + (rec.paused ? elapsed(at) : 0);
  document.querySelectorAll('[data-pz]').forEach(e => { e.textContent = `${pad(Math.floor(pz / 60))}:${pad(pz % 60)}`; });
}

/**
 * 「按住 1 秒结束」：按下开始走进度（按钮的 --p 从 0 到 1），松手、移出就取消，误点、连点都不会结束。
 * 键盘按住空格或回车也行。root 里所有 [data-hold] 按钮共用。
 */
export function holdToEnd(root: HTMLElement, done: () => void, ms = 1000) {
  let btn: HTMLElement | null = null;
  let raf = 0;
  const cancel = () => {
    cancelAnimationFrame(raf);
    btn?.style.setProperty('--p', '0');
    btn = null;
  };
  const start = (b: HTMLElement) => {
    if (btn) return;
    btn = b;
    const t0 = performance.now();
    const step = (t: number) => {
      if (!btn) return;
      const p = Math.min(1, (t - t0) / ms);
      btn.style.setProperty('--p', String(p));
      if (p < 1) return void (raf = requestAnimationFrame(step));
      cancel();
      done();
    };
    raf = requestAnimationFrame(step);
  };
  const holdOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('[data-hold]');
  root.addEventListener('pointerdown', e => { const b = holdOf(e); if (b && e.button === 0) { e.preventDefault(); start(b); } });
  root.addEventListener('pointerout', e => { if (btn && !btn.contains(e.relatedTarget as Node)) cancel(); });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  root.addEventListener('keydown', e => { const b = holdOf(e); if (b && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); if (!e.repeat) start(b); } });
  root.addEventListener('keyup', e => { if (holdOf(e)) cancel(); });
}

export const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/></svg>';
