// 浏览器预览用的假后端（不进 Tauri 运行路径）。数据直接取自 docs/mvp-data.js，场景照搬 MVP.html 的 setScene。
// ponytail: 每个页面（index/pill/toast）各有一份 mock，彼此不同步；要联动再加 BroadcastChannel。
import raw from '../../../../docs/mvp-data.js?raw';
import type { AppState, Backend, Lesson, LessonStatus } from './bridge';
import { shanghaiToday } from './format';

interface Demo { id: string; date: string; time: string; title: string; topic: string; status: LessonStatus; copied: boolean; tx?: string }
const { lessons: demo, summaryOf } = new Function(`${raw}\nreturn { lessons, summaryOf };`)() as { lessons: Demo[]; summaryOf: (id: string) => string };

// 把演示日期（2026-10-15 为「今天」）平移到真实的上海今天。
const shift = (Date.parse(shanghaiToday()) - Date.parse('2026-10-15')) / 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const epoch = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+08:00`);

let s: AppState = {
  teacher: { name: '王老师' },
  loggingIn: false,
  lessons: demo.map((l): Lesson => {
    const [start, end] = l.time.split('–');
    const date = addDays(l.date, shift);
    return {
      id: l.id, date, start, end, startAt: epoch(date, start), endAt: epoch(date, end), title: l.title, topic: l.topic,
      status: l.status, copied: l.copied, summary: l.tx ? summaryOf(l.id) : undefined,
      reportUrl: l.tx ? `https://app.jsjy.asia/classroom/report.html?t=demo-${l.id}` : undefined,
    };
  }),
  rec: { mode: 'idle', lessonId: 'xiaoyu', sec: 0, endLeft: 300, autoStopAt: '17:10', autoStartAt: '15:57', savedSegments: 0, uploadedSegments: 0, online: true },
  mics: ['MacBook Pro 麦克风', 'AirPods Pro', 'USB 领夹麦'],
  mic: 'MacBook Pro 麦克风',
  autostart: true,
  fab: true,
  toast: null,
  selectedLessonId: 'haoran',
};

const listeners = new Map<string, Set<(p: never) => void>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach(cb => cb(structuredClone(payload) as never));
const patch = (p: Partial<AppState>) => { s = { ...s, ...p }; emit('app-state', s); };
const setLesson = (id: string, p: Partial<Lesson>) => s.lessons.map(l => (l.id === id ? { ...l, ...p } : l));
const rec = (mode: AppState['rec']['mode'], sec = s.rec.sec): AppState['rec'] => ({
  ...s.rec, mode, sec, savedSegments: Math.floor(sec / 30) + 1, uploadedSegments: Math.floor(sec / 30),
});
const timers: number[] = [];
const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));

function startRec(lessonId: string, sec = 0, mode: AppState['rec']['mode'] = 'recording') {
  patch({ lessons: setLesson(lessonId, { status: 'recording' }), rec: { ...rec(mode, sec), lessonId }, selectedLessonId: lessonId, toast: null });
}
function endRec() {
  const id = s.rec.lessonId!;
  patch({ rec: rec('processing'), lessons: setLesson(id, { status: 'processing' }) });
  later(() => patch({ rec: { ...s.rec, mode: 'gone' } }), 2600);
  later(() => {
    const summary = s.lessons.find(l => l.id === id)?.summary ?? '';
    patch({ lessons: setLesson(id, { status: 'done', copied: false }), toast: { lessonId: id, title: '小雨今天的课堂总结好了', body: summary.replace(/\n+/g, ' ') } });
  }, 3600);
}

