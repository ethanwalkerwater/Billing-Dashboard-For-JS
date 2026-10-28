/**
 * 完整课堂学情报告：版式照搬 docs/classroom-report.html，数据来自 GET /classroom-api/report?t=<token>（公开，凭链接访问）。
 * 加 &edit=1 是老师 / 超级管理员的编辑模式：用后台的登录（同域 localStorage），点文字原地改，支持简单 Markdown，版式不变。
 */
import './styles.css';

interface MeetingReport {
  title: string; lead: string;
  sections: Array<{ title: string; items: Array<{ title: string; start: number; end: number; conclusion: string }> }>;
  decisions: Array<{ text: string; time: number | null }>;
  todos: Array<{ task: string; owner: string; due: string; time: number | null }>;
  followups: string[];
  speakers: Array<[string, number]>;
}

interface ReportData {
  kind?: 'lesson' | 'adhoc' | 'meeting' | 'merged';
  student: string; course: string; teacher: string; date: string; time: string; mins: number; gapMinutes: number;
  /** 课堂时间档案算好的数字（logic.ts lessonClock）；没有档案的报告没有 */
  clock?: {
    recStart: number; first: number; last: number; full: boolean; total: number; over: number; cats: Array<[string, number]>; points: Array<[string, number]>;
    /** 合并反馈的各节：秒数落在哪一节，就按那一节的 recStart 换成真实时刻 */
    parts?: Array<{ start: number; end: number; recStart: number }>;
  };
  report: {
    topic: string; lead: string; content: string[];
    mastery: Array<{ name: string; status: string; evidence: string }>;
    performance: string; issue: { title: string; fix: string }; homework: string; review: string; next: string;
    chapters?: Array<{ start: number; end: number; real: number; cat: string; title: string; point: string }>;
    questions?: Array<{ time: number | null; text: string; answer: string }>;
  };
}

