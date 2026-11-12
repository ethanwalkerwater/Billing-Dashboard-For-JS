/**
 * 菁仕工作台（/work/，也能从 /classroom/workbench/ 打开）：课表、学员、学生档案、跟进、录课管理。
 * 界面照 docs/学生档案.html 的 v9 原型（shadcn/ui 官方 blocks），数据走 classroom-api 的 /wb/*，登录和后台共用飞书登录与 token。
 * 打开时一次拉齐（/wb/boot），课表快照过期了再同步一次；不加定时器。
 */
import './styles.css';
import { PKEYS, PRESET, STAGES } from '../server/workbench';

const API = '/classroom-api';
const TOKEN_KEY = 'classroom-admin-token';
const VIEW_KEY = 'workbench-view-as';
const COLLAPSE_KEY = 'workbench-sidebar-collapsed';
const FEISHU_CHANGE = 'https://applink.feishu.cn/T9b2dTvokbHZ'; // 取消、调课的飞书审批
const FEISHU_ROSTER = 'https://ccntnl19k0y3.feishu.cn/base/Xb34bXSVRaQk7ysfAQScPZp5nPh?table=tblQGkH5DweXpOW8';
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
};
if (store.get(COLLAPSE_KEY) === '1') document.body.classList.add('collapsed');

const IC = {
  chev:'<path d="m9 18 6-6-6-6"/>',
  left:'<path d="m15 18-6-6 6-6"/>',
  x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  ext:'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  up:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
  img:'<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  refresh:'<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  cols:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  more:'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  bot:'<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  panel:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  updown:'<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  ccheck:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  calert:'<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  tri:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  cdash:'<path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0"/><path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7"/><path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8"/><path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69"/><path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0"/><path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7"/><path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8"/><path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69"/>',
  ban:'<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  circle:'<circle cx="12" cy="12" r="10"/>',
  spark:'<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
  mic:'<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  copy:'<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  eye:'<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  out:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
};
const ic = (n, s) => `<svg class="i" viewBox="0 0 24 24"${s ? ` style="width:${s}px;height:${s}px"` : ''}>${IC[n]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = (t, v) => `<span class="badge ${v ?? ''}">${esc(t)}</span>`;
// 状态徽章：颜色之外都带一个图形，色弱也能分清
const SBI = {good:'ccheck', warn:'calert', bad:'tri', sec:'cdash', none:'cdash', cx:'ban', up:'clock', info:'circle'};
const sb = (t, c) => `<span class="sbadge ${c || 'sec'}">${ic(SBI[c] || 'cdash', 12)}${esc(t)}</span>`;
const DOT = {g:'掌握', a:'部分掌握', r:'没掌握', x:'没录课', c:'取消'};

// ---------- 时间（上海） ----------
const HOUR = 3600e3, DAYMS = 24 * HOUR;
const shIso = ms => new Date(ms + 8 * HOUR).toISOString();
const dt = d => new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8));
const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = dt(d); x.setDate(x.getDate() + n); return iso(x); };
const md = d => `${+d.slice(5, 7)}/${d.slice(8)}`;
const wd = d => '周' + '日一二三四五六'[dt(d).getDay()];
const ml = k => `${k.slice(0, 4)} 年 ${+k.slice(5)} 月`;
const addMonth = (k, n) => { const x = new Date(+k.slice(0, 4), +k.slice(5) - 1 + n, 1); return iso(x).slice(0, 7); };

// ---------- 数据（/wb/boot） ----------
let ME = {name:'', role:'out', scheduleName:'', viewing:null};
let NOWMS = Date.now(), TODAY = '', NOWT = '', NOW = '', MONTHS = [], SYNCED = 0;
let FIELDS = [], S = {}, ORDER = [], LES = [], BY = {}, LMAP = new Map(), VALS = {}, TODOS = [], GRADES = [], STAFF = [], TEACHERS = [];
const LOADED = new Set();
const REP = {}, DETAIL = {};
let token = '';
const COLORS = {sec:'灰', good:'蓝', warn:'黄', bad:'橙', info:'黑框'};
const FTYPE = {select:'单选', text:'文本', date:'日期'};
const STAGE = Object.fromEntries(STAGES.map(k => [k, '']));
const SCALE = ['U','E','D','C','B','A','A*'];

// 课的行见 src/server/workbench.ts encodeLessons：字符串都是字典下标，时间是分钟
const toLes = (r, D) => {
  const at = r[1] * 60e3, end = at + r[2] * 60e3, type = D[r[7]] || '';
  return {id:r[0], at, end, d:shIso(at).slice(0, 10), s:shIso(at).slice(11, 16), e:shIso(end).slice(11, 16), stu:r[3].map(i => D[i]), c:D[r[4]] || '课程', t:D[r[5]] || '', p:D[r[6]] || '', type,
    cancel:D[r[8]] || '', trial:!!r[9], q:r[10] || '', meet:!r[3].length || /会议/.test(type) || /会议|咨询|到访|对接会/.test(D[r[4]] || ''), exam:!D[r[5]] || /考试|模考|模测/.test(D[r[4]] || '')};
};
function addLessons(enc, students) {
  for (const r of enc.rows) { const x = toLes(r, enc.dict); LMAP.set(x.id, x); }
  LES = [...LMAP.values()].sort((a, b) => a.at - b.at);
  BY = {};
  for (const x of LES) for (const id of x.stu) (BY[id] ||= []).push(x);
  for (const [id, s] of Object.entries(students || {})) if (!S[id]) S[id] = s;
  for (const k of Object.keys(LINEC)) delete LINEC[k];
}
function load(B) {
  ME = B.me; NOWMS = B.now; TODAY = shIso(NOWMS).slice(0, 10); NOWT = shIso(NOWMS).slice(11, 16); NOW = TODAY.slice(0, 7);
  MONTHS = B.months.filter(m => m <= NOW); SYNCED = B.syncedAt;
  FIELDS = B.fields; S = B.students; VALS = B.vals; STAFF = B.staff; TEACHERS = B.teachers;
  LMAP = new Map(); LES = []; BY = {}; addLessons(B.lessons);
  B.months.forEach(m => LOADED.add(m));
  ORDER = [...new Set(B.list)].filter(id => S[id]).sort((a, b) => nm(a).localeCompare(nm(b), 'zh-CN'));
  TODOS = B.todos.map(todoOf);
  GRADES = B.grades.map(g => ({id:g._id, sid:g.student, d:g.date, exam:g.exam, sub:g.subject, score:g.score, by:g.by, file:g.file}));
}
const todoOf = t => ({id:t._id, s:t.student, t:t.text, type:'人工', owner:t.owner, dueD:t.due, due:md(t.due), b:bucket(t.due), done:t.done, result:t.result, at:shIso(t.createdAt).slice(0, 10), ms:t.createdAt});

// ---------- 接口 ----------
async function api(path, init = {}) {
  const viewAs = store.get(VIEW_KEY);
  const headers = {authorization:`Bearer ${token}`, ...(init.body && typeof init.body === 'string' ? {'content-type':'application/json'} : {}), ...(viewAs ? {'x-view-as-teacher':encodeURIComponent(viewAs)} : {}), ...init.headers};
  const res = await fetch(API + path, {...init, headers});
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(body.error === 'RELOGIN' ? '请重新用飞书登录一次' : ''); throw new Error(body.message || '登录已失效'); }
  if (!res.ok) throw new Error(body.message || `请求失败（${res.status}）`);
  return body;
}
const send = (path, method, body) => api(path, {method, body:JSON.stringify(body)});
const fail = e => toast(e.message || '没保存成功，请重试');

const nm = id => S[id]?.name || (String(id).startsWith('n:') ? id.slice(2) : '未知学生');
const ROLE_NAME = {teacher:'老师', staff:'教务', admin:'管理员'};
let st = {page:'schedule', sid:null, tab:'overview', stage:'全部', lm:'', mf:'', q:'', sel:new Set(), bulk:'', fu:'全部', course:'全部', cm:'', ct:'全部', showDone:false, adding:false, loading:true, error:''};
let dayCtx = null;
const $ = s => document.querySelector(s);
const staff = () => ME.role === 'staff' || ME.role === 'admin';
const who = () => (ME.role === 'staff' ? '教务 ' : '') + ME.name;
const MEN = () => ME.scheduleName;
const past = x => x.at < NOWMS;
const meetT = x => x.meet;

// ---------- 学生的课（从课表推出来） ----------
const lesOf = (id, c) => (BY[id] || []).filter(x => x.c === c);
const LINEC = {};
function linesOf(id) {
  if (LINEC[id]) return LINEC[id];
  const by = new Map();
  for (const x of BY[id] || []) if (!x.meet && !x.exam) (by.get(x.c) || by.set(x.c, []).get(x.c)).push(x);
  const recent = NOWMS - 28 * DAYMS;
  return (LINEC[id] = [...by].map(([c, xs]) => {
    const now = xs.filter(x => past(x)).at(-1) || xs[0];
    const n4 = xs.filter(x => x.at >= recent && past(x) && !x.cancel).length;
    return {c, t:now.t, total:xs.filter(x => past(x) && !x.cancel).length, trialOnly:xs.every(x => x.trial), freq:n4 ? `最近 4 周 ${n4} 节` : '', first:xs[0].at};
  }).sort((a, b) => a.first - b.first));
}
const ck = (id, c) => `${id}~${c}`;
const valOf = (key, k = st.lm) => VALS[k]?.[key] || {};
const markField = () => FIELDS.find(f => f.type === 'select');
const textField = () => FIELDS.find(f => f.type === 'text');
const optColor = v => (markField()?.options.find(o => o[0] === v) || [])[1] || '';
const keyOf = x => x.cancel ? 'c' : 'gar'.includes(x.q) && x.q ? x.q : 'x';
const hasRep = x => !!x.q && 'gar'.includes(x.q);
// 某门课某个月：标记是人填的，其余从课表算
function stat(id, c, k) {
  const xs = lesOf(id, c).filter(x => x.d.startsWith(k) && past(x));
  if (!xs.length && !Object.keys(valOf(ck(id, c), k)).length) return null;
  return {xs, n:xs.filter(x => !x.cancel).length, cx:xs.filter(x => x.cancel).length, dots:xs.map(keyOf).join('')};
}
const nextOf = (id, c) => { const x = (BY[id] || []).find(y => y.c === c && !past(y) && !y.cancel); return x ? `${md(x.d)} ${wd(x.d)} ${x.s}` : ''; };
const unmarked = (id, c, k) => { const d = stat(id, c, k), mf = markField(); return !!(mf && d && (d.n || d.cx) && !valOf(ck(id, c), k)[mf.id]); };
const unmarkedOf = (id, k = NOW) => S[id]?.stage === '结课' ? 0 : linesOf(id).filter(l => unmarked(id, l.c, k)).length;

// ---------- 目标与成绩 ----------
function goalsOf(id) {
  const g = S[id]?.goals || {aim:'', rows:[]};
  return {aim:g.aim, rows:(g.rows || []).map(r => {
    const hs = GRADES.filter(x => x.sid === id && x.sub === r.sub).sort((a, b) => a.d.localeCompare(b.d));
    const last = hs.at(-1), when = examDate(r.date);
    return {...r, cur:last?.score || '', curSrc:last ? `${last.exam} ${md(last.d)}` : '', hist:hs.map(h => [h.exam, h.score, md(h.d)]), lastD:last?.d,
      days:when ? Math.round((dt(when) - dt(TODAY)) / DAYMS) : null, step:/雅思|IELTS/i.test(r.sub) ? 0.5 : 1};
  })};
}
/** 考试日期写法不固定：2026-11-18、2026/11/18、11/18 都认；「2027 年 5 月」这类不算天数 */
function examDate(s) {
  let m = String(s || '').match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return '';
  let d = `${TODAY.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (d < addDays(TODAY, -30)) d = `${+TODAY.slice(0, 4) + 1}${d.slice(4)}`;
  return d;
}
function gapOf(r) {
  if (!r.cur) return {t:'没有成绩', c:'sec', rank:2};
  const a = SCALE.indexOf(r.target.toUpperCase()), b = SCALE.indexOf(r.cur.toUpperCase());
  const d = a >= 0 && b >= 0 ? a - b : parseFloat(r.target) - parseFloat(r.cur);
  if (isNaN(d)) return {t:'—', c:'', rank:2};
  if (d <= 0) return {t:'已达到', c:'good', rank:3};
  return {t:`差 ${+d.toFixed(1)} ${a >= 0 ? '档' : '分'}`, c:d <= (r.step || 1) ? 'warn' : 'bad', rank:d <= (r.step || 1) ? 1 : 0};
}
const targetOf = (sid, sub) => goalsOf(sid).rows.find(r => r.sub === sub);