function startAdhoc(sec = 0) {
  const now = Date.now(), date = shanghaiToday(), start = new Date(now + 8 * 3_600_000).toISOString().slice(11, 16);
  const id = `adhoc-${now.toString(16).padStart(16, '0').slice(-16)}`;
  s.lessons = [...s.lessons, { id, date, start, end: '', startAt: now, endAt: now + 3 * 3_600_000, title: '随时录制', topic: '', status: 'upcoming', copied: false, kind: 'adhoc' }];
  startRec(id, sec);
}
function endAdhoc() {
  const id = s.rec.lessonId!;
  patch({ rec: { ...rec('naming'), lessonId: id }, lessons: setLesson(id, { status: 'processing', needsName: true, end: new Date(Date.now() + 8 * 3_600_000).toISOString().slice(11, 16) }) });
}
function nameAdhoc(id: string, topic: string, kind: string) {
  const meeting = kind === 'meeting';
  patch({ rec: { ...rec('processing'), lessonId: id }, lessons: setLesson(id, { title: topic.trim() || '随时录制', kind: meeting ? 'meeting' : 'adhoc', needsName: false }) });
  later(() => patch({ rec: { ...s.rec, mode: 'gone' } }), 2600);
  later(() => {
    const l = s.lessons.find(x => x.id === id)!;
    const summary = meeting ? `${l.title} · 会议纪要\n\n演示总结\n\n【决定】\n1. 演示决定\n\n【待办】\n无\n\n【待跟进】\n无` : summaryOf('zihan');
    patch({ lessons: setLesson(id, { status: 'done', summary, reportUrl: 'https://app.jsjy.asia/classroom/report.html?t=demo-zihan' }),
      toast: { lessonId: id, title: `${l.title}的${meeting ? '会议纪要' : '课堂总结'}好了`, body: summary.replace(/\n+/g, ' ') } });
  }, 3600);
}

const scene = new URLSearchParams(location.search).get('scene') ?? '0';
function setScene() {
  if (scene === 'login') return void (s.teacher = null);
  s.selectedLessonId = scene === '0' ? 'haoran' : 'xiaoyu';
  if (scene === '1') s.rec = { ...s.rec, mode: 'pre' };
  if (scene === '2') startRec('xiaoyu');
  if (scene === '3') startRec('xiaoyu', 15 * 60, 'warn');
  if (scene === '4') startRec('xiaoyu', 68 * 60, 'ending');
  if (scene === '5') { startRec('xiaoyu', 73 * 60); endRec(); }
  if (scene === 'adhoc') { startAdhoc(22 * 60 + 14); endAdhoc(); }
}
setScene();

const commands: Record<string, (a: Record<string, string & boolean>) => unknown> = {
  get_state: () => structuredClone(s),
  login: () => { patch({ loggingIn: true }); later(() => patch({ loggingIn: false, teacher: { name: '王老师' } }), 2500); },
  logout: () => patch({ teacher: null }),
  start_recording: a => startRec(a.lessonId),
  request_stop: () => patch({ rec: rec('confirm') }),
  resume_recording: () => patch({ rec: rec('recording') }),
  end_recording: () => (s.lessons.find(l => l.id === s.rec.lessonId)?.kind ? endAdhoc() : endRec()),
  start_adhoc: () => startAdhoc(),
  name_adhoc: a => nameAdhoc(a.lessonId, a.topic, a.kind),
  set_fab: a => patch({ fab: a.enabled }),
  extend_recording: () => patch({ rec: { ...rec('recording'), autoStopAt: '17:25' } }),
  switch_mic: a => patch({ mic: a.name, rec: s.rec.mode === 'warn' ? rec('recording') : s.rec }),
  save_summary: a => patch({ lessons: setLesson(a.lessonId, { summary: a.text }) }),
  copy_summary: async a => {
    await navigator.clipboard?.writeText(a.text).catch(() => {});
    patch({ lessons: setLesson(a.lessonId, { summary: a.text, copied: true }) });
  },
  open_report: a => window.open(s.lessons.find(l => l.id === a.lessonId)?.reportUrl, '_blank', 'noopener'),
  open_main: a => patch({ selectedLessonId: a.lessonId ?? s.selectedLessonId }),
  hide_toast: () => patch({ toast: null }),
  set_autostart: a => patch({ autostart: a.enabled }),
  refresh_lessons: () => new Promise(r => setTimeout(r, 800)),
  delete_lesson: a => patch({ lessons: s.lessons.filter(l => l.id !== a.lessonId) }),
};

// 声波电平约 8 Hz；麦克风异常时几乎为 0。
setInterval(() => emit('level', s.rec.mode === 'warn' ? 0.01 : 0.35 + Math.random() * 0.6), 125);

export const mock: Backend = {
  invoke: async (cmd, args = {}) => commands[cmd]?.(args as never),
  listen: async (event, cb) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(cb); },
};