// 会议板块轮流用 .p0–.p6 七种颜色；课的章节类别顺序同 logic.ts CHAPTER_CATS，对应 .k0–.k5
const PALETTE = 7;
const CATS = ['新知讲解', '例题精讲', '错题讲评', '当堂练习', '方法总结', '学习规划'];
const PLAN_POINT = '试卷分析与学习规划';
/** 录音里的秒 → 上海时间 HH:MM */
const hm = (recStart: number, s: number) => new Date(recStart + s * 1000 + 8 * 3_600_000).toISOString().slice(11, 16);
/** 合并反馈：秒数 s 在第几节（从 0 起） */
const partAt = (c: NonNullable<ReportData['clock']>, s: number) => Math.max(0, (c.parts ?? []).filter(p => p.start <= s).length - 1);
const at = (c: NonNullable<ReportData['clock']>, s: number) => hm(c.parts?.[partAt(c, s)].recStart ?? c.recStart, s);
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} 分钟`;
const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

const h = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/**
 * 报告里的文字支持简单 Markdown：**粗体**、*斜体*、`代码`、[链接](https://…)、换行、「- 」「1. 」开头的列表行。
 * 先转义再替换，不会注入 HTML；列表用块级 span 排，放进 <p> <td> <b> 里都合法，不改原来的版式。
 */
function md(src: string) {
  const inline = (line: string) => h(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return src.split('\n').map((line) => {
    const m = line.match(/^\s*(?:[-*•]|(\d+[.)]))\s+(.*)$/);
    return m ? `<span class="mdli">${m[1] ? `${h(m[1])} ` : '• '}${inline(m[2])}</span>` : inline(line);
  }).reduce((html, part, i, all) => html + part + (i < all.length - 1 && !part.startsWith('<span class="mdli">') && !all[i + 1].startsWith('<span class="mdli">') ? '<br>' : ''), '');
}

/** 可编辑的文字：path 是它在报告 JSON 里的位置，如 mastery.0.evidence */
let editing: { token: string; rev: string; dirty: boolean } | null = null;
const T = (path: string, value: string) =>
  `<span class="md" data-path="${path}"${editing ? ' tabindex="0" role="button" title="点击修改"' : ''}>${value.trim() ? md(value) : '<span class="gone">（已清空，保存后删掉这一条）</span>'}</span>`;
const root = document.getElementById('report')!;
const download = document.getElementById('download') as HTMLButtonElement;

function message(title: string, body: string) {
  document.title = `${title} · 菁仕教育`;
  root.innerHTML = `<h1>${h(title)}</h1><p>${h(body)}</p>`;
}

/** 课堂时间分布：按章节首尾相接的彩色条（没有空白），下面一行一章；课间不单列，章节时间上留空档。合并反馈按「第 N 节」分组 */
function chapterSection(c: NonNullable<ReportData['clock']>, chapters: NonNullable<ReportData['report']['chapters']>, labels: string[]) {
  const real = chapters.reduce((sum, ch) => sum + ch.real, 0) || 1;
  const k = (cat: string) => `k${Math.max(0, CATS.indexOf(cat))}`;
  const parts = c.parts;
  const axis = parts
    ? `<span></span><span>${parts.length} 节${c.full ? '共' : '学习时间共'} ${c.total} 分钟</span><span></span>`
    : `<span>${hm(c.recStart, c.first)} 开始</span><span>${c.full ? '共' : '学习时间共'} ${c.total} 分钟</span><span>${hm(c.recStart, c.last)} 下课</span>`;
  const head = (i: number) => {
    if (!parts || (i && partAt(c, chapters[i - 1].start) === partAt(c, chapters[i].start))) return '';
    const n = partAt(c, chapters[i].start);
    return `<div class="part-h">第 ${n + 1} 节 · ${h(labels[n] ?? '')} · ${minutes(parts[n].end - parts[n].start)}</div>`;
  };
  return `<div class="flow" role="img" aria-label="${h(c.cats.map(([cat, n]) => `${cat}${n}分钟`).join('，'))}">${chapters.map((ch, i) => `<i class="${k(ch.cat)}${head(i) && i ? ' gap' : ''}" style="width:${(ch.real / real) * 100}%"></i>`).join('')}</div>
    <div class="tl-axis">${axis}</div>
    <ul class="legend">${c.cats.map(([cat, n]) => `<li><i class="${k(cat)}"></i>${h(cat)}<b>${n} 分钟</b><span>${pct(n, c.total)}</span></li>`).join('')}</ul>
    <div class="chs">${chapters.map((ch, i) => `${head(i)}<div class="ch"><span class="when">${at(c, ch.start)}<span class="to">–${at(c, ch.end)}</span></span><i class="${k(ch.cat)}"></i><b>${h(ch.cat)}</b><span>${T(`chapters.${i}.title`, ch.title)}</span></div>`).join('')}</div>`;
}

/** 知识点用时：每一章归到它主要讲的知识点，合计 = 上面的分钟数 */
function pointTimeSection(c: NonNullable<ReportData['clock']>) {
  const max = c.points[0]?.[1] || 1;
  return `<p class="sub">合计 ${c.total} 分钟，与${c.full ? '课堂时长' : '上面的学习时间'}一致</p><div class="bars">${c.points.map(([name, n]) => `<div class="bar"><span>${h(name)}</span><div class="track"><i class="${name === PLAN_POINT ? 'k5' : ''}" style="width:${(n / max) * 100}%"></i></div><b>${n} 分钟 · ${pct(n, c.total)}</b></div>`).join('')}</div>`;
}

/** 会议纪要网页：版式见 docs/meeting-report.html */
function renderMeeting(d: ReportData, m: MeetingReport) {
  const at = (t: number | null) => (t === null ? '' : clock(t));
  const sections = m.sections.map((s, i) => ({ ...s, i: i % PALETTE, secs: s.items.reduce((a, it) => a + it.end - it.start, 0) }));
  const items = sections.flatMap(s => s.items.map(it => ({ ...it, i: s.i, section: s.title })));
  const end = Math.max(...items.map(it => it.end));
  const total = sections.reduce((a, s) => a + s.secs, 0);
  const talk = m.speakers.reduce((a, [, v]) => a + v, 0);
  const blocks: Array<[string, string]> = [
    ['决定事项', m.decisions.length ? `<ol class="decisions">${m.decisions.map((x, i) => `<li>${x.time === null ? '' : `<span class="when">${at(x.time)}</span>`}<span>${T(`decisions.${i}.text`, x.text)}</span></li>`).join('')}</ol>` : '<p class="meta">这场会没有明确拍板的事项。</p>'],
    ['待办事项', m.todos.length ? `<div class="table-wrap"><table class="todos"><thead><tr><th scope="col">事项</th><th scope="col">负责人</th><th scope="col">截止</th><th scope="col">时间点</th></tr></thead><tbody>${m.todos.map((t, i) => `<tr><td>${T(`todos.${i}.task`, t.task)}</td><td class="${t.owner ? '' : 'practice'}">${editing ? T(`todos.${i}.owner`, t.owner) : h(t.owner || '待认领')}</td><td>${editing ? T(`todos.${i}.due`, t.due) : h(t.due || '—')}</td><td class="when">${at(t.time)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="meta">没有明确的待办。</p>'],
    ['会议时间分布', `<div class="tl" role="img" aria-label="${h(sections.map(s => `${s.title}${minutes(s.secs)}`).join('，'))}">${items.map(it => `<i class="p${it.i}" style="left:${(it.start / end) * 100}%;width:${((it.end - it.start) / end) * 100}%" title="${h(`${clock(it.start)}–${clock(it.end)} ${it.section} · ${it.title}`)}"></i>`).join('')}</div>
      <div class="tl-axis"><span>00:00</span><span>${clock(end / 2)}</span><span>${clock(end)}</span></div>
      <ul class="legend">${sections.map(s => `<li><i class="p${s.i}"></i>${h(s.title)}<b>${minutes(s.secs)}</b><span>${pct(s.secs, total)}</span></li>`).join('')}</ul>`],
    ['议题详情', sections.map((s, si) => `<div class="agenda"><h3><i class="p${s.i}"></i>${T(`sections.${si}.title`, s.title)}<span>${s.items.length} 项</span></h3><ol class="steps">${s.items.map((it, j) => `<li><span class="when">${clock(it.start)}–${clock(it.end)}</span><b>${T(`sections.${si}.items.${j}.title`, it.title)}</b><span class="${it.conclusion === '未定' ? 'practice' : ''}">${T(`sections.${si}.items.${j}.conclusion`, it.conclusion)}</span></li>`).join('')}</ol></div>`).join('')],
    ...(m.followups.length ? [['待跟进', `<ul>${m.followups.map((f, i) => `<li>${T(`followups.${i}`, f)}</li>`).join('')}</ul>`] as [string, string]] : []),
    ...(talk ? [['发言占比', `<div class="bars">${m.speakers.map(([name, v]) => `<div class="bar"><span>${h(name)}</span><div class="track"><i style="width:${(v / m.speakers[0][1]) * 100}%"></i></div><b>${minutes(v)} · ${pct(v, talk)}</b></div>`).join('')}</div><p class="meta" style="margin-top:10px">说话人由录音自动区分，同一个人可能被分成两个编号。</p>`] as [string, string]] : []),
  ];
  document.title = `${m.title}_${d.date}_会议纪要`;
  root.innerHTML = `
    <div class="brand"><span class="mark">菁</span>菁仕教育</div>
    <div class="eyebrow">会议纪要</div><h1>${T('title', m.title)}</h1>
    <p class="meta">${[d.date.replaceAll('-', '.'), d.time, m.speakers.length ? `${m.speakers.length} 位发言人` : ''].filter(Boolean).map(h).join(' · ')}</p>
    <p class="lead">${T('lead', m.lead)}</p>
    <div class="facts four"><div><small>会议时长</small><b>${h(d.mins || Math.round(end / 60))} 分钟</b></div><div><small>议题</small><b>${items.length} 个</b></div><div><small>决定</small><b>${m.decisions.length} 项</b></div><div><small>待办</small><b>${m.todos.length} 项</b></div></div>
    ${blocks.map(([title, body], i) => `<section><h2><small>${String(i + 1).padStart(2, '0')}</small>${title}</h2>${body}</section>`).join('')}
    <footer class="foot">菁仕教育 · 内容由会议录音整理，说话人和错字以实际会议为准。</footer>`;
  download.hidden = Boolean(editing);
}

function render(d: ReportData) {
  if (d.kind === 'meeting') return renderMeeting(d, d.report as unknown as MeetingReport);
  const r = d.report;
  const chapters = r.chapters ?? [];
  const questions = r.questions ?? [];
  const c = chapters.length ? d.clock : undefined;
  // 没有课堂时间档案的报告（档案上线前的、预览旧数据）不显示时间分布和知识点用时，编号顺延
  const top: Array<[string, string]> = [
    ['本课学习内容', `<ul>${r.content.map((line, i) => `<li>${T(`content.${i}`, line.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ul>`],
    ...(c ? [['课堂时间分布', chapterSection(c, chapters, d.time.split('、'))], ['知识点用时', pointTimeSection(c)]] as Array<[string, string]> : []),
    ['知识点掌握情况', `<div class="table-wrap"><table><thead><tr><th scope="col">知识点</th><th scope="col">课堂表现</th><th scope="col">判断依据</th></tr></thead><tbody>${r.mastery.map((m, i) => `<tr><td>${T(`mastery.${i}.name`, m.name)}</td><td class="${m.status === '需要巩固' ? 'practice' : 'good'}">${h(m.status)}</td><td class="evidence">${T(`mastery.${i}.evidence`, m.evidence)}</td></tr>`).join('')}</tbody></table></div>`],
  ];
  const bottom: Array<[string, string]> = [
    ...(questions.length ? [['主动提问', `<p class="meta">${h(d.student || '学生')}${c?.parts ? '这几节课' : '这节课'}主动提了 ${questions.length} 个问题：</p><div class="qs">${questions.map((q, i) => `<figure class="q">${q.time === null ? '' : `<span class="when">${c?.parts ? at(c, q.time) : clock(q.time)}</span>`}<blockquote>“${T(`questions.${i}.text`, q.text)}”</blockquote>${q.answer || editing ? `<figcaption>${T(`questions.${i}.answer`, q.answer)}</figcaption>` : ''}</figure>`).join('')}</div>`] as [string, string]] : []),
    ['学生课堂表现', `<p class="insight">${T('performance', r.performance)}</p>`],
    ['易错点与改进方法', `<div class="issue"><b>${T('issue.title', r.issue.title)}</b><p>${T('issue.fix', r.issue.fix)}</p></div>`],
    ['课后巩固计划', `<div class="plan"><div><h3>作业与练习</h3><p>${T('homework', r.homework)}</p></div><div><h3>复习方法</h3><p>${T('review', r.review)}</p></div></div>`],
    ['下节课衔接', `<p>${T('next', r.next)}</p>`],
  ];
  const section = ([title, body]: [string, string], i: number) => `<section><h2><small>${String(i + 1).padStart(2, '0')}</small>${title}</h2>${body}</section>`;
  const teacher = /^[一-龥]+$/.test(d.teacher) ? `${d.teacher}老师` : d.teacher;
  document.title = `${d.student}_${d.course}_${d.date}_课堂学情报告`; // 打印另存 PDF 时浏览器用它作文件名
  root.innerHTML = `
    <div class="brand"><span class="mark">菁</span>菁仕教育</div>
    <div class="eyebrow">课堂学情报告${c?.parts ? ` · ${c.parts.length} 节课合并` : ''}</div><h1>${[h(d.course), T('topic', r.topic)].filter(Boolean).join(' · ')}</h1>
    <p class="meta">${[d.student, teacher, d.date.replaceAll('-', '.'), d.time].filter(Boolean).map(h).join(' · ')}</p>
    ${d.gapMinutes > 0 ? `<p class="meta">录音缺失约 ${h(d.gapMinutes)} 分钟，以下内容依据已收到的录音整理。</p>` : ''}
    <p class="lead">${T('lead', r.lead)}</p>
    <div class="facts"><div><small>学生</small><b>${h(d.student || '—')}</b></div><div><small>${c ? `课堂时长${c.parts ? ` · ${c.parts.length} 节` : ''}${c.over ? `<em>比计划多 ${c.over} 分钟</em>` : ''}` : '课堂记录时长'}</small><b>${h(d.mins)} 分钟</b></div><div><small>学习重点</small><b>${r.mastery.length} 项</b></div></div>
    ${top.map(section).join('')}
    <div class="report-bottom">
      ${bottom.map((s, i) => section(s, top.length + i)).join('')}
      <footer class="foot">菁仕教育 · 内容由课堂录音整理，网页版与 PDF 内容一致。</footer>
    </div>`;
  download.hidden = Boolean(editing);
}

// ponytail: PDF 用浏览器打印另存（@media print 已排好 A4），不做服务端生成；需要一键直出 .pdf 文件时再加服务端渲染。
download.addEventListener('click', () => window.print());

// ---------- 编辑模式 ----------

const ADMIN_TOKEN_KEY = 'classroom-admin-token'; // 与后台网页同域、同一个 key
let data: ReportData | null = null;
const bar = document.querySelector('.toolbar-inner')!;
/** 清空就删掉这一条的字段；其余必填字段清空则恢复原文 */
const REMOVABLE = /^(content\.\d+|mastery\.\d+\.name|questions\.\d+\.text|decisions\.\d+\.text|todos\.\d+\.task|followups\.\d+)$/;
const OPTIONAL = /^(questions\.\d+\.answer|todos\.\d+\.(owner|due))$/;

function getAt(obj: any, path: string): string {
  return path.split('.').reduce((o, k) => o?.[k], obj) ?? '';
}
function setAt(obj: any, path: string, value: string) {
  const keys = path.split('.');
  const last = keys.pop()!;
  keys.reduce((o, k) => o[k], obj)[last] = value;
}
function rerender() {
  const y = scrollY;
  render(data!);
  scrollTo(0, y);
}
function editBar(note = '') {
  bar.innerHTML = `<span class="edit-note">${note || '编辑模式 · 点文字直接修改，支持 **粗体**、*斜体*、「- 」列表；清空一条列表项即删除'}</span>
    <span class="edit-actions"><a class="btn-ghost" href="${location.pathname}?t=${encodeURIComponent(editing!.token)}">${editing!.dirty ? '放弃修改' : '退出编辑'}</a>
    <button type="button" class="download" id="saveEdit" ${editing!.dirty ? '' : 'disabled'}>保存</button></span>`;
}

/** 点一段文字：原地换成同字号的输入框，失焦收回并重画（时间轴、知识点用时等跟着变） */
function openEditor(el: HTMLElement) {
  const path = el.dataset.path!;
  const ta = document.createElement('textarea');
  ta.className = 'mdedit';
  ta.value = getAt(data!.report, path);
  el.replaceWith(ta);
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
  fit();
  ta.focus();
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { ta.value = getAt(data!.report, path); ta.blur(); } });
  ta.addEventListener('blur', () => {
    const value = ta.value.replace(/\r/g, '').trim();
    const old = getAt(data!.report, path);
    if (!value && !REMOVABLE.test(path) && !OPTIONAL.test(path)) {
      editBar('这一项不能为空，已恢复原文');
    } else if (value !== old) {
      setAt(data!.report, path, value);
      editing!.dirty = true;
      editBar();
    }
    rerender();
  }, { once: true });
}