// ---------- 系统提醒：条件满足就出现，处理完自动消失 ----------
function sysTodos(id) {
  const s = S[id], out = [], mk = (t, why, due = TODAY, to, tab) => out.push({id:`sys-${t}-${id}`, s:id, t, type:'系统', owner:s.owner || '未分配', dueD:due, due:md(due), b:bucket(due), why, to, tab, at:TODAY, ms:NOWMS});
  if (!s || s.stage === '结课') return out;
  const n = unmarkedOf(id);
  if (n) mk(`${+NOW.slice(5)} 月还有 ${n} 门课没标记`, '', `${addMonth(NOW, 1)}-05`, 'review', 'months');
  for (const l of linesOf(id)) {
    const done = lesOf(id, l.c).filter(past);
    if (done.length >= 2 && done.slice(-2).every(x => x.cancel) && done.at(-1).at >= NOWMS - 21 * DAYMS) mk(`${l.c} 连续取消 2 次`, `最近一次 ${md(done.at(-1).d)}`);
  }
  for (const r of goalsOf(id).rows) {
    if (r.days != null && r.days >= 0 && r.days <= 30) mk(`安排${r.exam || r.sub}考前的课`, `离考试还有 ${r.days} 天`);
    if (r.lastD && r.lastD < addDays(TODAY, -60)) mk(`${r.sub}成绩 60 天没更新`, `上次是 ${md(r.lastD)} ${r.curSrc.split(' ')[0]}`);
  }
  for (const h of handoversOf(id)) mk(`${h.c} 交接卡还没确认`, `${h.to} ${md(h.first.d)} 开始上，之前是 ${h.from}`, h.first.d < TODAY ? TODAY : h.first.d, undefined, 'overview'), out.at(-1).ho = h.c;
  const trial = (BY[id] || []).find(x => x.trial && !past(x) && x.d <= addDays(TODAY, 2));
  const missing = PKEYS.filter(k => !s.persona?.[k]).length;
  if (trial && missing >= 2) mk(`学生画像缺 ${missing} 项`, `试听在 ${md(trial.d)}`);
  return out;
}
const flagsOf = id => sysTodos(id).filter(t => t.to !== 'review').slice(0, 2).map(t => [t.why.startsWith('离考试') ? t.why.replace('离考试还有', '考试还有') : t.t, t.t.includes('取消') ? 'bad' : 'warn']);
const todosOf = id => [...(staff() ? sysTodos(id) : []), ...TODOS.filter(t => t.s === id)];
const openTodos = id => todosOf(id).filter(t => !t.done).length;
const newest = (a, b) => (b.ms || 0) - (a.ms || 0);
function bucket(due) { return due < TODAY ? '逾期' : due === TODAY ? '今天' : due <= addDays(TODAY, 7) ? '本周' : '以后'; }

// 每节课的掌握情况也用带图形的小徽章，和状态徽章是同一套
const DOTI = {g:'ccheck', a:'calert', r:'tri', x:'cdash', c:'ban'}, DOTV = {g:'good', a:'warn', r:'bad', x:'none', c:'cx'};
const dot = k => `<span class="sbadge ${DOTV[k]} ico" title="${DOT[k]}">${ic(DOTI[k], 12)}</span>`;
const dots = s => s ? `<span class="dots">${[...s].map(dot).join('')}</span>` : '';
const MKI = {'':'cdash', sec:'circle', info:'circle', good:'ccheck', warn:'calert', bad:'tri'};
const cb = (v, c) => `<span class="sbadge ${c || 'sec'}">${ic(MKI[c || 'sec'], 12)}${esc(v)}</span>`;
const selw = (c, html) => `<span class="mark-w" data-c="${c}">${ic(MKI[c] || 'cdash', 13)}${html}</span>`;
const monthNav = (attr, k, min, max) => `<div class="month-nav"><button data-${attr}="-1" ${min && k <= min ? 'disabled' : ''} aria-label="上个月">${ic('left',14)}</button><b>${ml(k)}</b><button data-${attr}="1" ${max && k >= max ? 'disabled' : ''} aria-label="下个月">${ic('chev',14)}</button></div>`;
function toast(t) { const x = document.createElement('div'); x.className = 'toast'; x.textContent = t; document.body.appendChild(x); setTimeout(() => x.remove(), 2400); }

function go(p) {
  if (p.page || p.sid || p.tab) st.adding = false;
  Object.assign(st, p);
  render(); window.scrollTo(0, 0);
  if (st.page === 'profile' && st.sid && !DETAIL[st.sid]) loadStudent(st.sid).then(() => st.page === 'profile' && render()).catch(fail);
}

function render() {
  const out = ME.role === 'out';
  document.body.classList.toggle('teacher', !staff());
  document.body.classList.toggle('admin', ME.role === 'admin');
  document.body.classList.toggle('out', out);
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('on', b.dataset.go === st.page || (st.page === 'profile' && b.dataset.go === 'students')));
  $('#navStudents').lastChild.textContent = staff() ? '学员' : '我的学员';
  const urgent = staff() ? ORDER.flatMap(todosOf).filter(t => !t.done && (t.b === '逾期' || t.b === '今天')).length : 0;
  $('#fuCount').textContent = urgent || '';
  const n = ME.viewing ? ME.scheduleName : ME.name, r = ME.viewing ? '以老师身份查看' : ROLE_NAME[ME.role] || '';
  $('#acct').innerHTML = `<span class="avatar sq">${esc((n || '?')[0])}</span><span class="grow"><b>${esc(n)}</b><span>${esc(r)}</span></span>${ic('updown',16)}`;
  $('#acctMenu').innerHTML = [
    ME.viewing ? `<button data-viewas="">${ic('eye',14)}回到自己的视角</button>` : (staff() ? `<button data-pickview>${ic('eye',14)}以老师身份查看</button>` : ''),
    `<button data-logout>${ic('out',14)}退出登录</button>`].join('');
  const list = staff() ? '学员' : '我的学员';
  const crumbs = {schedule:['课表'], students:[list], followups:['跟进'], rec:['录课管理'], profile:[`<button data-go="students">${list}</button>`, esc(nm(st.sid))]}[st.page] || [];
  const coll = document.body.classList.contains('collapsed');
  $('#bar').innerHTML = out ? '' : `<button class="btn ghost icon" data-collapse aria-label="${coll ? '展开侧栏' : '收起侧栏'}" aria-expanded="${!coll}">${ic('panel',16)}</button><span class="vsep"></span><nav class="bc" aria-label="位置">${crumbs.map((c, i) => i === crumbs.length - 1 ? `<b>${c}</b>` : `${c}${ic('chev',14)}`).join('')}</nav>${ME.viewing ? `<span class="grow"></span><span class="viewing">${ic('eye',14)}正在以 ${esc(ME.scheduleName)} 的身份查看</span>` : ''}`;
  if (out) return void ($('#main').innerHTML = login());
  if (st.loading) return void ($('#main').innerHTML = `<div class="loading">${st.error ? esc(st.error) : '正在加载…'}</div>`);
  $('#main').innerHTML = ({schedule, students, profile, followups, rec})[st.page]();
}
function login() {
  return `<div class="card login"><span class="logo">菁</span><h2 style="margin:16px 0 24px;font-size:20px">菁仕工作台</h2>
    ${st.error ? `<p class="sm" style="margin:-8px 0 16px;color:var(--text-2)">${esc(st.error)}</p>` : ''}
    <a class="btn" style="width:100%" href="${API}/admin/login?to=workbench">用飞书登录</a></div>`;
}

/* ---------- 课表 ---------- */
const curT = () => staff() ? st.ct : MEN();
const schedXs = () => { const t = curT(); return LES.filter(x => x.d.startsWith(st.cm) && (t === '全部' ? !x.meet && !x.exam : x.t === t)); };
// 考试、模考和会议一样弱化成一行灰字，不算「没录」
const stOf = x => x.meet || x.exam ? 'meet' : x.cancel ? 'cx' : !past(x) ? 'up' : hasRep(x) ? 'ok' : x.q === 'p' ? 'proc' : 'no';
const ST_TXT = {ok:'有报告', no:'没录课', cx:'已取消', up:'还没上', proc:'整理中', meet:'会议'};
const ST_V = {ok:'good', no:'none', cx:'cx', up:'up', proc:'up'};
const CXT = {'0h-70%':'上课时才取消', '2h-50%':'课前 2 小时内取消', '6h-30%':'课前 6 小时内取消', '学生病假-0%':'学生病假', '提前取消-0%':'提前取消'};
const cxText = c => CXT[c] || c;

// 卡片两行：第一行时间和最要紧的名字，第二行课程和地点。老师名、结束时间这些重复的信息不上卡片，悬停能看到全部
function evCard(x, mode) {
  const s = stOf(x), names = x.stu.map(nm).join('、');
  const full = [`${md(x.d)} ${wd(x.d)} ${x.s}–${x.e}`, names, x.c, x.type, x.p, x.t, x.cancel ? cxText(x.cancel) : ST_TXT[s]].filter(Boolean).join('，');
  if (s === 'meet') return `<button class="ev meet" data-lid="${x.id}" title="${esc(full)}"><span class="l1"><span class="tnum">${x.s}</span> ${esc(x.exam && mode !== 'student' ? `${names} ${x.c}` : x.c)}</span></button>`;
  const l1 = mode === 'student' ? esc(x.c) : `<b>${esc(names)}</b>`;
  const l2 = [x.trial && '试听', mode === 'student' ? x.t : x.c, mode === 'all' && x.t, x.cancel ? cxText(x.cancel) : x.p, s === 'no' && '没录', s === 'proc' && '整理中'].filter(Boolean).join(' · ');
  return `<button class="ev ${s}" data-lid="${x.id}" title="${esc(full)}"><span class="l1">${ic(SBI[ST_V[s]], 12)}<span class="tnum">${x.s}</span> ${l1}</span><span class="l2">${esc(l2)}</span></button>`;
}
function calendar(xs, mode, cap) {
  const k = st.cm, first = k + '-01', last = iso(new Date(+k.slice(0, 4), +k.slice(5), 0));
  const end = addDays(last, (7 - dt(last).getDay()) % 7);
  let html = '';
  for (let d = addDays(first, -((dt(first).getDay() + 6) % 7)); d <= end; d = addDays(d, 1)) {
    const out = !d.startsWith(k), evs = out ? [] : xs.filter(x => x.d === d).sort((a, b) => a.s.localeCompare(b.s));
    const show = cap && evs.length > cap ? evs.slice(0, cap - 1) : evs;
    html += `<div class="day ${out ? 'out' : ''} ${d === TODAY ? 'today' : ''} ${evs.length ? '' : 'empty'}"><span class="num"><span class="dn">${+d.slice(8)}</span><span class="wd">${md(d)} ${wd(d)}</span></span>${show.map(x => evCard(x, mode)).join('')}${show.length < evs.length ? `<button class="more" data-day="${d}">还有 ${evs.length - show.length} 节</button>` : ''}</div>`;
  }
  return `<div class="cal">${[...'一二三四五六日'].map(w => `<div class="wk">周${w}</div>`).join('')}${html}</div>`;
}
const legend = () => `<div class="legend">${['ok','no','cx','up'].map(k => sb(ST_TXT[k], ST_V[k])).join('')}</div>`;
const sumOf = xs => { const p = xs.filter(x => !x.meet && !x.exam && past(x)); if (!xs.some(x => !x.meet && !x.exam)) return '这个月没有课'; return `已上 ${p.filter(x => !x.cancel).length} 节，取消 ${p.filter(x => x.cancel).length} 节，没录 ${p.filter(x => stOf(x) === 'no').length} 节`; };
const syncTitle = () => SYNCED ? `${shIso(SYNCED).slice(5, 10).replace('-', '/')} ${shIso(SYNCED).slice(11, 16)} 同步` : '';

