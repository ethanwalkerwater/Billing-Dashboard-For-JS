import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// 与 docs/design.md「Rust ↔ Web 约定」一致。
export type LessonStatus = 'upcoming' | 'recording' | 'processing' | 'done' | 'cancelled';
export interface Lesson {
  id: string; date: string; start: string; end: string; startAt: number; endAt: number;
  title: string; topic: string; status: LessonStatus; copied: boolean; summary?: string; reportUrl?: string;
  /** 随时录制：adhoc = 课程，meeting = 会议；merged = 老师选几节课合并的一份反馈；课表里的课没有 */
  kind?: 'adhoc' | 'meeting' | 'merged';
  /** 随时录制已结束、等老师填主题 */
  needsName?: boolean;
  /** 课表里的课有学生，按它找同一个学生的课来合并 */
  student?: string;
  /** 合并反馈由哪几节课合并 */
  sources?: string[];
}
export const isMeeting = (l?: Lesson) => l?.kind === 'meeting';
export type RecMode = 'idle' | 'pre' | 'recording' | 'paused' | 'confirm' | 'warn' | 'quiet' | 'ending' | 'processing' | 'naming' | 'gone';
export interface AppState {
  teacher: { name: string } | null;
  loggingIn: boolean;
  lessons: Lesson[];
  rec: {
    mode: RecMode; lessonId: string | null; sec: number; endLeft: number; autoStopAt: string; autoStartAt: string;
    /** 暂停着（「结束？」确认时 mode 是 confirm，靠它知道底下是不是暂停）；pausedSec = 这次暂停了多久；nudge = 胶囊上的暂停提醒 */
    paused: boolean; pausedSec: number; nudge: '' | 'long' | 'voice';
    savedSegments: number; uploadedSegments: number; online: boolean;
  };
  mics: string[]; mic: string;
  autostart: boolean;
  /** 设置里「悬浮录制按钮」开着 */
  fab: boolean;
  /** kind = pause：暂停满 10 分钟的提醒，按钮换成「继续录」 */
  toast: { lessonId: string; title: string; body: string; kind?: 'pause' } | null;
  selectedLessonId: string | null;
  /** App 版本号（设置里显示） */
  version?: string;
  /** 已下载好、等老师点「重启更新」的新版本号 */
  updateReady?: string | null;
}

export interface Backend {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, cb: (payload: never) => void): Promise<unknown>;
}

export const isTauri = '__TAURI_INTERNALS__' in window;
// 浏览器里（npm run dev）用 mock，?scene=0..5 复现 MVP 的 6 个场景，?scene=adhoc 是随时录制刚结束。
const backend: Promise<Backend> = isTauri
  ? Promise.resolve({ invoke, listen: (event, cb) => listen(event, e => cb(e.payload as never)) })
  : import('./mock').then(m => m.mock);

export const call = async <T = unknown>(cmd: string, args?: Record<string, unknown>) =>
  (await backend).invoke(cmd, args) as Promise<T>;
export const on = async <T>(event: string, cb: (payload: T) => void) => (await backend).listen(event, cb as (p: never) => void);
export const onLevel = (cb: (level: number) => void) => on<number>('level', cb);

/** 先订阅 app-state 再取首帧；首帧晚于事件到达时丢弃首帧。 */
export function subscribe(render: (s: AppState) => void) {
  let got = false;
  on<AppState>('app-state', s => { got = true; render(s); })
    .then(() => call<AppState>('get_state'))
    .then(s => { if (!got) render(s); });
}

export const startDragging = () => { if (isTauri) void getCurrentWindow().startDragging(); };

/**
 * 窗口隐藏 8 分钟后 WebKit 会挂起页面进程并丢掉图层（GPU 进程被回收时也一样），
 * 静止的页面重新显示时没有新绘制可等，就一直白屏。可见 / 聚焦时强制整页重绘一次。
 */
function repaint() {
  if (document.hidden) return;
  const r = document.documentElement.style; // 临时多一层合成层，WebKit 会把整页重新画进新的图层；不动滚动位置和焦点
  r.transform = 'translateZ(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => { r.transform = ''; }));
}
document.addEventListener('visibilitychange', repaint);
window.addEventListener('focus', repaint);