async function startEditing(token: string) {
  const adminToken = (() => { try { return localStorage.getItem(ADMIN_TOKEN_KEY); } catch { return null; } })();
  // 编辑不了时报告照常显示，只在顶栏说明原因
  const notice = (text: string) => { bar.innerHTML = `<span class="edit-note">${text}</span><a class="btn-ghost" href="/classroom/admin/">打开后台登录</a>`; };
  if (!adminToken) return notice('要修改这份报告，请先用飞书登录菁仕课堂后台，再从课程里点「编辑」');
  const api = (init?: RequestInit) => fetch(`/classroom-api/admin/report?t=${encodeURIComponent(token)}`, { ...init, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' } });
  const res = await api();
  if (res.status === 401) return notice('后台登录已失效，请重新登录后再从课程里点「编辑」');
  if (!res.ok) return notice('只能编辑你自己的课程和会议');
  const { rev, report } = await res.json() as { rev: string; report: ReportData['report'] };
  editing = { token, rev, dirty: false };
  data!.report = report; // 用库里的原文（未经显示处理）编辑
  document.body.classList.add('editing');
  editBar();
  rerender();
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('a')) e.preventDefault(); // 编辑时点到链接不跳走
    const el = t.closest<HTMLElement>('.md[data-path]');
    if (el) openEditor(el);
  });
  root.addEventListener('keydown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.md[data-path]');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEditor(el); }
  });
  bar.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('#saveEdit');
    if (!btn || !editing?.dirty) return;
    btn.disabled = true;
    btn.textContent = '保存中…';
    const r = await api({ method: 'PUT', body: JSON.stringify({ rev: editing.rev, report: data!.report }) }).catch(() => null);
    const body = await r?.json().catch(() => ({}));
    if (!r?.ok) return editBar(body?.message || '保存失败，请检查网络后再试'), void ((document.getElementById('saveEdit') as HTMLButtonElement).disabled = false);
    const { rev, ...saved } = body as ReportData & { rev: string };
    data = saved;
    editing.rev = rev;
    editing.dirty = false;
    editBar('已保存，家长打开的链接也已更新');
    rerender();
  });
  addEventListener('beforeunload', (e) => { if (editing?.dirty) e.preventDefault(); });
}

async function load() {
  // 后台测试提示词时的预览：数据由后台网页（同域）放在 localStorage，不落库
  const preview = location.hash.match(/^#preview=([\w-]+)$/)?.[1];
  if (preview) {
    try {
      return render(JSON.parse(localStorage.getItem(`classroom-preview:${preview}`) ?? '') as ReportData);
    } catch {
      return message('预览已过期', '请回到后台重新生成。');
    }
  }
  const params = new URLSearchParams(location.search);
  const token = params.get('t');
  if (!token) return message('未找到这份课堂报告', '请从菁仕课堂中选择已完成的课程，再打开完整报告。');
  try {
    const response = await fetch(`/classroom-api/report?t=${encodeURIComponent(token)}`);
    if (response.status === 404) return message('未找到这份课堂报告', '请从菁仕课堂中选择已完成的课程，再打开完整报告。');
    if (!response.ok) throw new Error(String(response.status));
    data = await response.json() as ReportData;
    render(data);
  } catch {
    return message('暂时无法打开报告', '网络或服务暂时不可用，请稍后刷新重试。');
  }
  if (params.get('edit') === '1') await startEditing(token).catch(() => message('暂时无法编辑', '网络或服务暂时不可用，请稍后刷新重试。'));
}
load();