function schedule() {
  const t = curT(), xs = schedXs();
  return `
  <div class="page-h"><h2>课表</h2><span class="grow"></span>
    <button class="btn ghost sm" data-sync title="${syncTitle()}">${ic('refresh',14)}刷新</button>
    ${staff() ? `<select class="input" id="ct" style="width:auto;height:32px" aria-label="老师"><option value="全部">全部老师</option>${TEACHERS.map(x => `<option ${x === t ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}
    <button class="btn outline sm" data-cmtoday>今天</button>
    ${monthNav('cmonth', st.cm, addMonth(NOW, -12), addMonth(NOW, 6))}
  </div>
  <div class="toolbar"><span class="muted">${LOADED.has(st.cm) ? sumOf(xs) : '正在加载这个月…'}</span><span class="grow"></span>${legend()}</div>
  ${calendar(xs, t === '全部' ? 'all' : 'mine', t === '全部' ? 3 : 0)}`;
}
function openDay(d) {
  dayCtx = d;
  const xs = schedXs().filter(x => x.d === d).sort((a, b) => a.s.localeCompare(b.s));
  showSheet(`
  <div class="sheet-h"><div class="grow"><h3>${md(d)} ${wd(d)}</h3><div class="sm muted">${xs.length} 节课</div></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
  <div class="sheet-b" style="display:grid;gap:6px">${xs.map(x => evCard(x, 'all')).join('')}</div>`);
}
// 单节课：给老师看的，帮他接上进度。完整版和家长看到的一样，在学情报告里
async function openLesson(id, back) {
  const x = LMAP.get(id);
  if (!x) return;
  const sid = x.stu[0];
  if (sid && !x.meet && !x.exam && !DETAIL[sid]) {
    showSheet(`<div class="sheet-h"><div class="grow"><h3>${esc(x.stu.map(nm).join('、'))} · ${esc(x.c)}</h3><p class="card-d">正在加载…</p></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>`);
    try { await loadStudent(sid); } catch (e) { return fail(e); }
    if (!$('#sheet').classList.contains('on')) return;
  }
  const s = stOf(x), inProfile = st.page === 'profile';
  const seq = x.meet || x.exam ? [] : LES.filter(y => y.c === x.c && y.stu.join() === x.stu.join());
  const k = seq.indexOf(x), prev = seq[k - 1], next = seq[k + 1];
  const last = seq.slice(0, k).reverse().find(y => REP[y.id]);
  const names = x.stu.map(i => inProfile || !S[i] ? esc(nm(i)) : `<a href="#" class="ul" data-sid="${esc(i)}">${esc(nm(i))}</a>`).join('、');
  const row = (t, v) => v ? `<dt>${t}</dt><dd>${v}</dd>` : '';
  const kps = r => r.kps.map(([k, v]) => v === '已掌握' ? esc(k) : `<span class="weak">${esc(k)}</span>`).join('、');
  const weakOf = r => r.kps.filter(k => k[1] !== '已掌握').map(k => esc(k[0])).join('、');
  const r = REP[x.id];
  let body = '', foot = '';
  if (s === 'meet') body = `<p class="muted">${x.exam ? '考试' : '会议'}，没有学情。</p>`;
  else if (s === 'cx') body = `<dl class="dl2">${row('取消', `${esc(cxText(x.cancel))}<span class="muted">（${esc(x.cancel)}）</span>`)}</dl>`;
  else if (!r) body = (s === 'proc' ? '<p class="muted">录音正在整理，报告出来后在这里显示。</p>' : '') + (last ? `<div class="blk"><h4>上节课 ${md(last.d)} · ${esc(REP[last.id].topic)}</h4><dl class="dl2">
      ${row('要巩固', weakOf(REP[last.id]) || '没有')}${row('布置作业', esc(REP[last.id].hw))}${row('这节先做', esc(REP[last.id].next))}</dl></div>` : x.stu.map(firstBlk).join(''));
  else {
    body = `<dl class="dl2">
      ${row('上节作业', last && `${esc(REP[last.id].hw)}<span class="muted"> · ${md(last.d)}</span>`)}
      ${row('讲了', esc(r.topic))}
      ${row('知识点', kps(r))}
      ${row('课堂表现', r.perf && esc(r.perf))}
      ${row('易错点', r.issue && esc(r.issue))}
      ${row('主动提问', r.qs.length && r.qs.map(esc).join('<br>'))}
      ${row('布置作业', esc(r.hw))}
      ${row('下节课', esc(r.next))}</dl>`;
    foot = `<div class="sheet-foot">${r.url ? `<a class="btn outline sm" href="${esc(r.url)}" target="_blank" rel="noopener">打开学情报告${ic('ext',14)}</a>` : ''}<button class="btn sm" data-copy="${x.id}">${ic('copy',14)}复制家长总结</button></div>`;
  }
  // 自己的课还没上，或者今天的课还没开始录：可以去飞书提取消或调课的审批
  if (s !== 'meet' && !x.cancel && x.t === MEN() && (!past(x) || (x.d === TODAY && !x.q)))
    foot = `<div class="sheet-foot"><a class="btn outline sm" href="${FEISHU_CHANGE}" target="_blank" rel="noopener">取消或调课${ic('ext',14)}</a></div>`;
  const nav = seq.length ? `<div class="pager"><button class="btn ghost sm" ${prev ? `data-lid="${prev.id}" title="${md(prev.d)}"` : 'disabled'} aria-label="上一节">${ic('left',14)}</button><button class="btn ghost sm" ${next ? `data-lid="${next.id}" title="${md(next.d)}"` : 'disabled'} aria-label="下一节">${ic('chev',14)}</button></div>` : '';
  const ho = sid && handoversOf(sid).find(h => h.c === x.c && h.to === x.t && (x === h.first || !past(x)));
  if (ho) body = handoverBlk(sid, ho) + body;
  showSheet(`
  ${back ? `<button class="btn ghost xs" style="margin:16px 0 0 18px" data-day="${back}">${ic('left',14)}${md(back)} 全部课程</button>` : ''}
  <div class="sheet-h"><div class="grow">
    <h3>${x.meet ? esc(x.c) : `${names} · ${esc(x.c)}`}</h3>
    <p class="card-d">${md(x.d)} ${wd(x.d)} ${x.s}–${x.e}${x.p ? ` · ${esc(x.p)}` : ''}${x.type ? ` · ${esc(x.type)}` : ''}${x.trial ? ' · 试听' : ''}</p>
    ${s === 'meet' ? '' : `<div class="row" style="margin-top:6px">${sb(ST_TXT[s], ST_V[s])}<span class="muted">${esc(x.t)}</span></div>`}
  </div>${nav}<button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
  <div class="sheet-b">${body}${foot}</div>`);
}
// 第一次给这个学生上课：直接把目标和画像放进来，不用再点进档案
function firstBlk(id) {
  const P = S[id]?.persona || {}, has = PKEYS.filter(k => P[k]), g = goalsOf(id).rows;
  return `<div class="blk"><h4>第一次给${esc(nm(id))}上课</h4><dl class="dl2">
      ${g.length ? `<dt>目标</dt><dd>${g.map(r => `${esc(r.sub)} ${esc(r.target)}${r.exam ? `，${esc(r.exam)} ${esc(r.date)}` : ''}`).join('；')}</dd>` : ''}
      ${has.map(k => `<dt>${k}</dt><dd>${P[k].tags.map(esc).join(' · ')}${P[k].text ? `<div class="muted">${esc(P[k].text)}</div>` : ''}</dd>`).join('')}
      ${has.length < 4 ? `<dt>待补充</dt><dd class="muted">${PKEYS.filter(k => !P[k]).join('、')}</dd>` : ''}
    </dl>
    ${S[id] ? `<button class="btn outline xs" style="margin-top:10px" data-sid="${esc(id)}">看档案</button>` : ''}</div>`;
}
function parentText(x) {
  const r = REP[x.id];
  if (r.sum) return r.sum;
  const ok = r.kps.filter(k => k[1] === '已掌握').map(k => k[0]), weak = r.kps.filter(k => k[1] !== '已掌握').map(k => k[0]);
  return [`${x.stu.map(nm).join('、')} ${md(x.d)} ${x.c}`, `今天学了${r.topic}。`, ok.length && `掌握得好：${ok.join('、')}。`, weak.length && `还要巩固：${weak.join('、')}。`, r.hw && `作业：${r.hw}。`].filter(Boolean).join('\n');
}

/* ---------- 学员 ---------- */
function cell(f, key, k = st.lm) {
  const v = valOf(key, k)[f.id] || '', fk = `${key}|${f.id}|${k}`;
  if (f.type === 'select') {
    const c = (f.options.find(o => o[0] === v) || [])[1] || '';
    return staff()
      ? selw(c, `<select class="mark" data-fv="${esc(fk)}" data-c="${c}" aria-label="${esc(f.name)}"><option value="">未标</option>${f.options.map(([o]) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`)
      : v ? cb(v, c) : '<span class="muted">—</span>';
  }
  if (!staff()) return v ? esc(v) : '<span class="muted">—</span>';
  return `<input class="note-in" ${f.type === 'date' ? 'type="date"' : ''} data-fv="${esc(fk)}" value="${esc(v)}" placeholder="${f.type === 'text' ? '写' + esc(f.name) : ''}" aria-label="${esc(f.name)}">`;
}
const short = sub => sub.replace(/^(A-Level|Alevel|IG|AP) ?/, '');
// 这个月有课的那几门（当月翻到本月时，排好还没上的也算）；老师只看自己上的课。筛选按科目：只显示符合条件的那几门
const ownX = x => staff() || x.t === MEN();
function rowsOf(id) {
  const mf = markField();
  return linesOf(id).filter(l => lesOf(id, l.c).some(x => ownX(x) && (x.d.startsWith(st.lm) || (st.lm === NOW && !past(x))))).map(l => ({l, key:ck(id, l.c)})).filter(({l, key}) =>
    !st.mf || !mf || (st.mf === '未标' ? unmarked(id, l.c, st.lm) : valOf(key)[mf.id] === st.mf));
}
function listIds() {
  const q = st.q.trim().toLowerCase();
  return ORDER.filter(id => {
    const s = S[id], hay = [s.name, s.school, ...linesOf(id).flatMap(l => [l.c, l.t])].join(' ').toLowerCase();
    return (st.stage === '全部' || s.stage === st.stage) && (!st.mf || rowsOf(id).length) && (!q || hay.includes(q));
  });
}
const visibleKeys = () => listIds().flatMap(id => rowsOf(id).map(r => r.key));
function bulkBar() {
  const n = st.sel.size, mf = markField(), tf = textField();
  if (!n || !staff()) return '';
  const input = st.bulk === 'note' ? `<input class="input" id="bulkIn" style="width:260px" placeholder="给 ${n} 门课写${esc(tf.name)}，会覆盖原来的">`
    : st.bulk === 'todo' ? `<input class="input" id="bulkIn" style="width:200px" placeholder="跟进内容，每个学生一条"><input class="input" type="date" id="bulkDue" value="${addDays(TODAY, 2)}">` : '';
  return `<div class="bulk" role="toolbar" aria-label="批量操作">
    <b>已选 ${n} 门课</b><span class="vr"></span>
    ${mf ? `<select class="input" id="bulkMark" aria-label="批量设${esc(mf.name)}"><option value="">设${esc(mf.name)}</option>${mf.options.map(([o]) => `<option>${esc(o)}</option>`).join('')}</select>` : ''}
    ${tf ? `<button class="btn ghost xs" data-bulk="note">写${esc(tf.name)}</button>` : ''}
    <button class="btn ghost xs" data-bulk="todo">建跟进</button>
    <button class="btn ghost xs" data-export>导出</button>
    ${input ? `<span class="vr"></span>${input}<button class="btn outline xs" data-bulkok>确定</button>` : ''}
    <button class="btn ghost xs" data-clearsel aria-label="取消选择">${ic('x',14)}</button>
  </div>`;
}
// 这个月没课的学生：老师看到自己上次给他上的是哪门、哪天；教务看到最后一节课
function idleText(id) {
  const x = (BY[id] || []).filter(y => ownX(y) && !y.meet && !y.exam && past(y) && !y.cancel).at(-1);
  return x ? `上次 ${md(x.d)} ${esc(x.c)}${staff() ? ` · ${esc(x.t)}` : ''}` : S[id].stage === '结课' ? '—' : '还没排课';
}
function goalBadgeFor(id, c) { const g = targetOf(id, c), x = g && gapOf(g); return x ? sb(x.t, x.c) : '<span class="muted">—</span>'; }

function students() {
  const k = st.lm, pk = MONTHS[MONTHS.indexOf(k) - 1], mf = markField();
  const all = ORDER, ids = listIds(), keys = visibleKeys();
  const stages = ['全部', ...STAGES];
  const allOn = keys.length && keys.every(x => st.sel.has(x));
  const left = all.reduce((a, id) => a + unmarkedOf(id, k), 0);
  const F = staff() ? FIELDS : [], ncol = 4 + F.length; // 标记和备注是教务自己用的，老师看不到
  const on = ids.filter(id => rowsOf(id).length), off = ids.filter(id => !rowsOf(id).length);
  return `
  <div class="page-h"><h2>${staff() ? '学员' : '我的学员'}</h2><span class="grow"></span>
    ${pk ? '<button class="btn ghost sm staff-only" data-copyprev>沿用上月</button>' : ''}
    ${monthNav('lmonth', k, MONTHS[0], MONTHS.at(-1))}
    <button class="btn sm staff-only" data-new>${ic('plus',14)}新建学员</button>
  </div>
  <div class="toolbar">
    <div class="tabs">${stages.map(t => `<button class="tab ${st.stage === t ? 'on' : ''}" data-stage="${t}">${t}<span class="n">${t === '全部' ? all.length : all.filter(id => S[id].stage === t).length}</span></button>`).join('')}</div>
    ${mf && staff() ? `<select class="input" id="mf" style="width:auto;height:32px" aria-label="按${esc(mf.name)}筛选"><option value="">全部${esc(mf.name)}</option>${mf.options.map(([o]) => `<option ${st.mf === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}<option ${st.mf === '未标' ? 'selected' : ''}>未标</option></select>` : ''}
    <span class="grow"></span>
    <div class="search">${ic('search',14)}<input class="input" id="q" value="${esc(st.q)}" placeholder="搜索" aria-label="搜姓名、学校、课程、老师"></div>
  </div>
  <div class="table-wrap"><table class="stu">
    <thead><tr><th class="staff-only" style="width:40px"><button class="check ${allOn ? 'on' : ''}" data-pickall aria-label="全选"></button></th><th class="who-col">学员</th>${st.stage === '全部' ? '<th>阶段</th>' : ''}<th>课程</th><th>目标</th><th>本月</th>${F.map(f => `<th ${f.type === 'text' ? 'class="note-col"' : ''}>${esc(f.name)}</th>`).join('')}
      <th class="staff-only" style="width:44px;padding:0 6px"><button class="btn ghost xs" data-fields title="列设置" aria-label="列设置">${ic('cols',14)}</button></th></tr></thead>
    <tbody>${[...on, ...off].map((id, i) => {
      const s = S[id], rows = rowsOf(id), n = Math.max(rows.length, 1), rs = n > 1 ? ` rowspan="${n}"` : '';
      const stage = staff() ? `<select class="stage-in" data-stageof="${esc(id)}" aria-label="${esc(s.name)}的阶段">${STAGES.map(k => `<option ${k === s.stage ? 'selected' : ''}>${k}</option>`).join('')}</select>` : esc(s.stage);
      const head = `<td class="who-col"${rs}><a class="who link" data-sid="${esc(id)}"><span class="avatar">${esc(s.name[0] || '?')}</span><div><b>${esc(s.name)}</b><span class="muted sm">${esc([s.school, s.grade].filter(Boolean).join(' · ') || '—')}</span></div></a></td>${st.stage === '全部' ? `<td class="sub2"${rs}>${stage}</td>` : ''}`;
      const sep = i === on.length ? `<tr class="off-h"><td colspan="${ncol + 3}">${+st.lm.slice(5)} 月没有${staff() ? '' : '你的'}课<span class="n">${off.length}</span></td></tr>` : '';
      if (!rows.length) return sep + `<tr class="grp idle"><td class="staff-only"></td>${head}<td colspan="${ncol - 1}" class="muted">${idleText(id)}</td><td class="staff-only"></td></tr>`;
      return rows.map(({l, key}, j) => {
        const d = stat(id, l.c, k) || {n:0, cx:0};
        return `<tr class="${j ? 'cont' : 'grp'} ${st.sel.has(key) ? 'sel' : ''}">
          <td class="staff-only"><button class="check ${st.sel.has(key) ? 'on' : ''}" data-pick="${esc(key)}" aria-label="选择${esc(s.name)}${esc(l.c)}"></button></td>
          ${j ? '' : head}
          <td class="nowrap"><span class="strong">${esc(l.c)}</span>${staff() ? ` <span class="sub2">· ${esc(l.t)}</span>` : ''}</td>
          <td>${goalBadgeFor(id, l.c)}</td>
          <td class="tnum">${d.n} 节${d.cx ? ` <span class="muted">· 取消 ${d.cx}</span>` : ''}</td>
          ${F.map(f => `<td ${f.type === 'text' ? 'class="note-col"' : ''}>${cell(f, key)}</td>`).join('')}<td class="staff-only"></td>
        </tr>`; }).join(''); }).join('') || `<tr><td colspan="${ncol + 4}" class="empty-row">${ORDER.length ? '没有符合条件的学员' : '最近 90 天没有给学生上过课'}</td></tr>`}</tbody>
  </table>
  <div class="table-foot"><span>${staff() && st.sel.size ? `已选 ${st.sel.size} 门课，` : ''}共 ${ids.length} 人 ${keys.length} 门课</span><span class="grow"></span>${staff() && mf ? `<span>${+k.slice(5)} 月还有 ${left} 门课没${esc(mf.name)}</span>${st.mf === '未标' ? '' : '<button class="btn ghost xs" data-mfset="未标">只看未标</button>'}` : ''}</div></div>
  ${bulkBar()}`;
}
function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['姓名','阶段','课程','老师', ...FIELDS.map(f => f.name)], ...[...st.sel].map(key => { const [id, c] = splitKey(key), l = linesOf(id).find(x => x.c === c) || {}; return [nm(id), S[id]?.stage, c, l.t, ...FIELDS.map(f => valOf(key)[f.id])]; })];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], {type:'text/csv'}));
  a.download = `学员-${st.lm}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
const splitKey = key => { const i = key.indexOf('~'); return [key.slice(0, i), key.slice(i + 1)]; };
/** 改标记：先改页面，再存；存失败提示并按服务器重新加载 */
function setVals(k, items) {
  for (const {key, field, value} of items) { const v = ((VALS[k] ||= {})[key] ||= {}); if (value) v[field] = value; else delete v[field]; }
  send('/wb/marks', 'PUT', {month:k, items:items.map(({key, field, value}) => { const [student, course] = splitKey(key); return {student, course, field, value}; })}).catch(e => { fail(e); reboot(); });
}
const saveFields = () => send('/wb/fields', 'PUT', {fields:FIELDS}).catch(e => { fail(e); reboot(); });
/* ---------- 列设置 ---------- */
function openFields() {
  const colorSel = id => `<select class="input" id="${id}" style="width:72px;height:32px" aria-label="颜色">${Object.entries(COLORS).map(([c, t]) => `<option value="${c}">${t}</option>`).join('')}</select>`;
  showSheet(`
  <div class="sheet-h"><div class="grow"><h3>编辑列</h3></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
  <div class="sheet-b">
    ${FIELDS.map(f => `<div class="fld">
      <div class="row"><input class="input" style="height:32px" data-fname="${f.id}" value="${esc(f.name)}" aria-label="列名">${badge(FTYPE[f.type], 'sec')}<button class="btn ghost xs" data-delfield="${f.id}" aria-label="删除这一列">${ic('x',14)}</button></div>
      ${f.type === 'select' ? `<div class="opts">${f.options.map(([o, c], i) => `<div class="row">${cb(o, c)}<span class="grow"></span><button class="btn ghost xs" data-delopt="${f.id}|${i}" aria-label="删除选项">${ic('x',12)}</button></div>`).join('')}</div>
        <div class="row"><input class="input" style="height:32px" id="opt-${f.id}" placeholder="新选项">${colorSel('optc-' + f.id)}<button class="btn outline sm" data-addopt="${f.id}">添加</button></div>` : ''}
    </div>`).join('')}
    <h4>添加列</h4>
    <div class="row"><input class="input" style="height:32px" id="newField" placeholder="列名，比如「续费意向」">
      <select class="input" id="newType" style="width:80px;height:32px" aria-label="类型">${Object.entries(FTYPE).map(([t, l]) => `<option value="${t}">${l}</option>`).join('')}</select>
      <button class="btn sm" data-addfield>添加</button></div>
  </div>`);
}

/* ---------- 档案 ---------- */
async function loadStudent(sid) {
  const d = await api(`/wb/students/${encodeURIComponent(sid)}`);
  Object.assign(REP, d.reps);
  addLessons(d.lessons, d.students);
  for (const m of d.marks) ((VALS[m.month] ||= {})[ck(sid, m.course)] ||= {})[m.field] = m.value;
  DETAIL[sid] = d;
  if (d.needSuggest) send('/wb/suggest', 'POST', {student:sid}).then(r => { d.sugg = r.items; d.needSuggest = false; if (st.page === 'profile' && st.sid === sid) render(); }).catch(() => {});
  return d;
}
function profile() {
  const s = S[st.sid];
  if (!s) return '<div class="loading">没有找到这个学生</div>';
  const n = staff() ? openTodos(st.sid) : 0;
  const tabs = [['overview','概览'],['lessons','课程与学情'],['months','月度记录'],['grades','成绩'],['info','资料'],['todo','跟进']];
  const since = s.created ? `${shIso(s.created).slice(0, 4)} 年 ${+shIso(s.created).slice(5, 7)} 月建档` : '';
  return `
  <div class="prof-h">
    <span class="avatar lg">${esc(s.name[0] || '?')}</span>
    <div class="grow">
      <h2>${esc(s.name)}${badge(s.stage, 'outline')}${flagsOf(st.sid).map(f => sb(f[0], f[1])).join('')}</h2>
      <div class="meta">${esc([s.school, s.grade, s.system, since].filter(Boolean).join(' · ') || '—')}${s.owner ? `<span class="staff-only"> · 教务${esc(s.owner)}</span>` : ''}</div>
    </div>
    <label class="staff-only row">阶段<select class="input" id="stageSet" style="width:auto;height:32px">${Object.keys(STAGE).map(k => `<option ${k === s.stage ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
  </div>
  <div class="tabs ptabs">${tabs.map(([k, l]) => `<button class="tab ${st.tab === k ? 'on' : ''} ${k === 'todo' ? 'staff-only' : ''}" data-ptab="${k}">${l}${k === 'todo' && n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
  ${DETAIL[st.sid] || st.tab === 'info' || st.tab === 'todo' ? ({overview, lessons, months, grades, info, todo})[st.tab](s) : '<div class="loading">正在加载…</div>'}`;
}
function overview(s) {
  const id = st.sid, g = goalsOf(id), P = s.persona || {}, sugg = DETAIL[id]?.sugg || [];
  // 学习进度只放还在上的课：最近 60 天上过或已经排了；都停了就放最后上的那门
  const all = linesOf(id), active = all.filter(l => lesOf(id, l.c).some(x => x.at >= NOWMS - 60 * DAYMS));
  const hos = handoversOf(id);
  const lines = active.length ? active : all.slice().sort((a, b) => lesOf(id, b.c).at(-1).at - lesOf(id, a.c).at(-1).at).slice(0, 1);
  const missing = PKEYS.filter(k => !P[k]).length;
  const cards = lines.map(l => {
    const d = stat(id, l.c, NOW) || {n:0, cx:0}, xs = lesOf(id, l.c).filter(past), last = [...xs].reverse().find(x => REP[x.id]), nx = nextOf(id, l.c);
    const mv = valOf(ck(id, l.c), NOW)[markField()?.id];
    if (l.trialOnly) return `
    <div class="card">
      <div class="card-h"><div class="grow"><h3>${esc(l.c)}</h3><p class="card-d">${esc(l.t)}</p></div>${sb('试听', 'info')}</div>
      <div class="card-b"><dl class="dl2"><dt>试听</dt><dd>${nx || (xs.length ? `${md(xs.at(-1).d)} 已上` : '还没排')}</dd></dl></div>
      <div class="card-f"><button class="btn outline sm" data-edit>填写试听反馈</button></div>
    </div>`;
    const stuck = last && REP[last.id].issue;
    return `
    <div class="card">
      <div class="card-h"><div class="grow"><h3>${esc(l.c)}</h3><p class="card-d">${esc([l.t, l.freq].filter(Boolean).join(' · '))}</p></div>${hos.some(h => h.c === l.c) ? `<button class="btn outline xs" data-showho="${esc(id)}|${esc(l.c)}">${ic('calert',12)}交接卡没确认</button>` : ''}${mv ? cb(`${+NOW.slice(5)} 月 ${mv}`, optColor(mv)) : ''}</div>
      <div class="card-b"><dl class="dl2">
        <dt>正在学</dt><dd>${last ? esc(REP[last.id].topic) : '<span class="muted">还没有报告</span>'}</dd>
        ${last && REP[last.id].hw ? `<dt>上次作业</dt><dd>${esc(REP[last.id].hw)}</dd>` : ''}
        <dt>下节课</dt><dd>${nx || (s.stage === '在读' ? sb('没有排课', 'bad') : '<span class="muted">没有排课</span>')}</dd>
        ${stuck ? `<dt>卡点</dt><dd>${esc(stuck)}</dd>` : ''}
      </dl></div>
      ${xs.length ? `<div class="card-f"><div class="recent">${xs.slice(-6).map(x => `<button data-lid="${x.id}" title="${md(x.d)} ${DOT[keyOf(x)]}">${dot(keyOf(x))}${md(x.d)}</button>`).join('')}</div><span class="grow"></span><span class="muted tnum">本月 ${d.n} 节${d.cx ? `，取消 ${d.cx}` : ''}</span></div>` : ''}
    </div>`;
  }).join('');
  return `
  <div class="card">
    <div class="card-h"><div class="grow"><h3>目标与达成</h3>${g.aim ? `<p class="card-d">${esc(g.aim)}</p>` : ''}</div>${g.rows.length ? '<button class="btn outline sm" data-edit>编辑</button>' : ''}</div>
    <div class="card-b">${!g.rows.length ? '<p class="muted" style="margin:0 0 12px">还没有目标</p><button class="btn outline sm" data-edit>添加目标</button>' : `<div class="table-wrap"><table>
      <thead><tr><th>科目</th><th>目标</th><th>最近成绩</th><th>差距</th><th>下次考试</th><th>历次成绩</th></tr></thead>
      <tbody>${g.rows.map(r => { const x = gapOf(r); return `<tr>
        <td class="strong">${esc(r.sub)}</td>
        <td class="strong">${esc(r.target)}</td>
        <td>${r.cur ? `<span class="strong">${esc(r.cur)}</span> <span class="muted">${esc(r.curSrc)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${sb(x.t, x.c)}</td>
        <td>${r.exam || r.date ? `${esc(r.exam)} ${esc(r.date)}${r.days != null && r.days >= 0 && r.days <= 30 ? ` <span class="muted">· ${r.days} 天</span>` : ''}` : '<span class="muted">—</span>'}</td>
        <td>${r.hist.length ? `<div class="hist">${r.hist.map(([n, v, d]) => `<span title="${esc(n)}"><b>${esc(v)}</b>${d}</span>`).join('')}</div>`
          : '<button class="btn outline xs" data-addgrade>添加成绩</button>'}</td>
      </tr>`; }).join('')}</tbody></table></div>`}</div>
  </div>
  <h3 class="sec-title">学习进度</h3>
  ${cards ? `<div class="prog-grid">${cards}</div>` : '<div class="card"><div class="card-b muted">还没有排课，在飞书课表排上课后自动出现。</div></div>'}
  <div class="card" style="margin-top:24px">
    <div class="card-h"><div class="grow"><h3>学生画像</h3>${missing ? `<p class="card-d">缺 ${missing} 项</p>` : ''}</div>
      ${missing ? `<button class="btn outline sm" data-sendform="${esc(id)}">发收集表给家长</button>` : ''}<button class="btn ${missing ? '' : 'outline'} sm" data-edit>${missing ? '填写' : '编辑'}</button></div>
    <div class="card-b flush"><div class="persona">${PKEYS.map(k => { const v = P[k], sg = sugg.filter(x => x.key === k); return `<div>
      <h4 title="${v?.src ? esc(v.src) : ''}">${k}</h4>
      ${v ? `${v.tags.length ? `<div class="tags">${v.tags.map(t => badge(t, 'sec')).join('')}</div>` : ''}${v.text ? `<p>${esc(v.text)}</p>` : ''}` : `<p class="muted" title="${PRESET[k].ask}">待补充</p>`}
      ${sg.map(x => `<div class="sugg">${ic('spark',16)}<span class="grow"><b>AI 建议加「${esc(x.tag)}」</b><span class="muted">${esc(x.why)}</span></span><button class="btn outline xs" data-acc="${x._id}">采纳</button><button class="btn ghost xs" data-ign="${x._id}">忽略</button></div>`).join('')}
    </div>`; }).join('')}</div></div>
  </div>`;
}
function lessons() {
  const id = st.sid, lines = linesOf(id);
  const xs = LES.filter(x => x.stu.includes(id) && x.d.startsWith(st.cm) && (st.course === '全部' || x.c === st.course));
  return `
  <div class="toolbar">
    ${lines.length > 1 ? `<div class="tabs">${['全部', ...lines.map(l => l.c)].map(c => `<button class="tab ${st.course === c ? 'on' : ''}" data-course="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <span class="muted">${sumOf(xs)}</span><span class="grow"></span>
    ${monthNav('cmonth', st.cm, addMonth(NOW, -12), addMonth(NOW, 6))}
  </div>
  ${calendar(xs, 'student', 0).replace('class="cal"', 'class="cal compact"')}
  <div class="toolbar" style="margin-top:12px"><span class="grow"></span>${legend()}</div>`;
}
// 月报：每个学生每门课每个月一份，第一次打开时让大模型把当月每节课的报告浓缩成四块，存起来；老师可以改
const monthlyOf = (id, c, k) => DETAIL[id]?.monthly.find(m => m.course === c && m.month === k);
const GEN = new Set();
function needMonthly(id, c, k, d) {
  const m = monthlyOf(id, c, k), basis = d.xs.filter(hasRep).map(x => x.id).sort().join(',');
  return !m || (m.basis !== basis && !m.editedBy && k < NOW);
}
function genMonthly(id, c, k, force) {
  const key = `${id}|${c}|${k}`;
  if (GEN.has(key)) return;
  GEN.add(key);
  send('/wb/monthly', 'POST', {student:id, course:c, month:k, force:!!force}).then(row => {
    const list = DETAIL[id].monthly, i = list.findIndex(m => m.course === c && m.month === k);
    if (i >= 0) list[i] = row; else list.push(row);
    if (force) toast('已按最新的课堂报告重新生成');
  }).catch(e => { DETAIL[id].monthly.push({course:c, month:k, error:e.message}); }).finally(() => { GEN.delete(key); if (st.page === 'profile' && st.sid === id && st.tab === 'months') render(); });
}
function months() {
  const id = st.sid, lines = linesOf(id);
  const miles = [...DETAIL[id].miles.map(m => ({...m, d:m.date, c:m.course})), ...GRADES.filter(g => g.sid === id).map(gradeMile)];
  const keys = [...new Set([...MONTHS, ...LES.filter(x => x.stu.includes(id) && x.d.slice(0, 7) < NOW).map(x => x.d.slice(0, 7))])].sort()
    .filter(k => lines.some(l => stat(id, l.c, k)) || miles.some(m => m.d.startsWith(k))).reverse();
  const html = keys.map(k => {
    const rows = lines.map(l => ({l, d:stat(id, l.c, k)})).filter(x => x.d);
    const n = rows.reduce((a, x) => a + x.d.n, 0), cx = rows.reduce((a, x) => a + x.d.cx, 0);
    const ms = miles.filter(m => m.d.startsWith(k)).sort((a, b) => b.d.localeCompare(a.d));
    return `<section class="month">
    <div class="month-h"><h3>${ml(k)}</h3><span class="muted tnum">${n} 节${cx ? `，取消 ${cx} 节` : ''}</span><span class="grow"></span><button class="btn outline sm" data-addmile="${k}">${ic('plus',14)}里程碑</button></div>
    ${ms.length ? `<div class="card"><div class="card-h"><div class="grow"><h3>里程碑</h3></div></div><div class="card-b miles">${ms.map(mileRow).join('')}</div></div>` : ''}
    ${rows.map(({l, d}) => courseRep(id, l, k, d)).join('')}</section>`;
  }).join('');
  return keys.length ? html : '<div class="card"><div class="card-b muted">第一节课上完后开始有月度记录。</div></div>';
}
function mileRow(m) {
  const files = (m.files || []).map(f => `<button class="fchip" data-file="${esc(f.key)}" title="${esc(f.name)}">${ic(f.img ? 'img' : 'file', 14)}</button>`).join('');
  return `<div class="mrow"><span class="muted tnum">${md(m.d)}</span>
    <div><b>${m.c ? esc(short(m.c)) + ' · ' : ''}${esc(m.title)}</b>${m.grade ? badge('成绩', 'sec') : ''}${m.text ? `<div class="muted">${esc(m.text)}</div>` : ''}</div>
    <span class="mmeta">${files}<span class="muted">${esc(m.by)}</span></span></div>`;
}
function gradeMile(g) {
  const prev = GRADES.filter(x => x.sid === g.sid && x.sub === g.sub && x.d < g.d).sort((a, b) => b.d.localeCompare(a.d))[0];
  const tg = targetOf(g.sid, g.sub), gap = tg && gapOf({...tg, cur:g.score});
  return {d:g.d, c:g.sub, title:`${g.exam} ${g.score}`, text:[prev && `上次${prev.exam} ${prev.score}`, gap && gap.t !== '—' && `目标 ${tg.target}，${gap.t}`].filter(Boolean).join('，'), by:g.by, files:g.file ? [g.file] : [], grade:true};
}
function courseRep(id, l, k, d) {
  const ek = `${id}|${l.c}|${k}`, mine_ = staff() || d.xs.some(x => x.t === MEN());
  const head = (desc, extra) => `<div class="card-h"><div class="grow"><h3>${esc(l.c)}</h3><p class="card-d">${esc(l.t)} · ${desc}</p></div>${extra}</div>`;
  const foot = FIELDS.length && staff() ? `<div class="card-f judge">${FIELDS.map(f => `<span class="sub2">${esc(f.name)}</span>${cell(f, ck(id, l.c), k)}`).join('')}</div>` : '';
  const cnt = `${d.n} 节${d.cx ? `，取消 ${d.cx}` : ''}`;
  if (!d.n) return `<div class="card">${head(d.cx ? `取消 ${d.cx} 节` : '还没上课', '')}${d.cx ? foot : ''}</div>`;
  if (!d.xs.some(hasRep)) return `<div class="card">${head(cnt, sb('都没录，生成不了月报', 'none'))}${foot}</div>`;
  if (needMonthly(id, l.c, k, d) && !monthlyOf(id, l.c, k)?.error) genMonthly(id, l.c, k);
  const m = monthlyOf(id, l.c, k);
  if (!m || m.error || GEN.has(ek)) return `<div class="card">${head(`${cnt} ${dots(d.dots)}`, '')}<div class="card-b muted">${m?.error ? esc(m.error) : '正在生成月报…'}</div>${foot}</div>`;
  const r = m.rep, lastRep = [...d.xs].reverse().find(hasRep);
  const stale = m.basis !== d.xs.filter(hasRep).map(x => x.id).sort().join(',');
  const by = m.editedBy ? `${m.editedBy}改过` : (k === NOW && lastRep ? `截至 ${md(lastRep.d)}` : '');
  const list = (xs, v) => xs.length ? `<div class="tags">${xs.map(t => badge(t, v)).join('')}</div>` : '<span class="muted">没有</span>';
  const menu = mine_ ? `<span class="mwrap"><button class="btn ghost icon" data-menu aria-label="更多">${ic('more',16)}</button><span class="menu"><button data-editrep="${esc(ek)}">编辑月报</button>${k === NOW || stale ? `<button data-regen="${esc(ek)}">按最新报告重新生成</button>` : ''}</span></span>` : '';
  return `<div class="card">
    ${head(`${cnt} ${dots(d.dots)}`, `<span class="ai-tag" title="AI 生成${by ? '，' + by : ''}">${ic('spark',12)}AI${by ? ' · ' + esc(by) : ''}</span><a class="btn outline sm" href="#month/${encodeURIComponent(id)}/${encodeURIComponent(l.c)}/${k}" target="_blank" rel="noopener">完整月报${ic('ext',14)}</a>${menu}`)}
    <div class="card-b"><dl class="rep4"><dt>本月讲了</dt><dd>${esc(r.sum)}</dd><dt>掌握得好</dt><dd>${list(r.good, 'good')}</dd><dt>还要巩固</dt><dd>${list(r.weak, 'warn')}</dd><dt>下月建议</dt><dd>${esc(r.adv)}</dd></dl></div>
    ${foot}
  </div>`;
}
function openRepEdit(ek) {
  const [id, c, k] = ek.split('|'), r = monthlyOf(id, c, k).rep;
  showSheet(`
  <div class="sheet-h"><div class="grow"><h3>编辑月报</h3><p class="card-d">${esc(nm(id))} · ${esc(c)} · ${ml(k)}</p></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
  <div class="sheet-b"><div class="form">
    <label>本月讲了<textarea class="input" id="rSum" rows="3">${esc(r.sum)}</textarea></label>
    <label>掌握得好<input class="input" id="rGood" value="${esc(r.good.join('、'))}" placeholder="用顿号隔开"></label>
    <label>还要巩固<input class="input" id="rWeak" value="${esc(r.weak.join('、'))}" placeholder="用顿号隔开"></label>
    <label>下月建议<textarea class="input" id="rAdv" rows="2">${esc(r.adv)}</textarea></label>
  </div>
  <div class="sheet-foot"><button class="btn ghost sm" data-close>取消</button><button class="btn sm" data-saverep="${esc(ek)}">保存</button></div></div>`);
}
// 建档：新建学员和编辑档案共用一张表。基本信息写进飞书学员表，目标和画像存工作台，画像用固定词表
function goalRow(r = {}) {
  return `<div class="grow-g"><input class="input" data-g="sub" value="${esc(r.sub)}" list="subs" placeholder="科目，如 IG化学" aria-label="科目"><input class="input" data-g="target" value="${esc(r.target)}" placeholder="目标" aria-label="目标成绩"><input class="input" data-g="exam" value="${esc(r.exam)}" placeholder="考试" aria-label="考试"><input class="input" data-g="date" value="${esc(r.date)}" placeholder="2026-11-18" aria-label="考试日期"></div>`;
}
function openNew(sid) {
  const s = sid ? S[sid] : {}, P = s.persona || {}, g = sid ? s.goals || {aim:'', rows:[]} : {aim:'', rows:[]};
  const sel = (id, opts) => `<select class="input" id="${id}">${opts.map(o => `<option>${o}</option>`).join('')}</select>`;
  showSheet(`
  <div class="sheet-h"><div class="grow"><h3>${sid ? esc(s.name) : '新建学员'}</h3></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
  <div class="sheet-b"><div class="form">
    ${sid ? '' : `<fieldset><legend>基本信息</legend><div class="grid3">
      <label>姓名<input class="input" id="nName"></label><label>学校<input class="input" id="nSchool"></label><label>年级<input class="input" id="nGrade" placeholder="10"></label>
      <label>学制${sel('nSys', ['', '13 年制', '12 年制'])}</label><label>家长<input class="input" id="nParent" placeholder="妈妈 138…"></label><label>渠道<input class="input" id="nSrc" placeholder="老学员转介绍"></label>
      <label>阶段${sel('nStage', ['咨询','试听'])}</label></div></fieldset>`}
    <fieldset><legend>目标</legend>
      <label>方向<input class="input" id="nAim" value="${esc(g.aim)}" placeholder="UCL 工程，2027 年入学"></label>
      <div class="grow-g ghead"><span>科目</span><span>目标成绩</span><span>考试</span><span>日期</span></div>
      <div id="nGoals" style="display:grid;gap:6px">${(g.rows.length ? g.rows : [{}]).map(goalRow).join('')}</div>
      <datalist id="subs">${(sid ? linesOf(sid) : []).map(l => `<option>${esc(l.c)}</option>`).join('')}</datalist>
      <button class="btn ghost xs" style="margin-top:6px" data-goalrow>${ic('plus',12)}加一科</button></fieldset>
    <fieldset><legend>学生画像</legend>
    ${PKEYS.map(k => { const v = P[k] || {tags:[]}; return `<div class="pblk"><div class="lbl">${k}</div>
      <div class="chips">${[...new Set([...PRESET[k].tags, ...v.tags])].map(t => `<button class="chip ${v.tags.includes(t) ? 'on' : ''}" data-chip="${k}">${esc(t)}</button>`).join('')}</div>
      <input class="input" data-ptext="${k}" value="${esc(v.text)}" placeholder="${PRESET[k].ask}" aria-label="${k}说明"></div>`; }).join('')}</fieldset>
  </div>
  <div class="sheet-foot"><button class="btn ghost sm" data-close>取消</button>${sid ? '' : '<button class="btn outline sm" data-savenew="" data-send>保存并发收集表</button>'}<button class="btn sm" data-savenew="${esc(sid || '')}">保存</button></div>
  </div>`, true);
  $(sid ? '[data-g=sub]' : '#nName').focus();
}
async function saveNew(sid, btn, sendForm) {
  const isNew = !sid;
  const old = sid ? S[sid].persona || {} : {}, src = `${who()} ${md(TODAY)}`, persona = {};
  for (const k of PKEYS) {
    const tags = [...document.querySelectorAll(`[data-chip="${k}"].on`)].map(b => b.textContent), text = $(`[data-ptext="${k}"]`).value.trim();
    if (!tags.length && !text) continue;
    persona[k] = old[k] && old[k].text === text && old[k].tags.join() === tags.join() ? old[k] : {tags, text, src};
  }
  const goals = {aim:$('#nAim').value.trim(), rows:[...document.querySelectorAll('#nGoals .grow-g')].map(r => Object.fromEntries([...r.querySelectorAll('[data-g]')].map(i => [i.dataset.g, i.value.trim()]))).filter(v => v.sub && v.target)};
  btn.disabled = true;
  try {
    if (isNew) {
      const name = $('#nName').value.trim(); if (!name) { btn.disabled = false; return $('#nName').focus(); }
      const r = await send('/wb/students', 'POST', {name, school:$('#nSchool').value.trim(), grade:$('#nGrade').value.trim(), system:$('#nSys').value, parent:$('#nParent').value.trim(), channel:$('#nSrc').value.trim(), stage:$('#nStage').value, persona, goals});
      sid = r.id; S[sid] = {...r.student, persona, goals}; ORDER.unshift(sid);
    } else {
      await send(`/wb/students/${encodeURIComponent(sid)}`, 'PUT', {persona, goals});
      Object.assign(S[sid], {persona, goals});
    }
  } catch (e) { btn.disabled = false; return fail(e); }
  closeSheet(); go({page:'profile', sid, tab:'overview'});
  if (sendForm) return document.querySelector(`[data-sendform="${CSS.escape(sid)}"]`)?.click();
  toast(isNew ? '已建档，已写进飞书学员信息表' : '已保存');
}

/* ---------- 附件 ---------- */
let pendingFiles = [];
/** 图片在浏览器里先压到长边 1600，单个文件不超过 2 MB */
async function shrink(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', {type:'image/jpeg'}) : file;
}
async function uploadFile(sid, file) {
  const f = await shrink(file);
  if (f.size > 2e6) throw new Error(`${file.name} 超过 2 MB，请压缩后再传`);
  const r = await api(`/wb/upload?student=${encodeURIComponent(sid)}&name=${encodeURIComponent(f.name)}`, {method:'POST', body:f, headers:{'content-type':f.type || 'application/octet-stream'}});
  return {key:r.key, name:r.name, img:f.type.startsWith('image/')};
}
async function openFile(key) {
  const w = window.open('', '_blank');
  try { const r = await api(`/wb/file?key=${encodeURIComponent(key)}`); if (w) w.location = r.url; else location.href = r.url; } catch (e) { w?.close(); fail(e); }
}
function openMile(k) {
  pendingFiles = [];
  const d = k === NOW ? TODAY : k + '-28';
  showSheet(`
  <div class="sheet-h"><div class="grow"><h3>添加里程碑</h3><div class="sm muted">${esc(nm(st.sid))} · ${ml(k)}</div></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
  <div class="sheet-b"><div class="form">
    <label>标题<input class="input" id="mTitle" placeholder="BPhO 银奖"></label>
    <div class="grid2"><label>日期<input class="input" type="date" id="mDate" value="${d}"></label>
      <label>课程<select class="input" id="mCourse"><option value="">不限课程</option>${linesOf(st.sid).map(l => `<option>${esc(l.c)}</option>`).join('')}</select></label></div>
    <label>说明<textarea class="input" id="mText" rows="3"></textarea></label>
    <label class="drop btnlike">${ic('up',20)}<div>图片或附件</div><input type="file" id="mFiles" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" class="sr"></label>
    <div class="thumbs" id="mPrev"></div>
  </div>
  <div class="sheet-foot"><button class="btn ghost sm" data-close>取消</button><button class="btn sm" data-savemile>保存</button></div></div>`);
  $('#mTitle').focus();
}
function grades() {
  const id = st.sid;
  const list = GRADES.filter(g => g.sid === id).sort((a, b) => b.d.localeCompare(a.d));
  return `
  <div class="toolbar">
    <span class="grow"></span><button class="btn sm" data-addgrade>${ic('plus',14)}添加成绩</button>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>日期</th><th>考试</th><th>科目</th><th>成绩</th><th>和目标比</th><th>录入</th><th></th></tr></thead>
    <tbody>${list.map(g => { const tg = targetOf(id, g.sub), x = tg && gapOf({...tg, cur:g.score}); return `<tr>
      <td class="tnum">${md(g.d)}${g.d.startsWith(TODAY.slice(0, 4)) ? '' : ' ' + g.d.slice(0, 4)}</td><td>${esc(g.exam)}</td><td>${esc(g.sub)}</td><td class="strong">${esc(g.score)}</td>
      <td>${x && x.t !== '—' ? sb(x.t, x.c) : '<span class="muted">—</span>'}</td><td>${esc(g.by)}</td>
      <td style="text-align:right">${g.file ? `<button class="btn ghost xs" data-file="${esc(g.file.key)}" title="${esc(g.file.name)}">${ic(g.file.img ? 'img' : 'file', 14)}原件</button>` : ''}</td></tr>`; }).join('')
      || '<tr><td colspan="7" class="empty-row">还没有成绩</td></tr>'}</tbody>
  </table></div>`;
}
// 添加成绩：上传成绩单截图或 PDF 自动识别，确认后保存；也可以手动填。原件都存下来
let gradeFile = null;
const gsubsOf = id => [...new Set([...linesOf(id).map(l => l.c), ...goalsOf(id).rows.map(r => r.sub)])];
function openGrade(step = 'pick', rows = [], note = '') {
  const id = st.sid, subs = gsubsOf(id);
  if (step === 'pick') gradeFile = null;
  const head = `<div class="sheet-h"><div class="grow"><h3>添加成绩</h3><div class="sm muted">${esc(nm(id))}</div></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>`;
  if (step === 'pick') return showSheet(`${head}<div class="sheet-b">
    <label class="drop btnlike">${ic('up',20)}<div>上传成绩单截图或 PDF，自动识别</div><input type="file" id="gScan" accept="image/*,.pdf" class="sr"></label>
    <div class="sheet-foot"><button class="btn ghost sm" data-close>取消</button><button class="btn outline sm" data-gstep="manual">手动填写</button></div></div>`);
  if (step === 'busy') return showSheet(`${head}<div class="sheet-b"><p class="muted">${esc(note)}</p></div>`);
  const list = step === 'manual' ? [{date:TODAY, exam:'', subject:'', score:''}] : rows;
  const dup = r => GRADES.some(g => g.sid === id && g.d === r.date && g.sub === r.subject && g.exam === r.exam);
  const subIn = (i, v) => `<input class="input" id="gS${i}" list="gsubs" value="${esc(v)}" ${step === 'manual' ? 'placeholder="IG物理"' : ''} aria-label="科目">`;
  const body = step === 'manual' ? `<div class="form"><input type="checkbox" id="gOn0" checked hidden>
      <div class="grid2"><label>科目${subIn(0, list[0].subject)}</label><label>成绩<input class="input" id="gV0" placeholder="A 或 85/100"></label>
      <label>考试<input class="input" id="gE0" placeholder="期中考试"></label><label>日期<input class="input" type="date" id="gD0" value="${list[0].date}"></label></div>
      ${gradeFile ? `<span class="file">${ic(gradeFile.img ? 'img' : 'file',14)}${esc(gradeFile.name)}</span>` : `<label class="drop btnlike">${ic('up',20)}<div>成绩单原件（截图或 PDF）</div><input type="file" id="gFile" accept="image/*,.pdf" class="sr"></label><div class="thumbs" id="mPrev"></div>`}</div>`
    : `<p class="sm muted" style="margin:0 0 12px">${esc(gradeFile?.name || '')} · 识别出 ${list.length} 条，核对后保存</p>
    <div class="table-flat"><table>
      <thead><tr><th style="width:32px"></th><th>日期</th><th>考试</th><th>科目</th><th style="width:90px">成绩</th></tr></thead>
      <tbody>${list.map((r, i) => `<tr ${dup(r) ? 'class="muted"' : ''}>
        <td><input type="checkbox" id="gOn${i}" ${dup(r) ? 'disabled' : 'checked'} aria-label="保存这条"></td>
        <td><input class="input" type="date" id="gD${i}" value="${esc(r.date || TODAY)}"></td>
        <td><input class="input" id="gE${i}" value="${esc(r.exam)}"></td>
        <td>${subIn(i, r.subject)}</td>
        <td>${dup(r) ? '<span class="sm">已有，跳过</span>' : `<input class="input" id="gV${i}" value="${esc(r.score)}">`}</td></tr>`).join('')}</tbody>
    </table></div>`;
  showSheet(`${head}<div class="sheet-b">${note ? `<p class="sm" style="margin:0 0 12px;color:var(--text-2)">${esc(note)}</p>` : ''}${body}<datalist id="gsubs">${subs.map(x => `<option>${esc(x)}</option>`).join('')}</datalist>
    <div class="sheet-foot"><button class="btn ghost sm" data-close>取消</button><button class="btn sm" data-savegrade="${list.length}">保存</button></div></div>`, step === 'ocr');
}
async function scanGrade(file) {
  const id = st.sid;
  openGrade('busy', [], '正在上传…');
  try { gradeFile = await uploadFile(id, file); } catch (e) { fail(e); return openGrade('pick'); }
  openGrade('busy', [], '正在识别…');
  try {
    const r = await send('/wb/grades/scan', 'POST', {student:id, key:gradeFile.key, subjects:gsubsOf(id)});
    if (!r.rows.length) return openGrade('manual', [], '没认出成绩，手动填一下；原件会一起保存');
    openGrade('ocr', r.rows);
  } catch (e) { openGrade('manual', [], e.message); }
}
// 交接卡：同一门课换了老师（新老师 30 天内第一次上或者马上要上），新老师确认看过之前，教务的跟进里有提醒
function handoversOf(id) {
  const done = S[id]?.handover || {}, out = [];
  for (const l of linesOf(id)) {
    const xs = lesOf(id, l.c).filter(x => !x.cancel);
    for (let i = xs.length - 1; i > 0; i--) {
      const to = xs[i].t, from = xs[i - 1].t;
      if (to === from) continue;
      const fresh = !xs.slice(0, i).some(y => y.t === to && y.at > xs[i].at - 60 * DAYMS);
      if (fresh && xs[i].at >= NOWMS - 30 * DAYMS && done[l.c]?.teacher !== to) out.push({c:l.c, from, to, first:xs[i], prev:xs.slice(0, i)});
      break;
    }
  }
  return out;
}
function handoverBlk(id, h) {
  const last = [...h.prev].reverse().find(y => REP[y.id]), r = last && REP[last.id], P = S[id]?.persona || {}, g = goalsOf(id).rows.filter(x => x.sub === h.c || !h.c);
  const weak = r && r.kps.filter(k => k[1] !== '已掌握').map(k => k[0]).join('、');
  return `<div class="blk handover"><h4>交接卡 · ${esc(h.c)}</h4><p class="sm" style="margin:-4px 0 10px;color:var(--text-2)">之前是 ${esc(h.from)}，${esc(h.to)} ${md(h.first.d)} 开始上</p><dl class="dl2">
      ${g.length ? `<dt>目标</dt><dd>${g.map(x => `${esc(x.sub)} ${esc(x.target)}${x.cur ? `，现在 ${esc(x.cur)}` : ''}${x.exam ? `，${esc(x.exam)} ${esc(x.date)}` : ''}`).join('；')}</dd>` : ''}
      ${r ? `<dt>讲到</dt><dd>${esc(r.topic)}<span class="muted"> · ${md(last.d)}</span></dd>${weak ? `<dt>要巩固</dt><dd>${esc(weak)}</dd>` : ''}${r.hw ? `<dt>作业</dt><dd>${esc(r.hw)}</dd>` : ''}${r.issue ? `<dt>卡点</dt><dd>${esc(r.issue)}</dd>` : ''}` : `<dt>讲到</dt><dd class="muted">${esc(h.from)} 的课没有录课报告</dd>`}
      ${PKEYS.filter(k => P[k]).map(k => `<dt>${k}</dt><dd>${P[k].tags.map(esc).join(' · ')}${P[k].text ? `<div class="muted">${esc(P[k].text)}</div>` : ''}</dd>`).join('')}
    </dl>
    ${staff() || MEN() === h.to ? `<button class="btn sm" style="margin-top:12px" data-handover="${esc(id)}|${esc(h.c)}|${esc(h.to)}">${staff() && MEN() !== h.to ? `替 ${esc(h.to)} 确认看过` : '我看过了'}</button>` : ''}</div>`;
}
function info(s) {
  const g = (t, rows, cls = '') => `<div class="card ${cls}"><div class="card-h"><div class="grow"><h3>${t}</h3></div></div><div class="card-b"><dl class="fields">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="muted">—</span>'}</dd>`).join('')}</dl></div></div>`;
  return `
  <div class="toolbar"><span class="grow"></span>${staff() ? `<a class="btn outline sm" href="${FEISHU_ROSTER}" target="_blank" rel="noopener">在飞书中编辑${ic('ext',14)}</a>` : ''}</div>
  <div class="info-grid">
  ${g('学生', [['姓名', s.name], ['出生日期', s.birth], ['学校', s.school], ['学制和年级', [s.system, s.grade].filter(Boolean).join(' · ')], ['阶段', s.stage]])}
  ${g('联系', [['家长', s.contact], ['备注', s.note]])}
  ${staff() ? g('归属', [['负责教务', s.owner], ['归属老师', s.ownerTeacher], ['服务老师', s.serviceTeacher], ['渠道', s.channel]]) : ''}
  </div>`;
}
/* ---------- 跟进 ---------- */
function todoItem(t, withStudent) {
  const sys = t.type === '系统', over = t.b === '逾期' && !t.done;
  return `<div class="todo ${t.done ? 'done' : ''}">
    ${sys ? `<span class="sysic" title="系统提醒，条件满足后自动完成">${ic('bot',16)}</span>` : `<button class="check ${t.done ? 'on' : ''}" data-todo="${t.id}" aria-label="完成"></button>`}
    <div class="tx"><b>${esc(t.t)}</b>
      <div class="sub">${withStudent ? `<a href="#" data-sid="${esc(t.s)}" data-to="${t.tab || 'todo'}">${esc(nm(t.s))}</a>` : ''}<span>${esc(t.owner)}</span><span class="${over ? 'over' : ''}">${over ? '逾期 ' : ''}${t.due}</span>${t.why ? `<span>${esc(t.why)}</span>` : ''}</div>
      ${t.result ? `<div class="sub">结果：${esc(t.result)}</div>` : ''}
      ${t.asking ? `<div class="res"><input class="input" placeholder="结果" id="res${t.id}"><button class="btn xs" data-res="${t.id}">完成</button></div>` : ''}
    </div>
    ${t.to && !withStudent ? `<button class="btn outline xs" data-review>去标记</button>` : ''}${t.ho && !withStudent ? `<button class="btn outline xs" data-showho="${esc(t.s)}|${esc(t.ho)}">看交接卡</button>` : ''}</div>`;
}
const owners = () => [...new Set([ME.name, ...STAFF, ...ORDER.map(id => S[id].owner).filter(Boolean)])];
const addBar = sid => st.adding ? `<div class="add" style="margin:0 0 8px;${sid ? 'grid-template-columns:1fr 120px 150px auto auto' : 'grid-template-columns:140px 1fr 120px 150px auto auto'}">
  ${sid ? '' : `<select class="input" id="newStu" style="height:32px" aria-label="学生">${ORDER.map(id => `<option value="${esc(id)}">${esc(nm(id))}</option>`).join('')}</select>`}
  <input class="input" id="newTodo" placeholder="新跟进" aria-label="新跟进">
  <select class="input" id="newOwner" style="height:32px" aria-label="负责人">${owners().map(o => `<option ${o === (sid ? S[sid].owner || ME.name : ME.name) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
  <input class="input" type="date" id="newDue" value="${addDays(TODAY, 2)}" aria-label="截止日期">
  <button class="btn ghost sm" data-adding>取消</button><button class="btn sm" data-addtodo="${esc(sid || '')}">添加</button></div>` : '';
const doneBlock = list => { const d = list.filter(t => t.done); return d.length ? `<button class="group-h" style="border:0;background:none;padding:0;cursor:pointer" data-showdone>已完成 ${d.length} 条 ${ic(st.showDone ? 'left' : 'chev', 12)}</button>${st.showDone ? d.sort(newest).map(t => todoItem(t, st.page !== 'profile')).join('') : ''}` : ''; };

function todo() {
  const list = todosOf(st.sid), open = list.filter(t => !t.done).sort(newest);
  return `
  <div class="card">
    <div class="card-h"><div class="grow"><h3>跟进</h3><p class="card-d">${open.length} 条没完成</p></div>${st.adding ? '' : `<button class="btn sm" data-adding>${ic('plus',14)}新跟进</button>`}</div>
    <div class="card-b">${addBar(st.sid)}
    <div class="todos">${open.map(t => todoItem(t, false)).join('') || '<p class="muted">没有待办</p>'}
    ${doneBlock(list)}</div></div>
  </div>`;
}
function followups() {
  const all = ORDER.flatMap(todosOf).filter(t => st.fu === '全部' || t.owner === ME.name);
  const marks = all.filter(t => t.to === 'review'), list = all.filter(t => t.to !== 'review');
  const markRow = marks.length ? `<div class="todo"><span class="sysic">${ic('bot',16)}</span><div class="tx"><b>${marks.length} 位学员 ${+NOW.slice(5)} 月还有课没标记</b>
    <div class="sub">${marks.slice(0, 12).map(t => esc(nm(t.s))).join('、')}${marks.length > 12 ? ` 等 ${marks.length} 人` : ''}<span>${md(marks[0].dueD)} 前</span></div></div><button class="btn outline xs" data-review>去标记</button></div>` : '';
  const groups = ['逾期','今天','本周','以后'].map(g => { const items = list.filter(t => t.b === g && !t.done).sort(newest); const extra = g === '本周' ? markRow : ''; return items.length || extra ? `
  <div class="card group"><div class="card-h"><div class="grow"><h3>${g}</h3></div>${g === '逾期' ? sb(String(items.length), 'bad') : badge(String(items.length + (extra ? 1 : 0)), 'sec')}</div>
    <div class="card-b todos">${extra}${items.map(t => todoItem(t, true)).join('')}</div></div>` : ''; }).join('');
  return `
  <div class="page-h"><h2>跟进</h2><span class="grow"></span>${st.adding ? '' : `<button class="btn sm" data-adding>${ic('plus',14)}新跟进</button>`}</div>
  <div class="toolbar"><div class="tabs">${['全部','我的'].map(t => `<button class="tab ${st.fu === t ? 'on' : ''}" data-fu="${t}">${t}</button>`).join('')}</div></div>
  ${addBar('')}
  ${groups || '<div class="card"><div class="card-b muted">没有待办</div></div>'}
  <div class="todos" style="margin-top:12px">${doneBlock(list)}</div>`;
}
/* ---------- 录课管理（原菁仕课堂后台）和教务名单，只给管理员 ---------- */
let ROLES = null;
function rec() {
  if (!ROLES) api('/wb/roles').then(r => { ROLES = r; if (st.page === 'rec') render(); }).catch(fail);
  const people = (ROLES?.people || []).filter(p => !ROLES.staff.some(s => s.openId === p.openId));
  return `
  <div class="page-h"><h2>录课管理</h2></div>
  <div class="rec-grid">${[['录音和转写','mic','#/lessons'],['提示词','file','#/prompts'],['管理员','users','#/admins']].map(([t, i, h]) => `<a class="card rec-card" href="/classroom/admin/${h}" target="_blank" rel="noopener"><span class="rec-ic">${ic(i,18)}</span><b>${t}</b>${ic('ext',14)}</a>`).join('')}</div>
  <div class="card" style="margin-top:24px">
    <div class="card-h"><div class="grow"><h3>教务</h3></div></div>
    <div class="card-b">${!ROLES ? '<p class="muted">正在加载…</p>' : `
      <div class="todos">${ROLES.staff.map(s => `<div class="todo"><span class="avatar xs">${esc(s.name[0])}</span><div class="tx"><b>${esc(s.name)}</b></div><button class="btn ghost xs" data-unstaff="${s.openId}">移除</button></div>`).join('') || '<p class="muted">还没有教务</p>'}</div>
      <div class="row" style="margin-top:12px"><select class="input" id="staffPick" style="height:32px"><option value="">选一位登录过的人</option>${people.map(p => `<option value="${p.openId}">${esc(p.name)}</option>`).join('')}</select><button class="btn sm" data-addstaff>设为教务</button></div>`}
    </div>
  </div>`;
}
/* ---------- 完整月报（新标签页） ---------- */
function monthPage(sid, c, k) {
  const d = stat(sid, c, k), m = monthlyOf(sid, c, k);
  const xs = (d?.xs || []).filter(x => !x.cancel);
  document.title = `${nm(sid)} ${c} ${ml(k)} 月报`;
  return `<div class="mpage">
    <div class="page-h"><div class="grow"><h2>${esc(nm(sid))} · ${esc(c)}</h2><p class="card-d">${ml(k)} · ${d ? `${d.n} 节${d.cx ? `，取消 ${d.cx} 节` : ''}` : '没有课'}</p></div><button class="btn outline sm noprint" onclick="print()">打印</button></div>
    ${m?.rep ? `<div class="card"><div class="card-b"><dl class="rep4"><dt>本月讲了</dt><dd>${esc(m.rep.sum)}</dd><dt>掌握得好</dt><dd>${m.rep.good.map(esc).join('、') || '没有'}</dd><dt>还要巩固</dt><dd>${m.rep.weak.map(esc).join('、') || '没有'}</dd><dt>下月建议</dt><dd>${esc(m.rep.adv)}</dd></dl></div></div>` : '<p class="muted">这个月还没有月报。</p>'}
    <h3 class="sec-title">每节课</h3>
    <div class="table-wrap"><table><thead><tr><th>日期</th><th>老师</th><th>讲了</th><th>掌握情况</th><th></th></tr></thead><tbody>
    ${xs.map(x => { const r = REP[x.id]; return `<tr><td class="tnum">${md(x.d)} ${wd(x.d)}</td><td>${esc(x.t)}</td><td>${r ? esc(r.topic) : '<span class="muted">没录</span>'}</td>
      <td>${r ? r.kps.map(([n, v]) => v === '已掌握' ? esc(n) : `<span class="weak">${esc(n)}</span>`).join('、') : ''}</td><td>${r?.url ? `<a class="btn ghost xs noprint" href="${esc(r.url)}" target="_blank" rel="noopener">学情报告${ic('ext',12)}</a>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty-row">没有上课</td></tr>'}
    </tbody></table></div></div>`;
}

/* ---------- Sheet ---------- */
function showSheet(html, wide) {
  $('#sheet').innerHTML = html; $('#sheet').classList.toggle('wide', !!wide);
  $('#sheet').classList.add('on'); $('#overlay').classList.add('on'); $('#sheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() { $('#sheet').classList.remove('on'); $('#overlay').classList.remove('on'); $('#sheet').setAttribute('aria-hidden', 'true'); }

/** 课表翻到还没拉过的月份 */
async function ensureMonth(k) {
  if (LOADED.has(k)) return;
  LOADED.add(k);
  try { const r = await api(`/wb/lessons?month=${k}`); addLessons(r.lessons, r.students); } catch (e) { LOADED.delete(k); fail(e); }
  render();
}

document.addEventListener('click', async e => {
  if (e.target.id === 'overlay') return closeSheet();
  if (!e.target.closest('.mwrap,[data-acct]')) document.querySelectorAll('.menu.on').forEach(m => m.classList.remove('on'));
  if (e.target.closest('select,input,textarea')) return;
  const t = e.target.closest('button,a');
  if (!t) return;
  const d = t.dataset;
  if (t.tagName === 'A' && t.getAttribute('href') === '#') e.preventDefault();
  if (d.go) return go({page:d.go});
  if (d.sid) { e.preventDefault(); closeSheet(); return go({page:'profile', sid:d.sid, tab:d.to || 'overview', course:'全部', showDone:false, cm:st.cm}); }
  if (d.stage) return go({stage:d.stage});
  if (d.lmonth) return go({lm:MONTHS[MONTHS.indexOf(st.lm) + +d.lmonth]});
  if (d.cmonth) { const k = addMonth(st.cm, +d.cmonth); go({cm:k}); return ensureMonth(k); }
  if ('cmtoday' in d) return go({cm:NOW});
  if (d.lid) return openLesson(d.lid, t.closest('#sheet') ? dayCtx : (dayCtx = null));
  if ('acct' in d) return $('#acctMenu').classList.toggle('on');
  if ('review' in d) { closeSheet(); return go({page:'students', lm:NOW, mf:'未标', stage:'全部', q:''}); }
  if (d.mfset) return go({mf:d.mfset});
  if ('collapse' in d) {
    const on = document.body.classList.toggle('collapsed');
    store.set(COLLAPSE_KEY, on ? '1' : '0');
    return render();
  }
  if ('logout' in d) return logout();
  if ('pickview' in d) return showSheet(`<div class="sheet-h"><div class="grow"><h3>以老师身份查看</h3></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div>
    <div class="sheet-b" style="display:grid;gap:4px">${TEACHERS.map(x => `<button class="btn ghost sm" style="justify-content:flex-start" data-viewas="${esc(x)}">${esc(x)}</button>`).join('')}</div>`);
  if ('viewas' in d) { if (d.viewas) store.set(VIEW_KEY, d.viewas); else store.del(VIEW_KEY); closeSheet(); st.page = 'schedule'; st.sel.clear(); return reboot(true); }
  if ('menu' in d) return t.nextElementSibling.classList.toggle('on');
  if ('adding' in d) { st.adding = !st.adding; render(); $('#newTodo')?.focus(); return; }
  if (d.day) return openDay(d.day);
  if (d.copy) { const x = LMAP.get(d.copy); navigator.clipboard?.writeText(parentText(x)).catch(() => {}); return toast('家长总结已复制，可以直接发到群里'); }
  if (d.file) return openFile(d.file);
  if ('copyprev' in d) {
    const pk = MONTHS[MONTHS.indexOf(st.lm) - 1], prev = VALS[pk] || {}, cur = VALS[st.lm] || {}, items = [];
    for (const [key, v] of Object.entries(prev)) for (const [field, value] of Object.entries(v)) if (!cur[key]?.[field]) items.push({key, field, value});
    if (!items.length) return toast('上个月的值都已经在了');
    setVals(st.lm, items); toast(`沿用了上月 ${items.length} 个值`); return render();
  }
  if ('fields' in d) return openFields();
  if (d.pick) { st.sel.has(d.pick) ? st.sel.delete(d.pick) : st.sel.add(d.pick); return render(); }
  if ('pickall' in d) { const ks = visibleKeys(), on = ks.every(x => st.sel.has(x)); ks.forEach(x => on ? st.sel.delete(x) : st.sel.add(x)); return render(); }
  if (d.bulk) { st.bulk = st.bulk === d.bulk ? '' : d.bulk; render(); $('#bulkIn')?.focus(); return; }
  if ('bulkok' in d) {
    const v = $('#bulkIn').value.trim(); if (!v) return $('#bulkIn').focus();
    if (st.bulk === 'note') setVals(st.lm, [...st.sel].map(key => ({key, field:textField().id, value:v})));
    else {
      const due = $('#bulkDue').value || addDays(TODAY, 2), ids = [...new Set([...st.sel].map(x => splitKey(x)[0]))];
      try { const r = await send('/wb/todos', 'POST', {items:ids.map(id => ({student:id, text:v, owner:S[id].owner || ME.name, due}))}); TODOS.push(...r.rows.map(todoOf)); toast(`给 ${ids.length} 个学生建了跟进`); } catch (err) { return fail(err); }
    }
    st.bulk = ''; return render();
  }
  if ('export' in d) return exportCsv();
  if ('clearsel' in d) { st.sel.clear(); st.bulk = ''; return render(); }
  const reFields = () => { saveFields(); render(); openFields(); };
  if (d.addopt) { const v = $('#opt-' + d.addopt).value.trim(); if (!v) return $('#opt-' + d.addopt).focus();
    FIELDS.find(f => f.id === d.addopt).options.push([v, $('#optc-' + d.addopt).value]); return reFields(); }
  if (d.delopt) { const [fid, i] = d.delopt.split('|'); FIELDS.find(f => f.id === fid).options.splice(i, 1); return reFields(); }
  if (d.delfield) { FIELDS = FIELDS.filter(f => f.id !== d.delfield); return reFields(); }
  if ('addfield' in d) { const v = $('#newField').value.trim(), type = $('#newType').value; if (!v) return $('#newField').focus();
    FIELDS.push({id:'f' + Date.now(), name:v, type, ...(type === 'select' ? {options:[]} : {})}); return reFields(); }
  if (d.ptab) return go({tab:d.ptab});
  if (d.course) return go({course:d.course});
  if (d.fu) return go({fu:d.fu});
  if ('showdone' in d) { st.showDone = !st.showDone; return render(); }
  if (d.addmile) return openMile(d.addmile);
  if ('savemile' in d) {
    const title = $('#mTitle').value.trim(); if (!title) return $('#mTitle').focus();
    t.disabled = true;
    try {
      const files = await Promise.all(pendingFiles.map(f => uploadFile(st.sid, f)));
      const row = await send('/wb/miles', 'POST', {student:st.sid, date:$('#mDate').value || TODAY, course:$('#mCourse').value, title, text:$('#mText').value.trim(), files});
      DETAIL[st.sid].miles.push(row);
    } catch (err) { t.disabled = false; return fail(err); }
    closeSheet(); render(); return toast('里程碑已保存');
  }
  if (d.editrep) { t.closest('.menu').classList.remove('on'); return openRepEdit(d.editrep); }
  if (d.saverep) {
    const [id, c, k] = d.saverep.split('|'), split = v => v.split(/[、，,]/).map(x => x.trim()).filter(Boolean);
    const rep = {sum:$('#rSum').value.trim(), good:split($('#rGood').value), weak:split($('#rWeak').value), adv:$('#rAdv').value.trim()};
    if (!rep.sum) return $('#rSum').focus();
    try { const r = await send('/wb/monthly', 'PUT', {student:id, course:c, month:k, rep}); Object.assign(monthlyOf(id, c, k), {rep, editedBy:r.editedBy}); } catch (err) { return fail(err); }
    closeSheet(); render(); return toast('月报已保存');
  }
  if (d.regen) { t.closest('.menu').classList.remove('on'); const [id, c, k] = d.regen.split('|'); genMonthly(id, c, k, true); return render(); }
  if ('addgrade' in d) return openGrade();
  if (d.gstep) return openGrade(d.gstep);
  if ('savegrade' in d) {
    const items = [];
    for (let i = 0; i < +d.savegrade; i++) {
      if (!$('#gOn' + i)?.checked || !$('#gV' + i)) continue;
      const g = {date:$('#gD' + i).value, exam:$('#gE' + i).value.trim(), subject:$('#gS' + i).value.trim(), score:$('#gV' + i).value.trim()};
      if (g.exam && g.score && g.subject && g.date) items.push(g);
    }
    if (!items.length) return toast('科目、成绩、考试和日期都要填');
    t.disabled = true;
    try {
      const file = gradeFile || (pendingFiles[0] ? await uploadFile(st.sid, pendingFiles[0]) : null);
      const r = await send('/wb/grades', 'POST', {student:st.sid, items, file});
      GRADES.push(...r.rows.map(x => ({id:x._id, sid:x.student, d:x.date, exam:x.exam, sub:x.subject, score:x.score, by:x.by, file:x.file})));
      toast(r.rows.length ? `保存了 ${r.rows.length} 条，目标与达成和月度记录已更新${r.skipped ? `，${r.skipped} 条已经录过` : ''}` : '这几场考试都已经录过了');
    } catch (err) { t.disabled = false; return fail(err); }
    closeSheet(); return render();
  }
  if (d.handover) {
    const [id, c, teacher] = d.handover.split('|');
    try { const r = await send(`/wb/students/${encodeURIComponent(id)}/handover`, 'POST', {course:c, teacher}); S[id].handover = r.handover; } catch (err) { return fail(err); }
    t.closest('.blk')?.remove(); toast('交接卡已确认'); return render();
  }
  if (d.sendform !== undefined) {
    try {
      const r = await send(`/wb/students/${encodeURIComponent(d.sendform)}/form`, 'POST', {});
      await navigator.clipboard?.writeText(`${nm(d.sendform)}的家长您好，麻烦花两分钟填一下孩子的学习情况，方便老师上课：${r.url}`).catch(() => {});
      toast('收集表链接已复制，发给家长，填完自动补进画像');
    } catch (err) { fail(err); }
    return;
  }
  if (d.showho) { const [id, c] = d.showho.split('|'), h = handoversOf(id).find(x => x.c === c); return h && showSheet(`<div class="sheet-h"><div class="grow"><h3>${esc(nm(id))}</h3></div><button class="btn ghost sm" data-close aria-label="关闭">${ic('x')}</button></div><div class="sheet-b">${handoverBlk(id, h)}</div>`); }
  if ('close' in d) return closeSheet();
  if ('sync' in d) {
    t.disabled = true;
    try { const r = await send('/wb/sync', 'POST', {force:true, months:[...new Set([...MONTHS, st.cm, addMonth(NOW, 1)])].slice(-6)}); if (r.changed) await reboot(); toast(r.changed ? '课表已同步' : '课表已同步，没有变化'); } catch (err) { fail(err); }
    t.disabled = false; return;
  }
  if ('new' in d) return openNew();
  if ('edit' in d) return openNew(st.sid);
  if ('goalrow' in d) return $('#nGoals').insertAdjacentHTML('beforeend', goalRow());
  if (d.chip) return t.classList.toggle('on');
  if ('savenew' in d) return saveNew(d.savenew, t, 'send' in d);
  if (d.acc || d.ign) {
    const id = d.acc || d.ign, det = DETAIL[st.sid], x = det.sugg.find(y => y._id === id);
    try { await send(`/wb/sugg/${id}`, 'PATCH', {action:d.acc ? 'accept' : 'ignore'}); } catch (err) { return fail(err); }
    det.sugg = det.sugg.filter(y => y !== x);
    if (d.acc) { const P = S[st.sid].persona ||= {}, v = P[x.key] ||= {tags:[], text:''}; v.tags = [...new Set([...v.tags, x.tag])]; v.src = `AI 建议，${ME.name}确认 ${md(TODAY)}`; }
    return render();
  }
  if (d.todo) { const x = TODOS.find(y => y.id === d.todo); if (x.done) { x.done = false; x.result = ''; send(`/wb/todos/${x.id}`, 'PATCH', {done:false}).catch(fail); } else x.asking = true; return render(); }
  if (d.res) {
    const x = TODOS.find(y => y.id === d.res), result = $('#res' + x.id).value.trim() || '已完成';
    try { await send(`/wb/todos/${x.id}`, 'PATCH', {done:true, result}); } catch (err) { return fail(err); }
    Object.assign(x, {done:true, asking:false, result}); return render();
  }
  if ('addtodo' in d) {
    const v = $('#newTodo').value.trim(); if (!v) return $('#newTodo').focus();
    const s = d.addtodo || $('#newStu').value, due = $('#newDue').value || addDays(TODAY, 2);
    try { const r = await send('/wb/todos', 'POST', {items:[{student:s, text:v, owner:$('#newOwner').value, due}]}); TODOS.push(...r.rows.map(todoOf)); } catch (err) { return fail(err); }
    st.adding = false; return render();
  }
  if ('addstaff' in d) {
    const id = $('#staffPick').value; if (!id) return;
    try { await send(`/wb/roles/${id}`, 'PUT', {name:ROLES.people.find(p => p.openId === id).name}); ROLES = null; } catch (err) { return fail(err); }
    return render();
  }
  if (d.unstaff) { try { await api(`/wb/roles/${d.unstaff}`, {method:'DELETE'}); ROLES = null; } catch (err) { return fail(err); } return render(); }
});
document.addEventListener('change', async e => {
  const d = e.target.dataset;
  if (d.fv) { const [key, fid, k] = d.fv.split('|'); setVals(k, [{key, field:fid, value:e.target.value.trim()}]); if (e.target.tagName === 'SELECT') render(); return; }
  if (d.fname) { FIELDS.find(f => f.id === d.fname).name = e.target.value.trim() || '未命名'; saveFields(); return render(); }
  if (e.target.id === 'mf') return go({mf:e.target.value});
  if (e.target.id === 'ct') return go({ct:e.target.value});
  if (e.target.id === 'stageSet' || d.stageof) {
    const v = e.target.value, sid = d.stageof || st.sid;
    try { await send(`/wb/students/${encodeURIComponent(sid)}`, 'PUT', {stage:v}); } catch (err) { fail(err); return render(); }
    S[sid].stage = v; toast(`${nm(sid)}的阶段改成${v}`); return render();
  }
  if (e.target.id === 'gScan' && e.target.files[0]) return scanGrade(e.target.files[0]);
  if (e.target.id === 'mFiles' || e.target.id === 'gFile') {
    pendingFiles = [...e.target.files];
    $('#mPrev').innerHTML = pendingFiles.map(f => f.type.startsWith('image/') ? `<span class="thumb"><img src="${URL.createObjectURL(f)}" alt="${esc(f.name)}"></span>` : `<span class="file">${ic('file',14)}${esc(f.name)}</span>`).join('');
  }
  if (e.target.id === 'bulkMark' && e.target.value) { const mf = markField(); setVals(st.lm, [...st.sel].map(key => ({key, field:mf.id, value:e.target.value}))); return render(); }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  st.q = e.target.value; render();
  const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// ---------- 启动 ----------
function logout(message = '') {
  token = ''; store.del(TOKEN_KEY); store.del(VIEW_KEY);
  ME = {name:'', role:'out', scheduleName:'', viewing:null}; st.error = message; st.loading = false;
  closeSheet(); render();
}
async function reboot(showLoading) {
  if (showLoading) { st.loading = true; render(); }
  const B = await api('/wb/boot');
  load(B);
  for (const k of Object.keys(DETAIL)) delete DETAIL[k];
  st.loading = false;
  st.lm ||= NOW; st.cm ||= NOW;
  if (!MONTHS.includes(st.lm)) st.lm = NOW;
  render();
  if (st.page === 'profile' && st.sid) go({});
  return B;
}
async function start() {
  const hashToken = location.hash.match(/^#token=([\w-]+)$/)?.[1];
  if (hashToken) { store.set(TOKEN_KEY, hashToken); history.replaceState(null, '', location.pathname); }
  token = store.get(TOKEN_KEY) || '';
  const page = location.hash.match(/^#month\/([^/]+)\/([^/]+)\/(\d{4}-\d{2})$/);
  if (!token) return logout();
  try {
    const B = await reboot(true);
    if (page) {
      const [sid, c, k] = [decodeURIComponent(page[1]), decodeURIComponent(page[2]), page[3]];
      document.body.classList.add('solo');
      await loadStudent(sid);
      return void ($('#main').innerHTML = monthPage(sid, c, k));
    }
    st.page = staff() && !ME.viewing ? 'students' : 'schedule';
    render();
    // 课表快照过期了：先用旧的，后台同步完有变化再刷新一次
    if (B.stale) send('/wb/sync', 'POST', {}).then(r => r.changed && reboot()).catch(err => console.error(err));
  } catch (err) {
    if (ME.role !== 'out') { st.error = err.message; render(); }
  }
}
start();
