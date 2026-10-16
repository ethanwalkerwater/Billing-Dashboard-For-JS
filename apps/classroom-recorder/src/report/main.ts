/** 完整课堂学情报告：版式照搬 docs/classroom-report.html，数据来自 GET /classroom-api/report?t=<token>（公开，凭链接访问）。 */
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
  kind?: 'lesson' | 'adhoc' | 'meeting';
  student: string; course: string; teacher: string; date: string; time: string; mins: number; gapMinutes: number;
  report: {
    topic: string; lead: string; content: string[];
    mastery: Array<{ name: string; status: string; evidence: string }>;
    performance: string; issue: { title: string; fix: string }; homework: string; review: string; next: string;
    timeline?: Array<{ phase: string; title: string; start: number; end: number; points: string[] }>;
    questions?: Array<{ time: number | null; text: string; answer: string }>;
  };
}

// 顺序与 logic.ts PHASES 一致，下标对应 styles.css 的 .p0–.p6 配色
const PHASES = ['复习', '讲解', '例题', '练习', '答疑', '总结', '其他'];
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} 分钟`;
const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

const h = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const root = document.getElementById('report')!;
const download = document.getElementById('download') as HTMLButtonElement;

function message(title: string, body: string) {
  document.title = `${title} · 菁仕教育`;
  root.innerHTML = `<h1>${h(title)}</h1><p>${h(body)}</p>`;
}

/** 课堂时间轴：整条按真实时间铺开（中间没记录的空当留白），下面是各环节合计和逐段列表 */
function timelineSection(t: NonNullable<ReportData['report']['timeline']>) {
  const end = t.at(-1)!.end;
  const total = t.reduce((sum, s) => sum + s.end - s.start, 0);
  const byPhase = PHASES.map((phase, i) => ({ phase, i, secs: t.filter(s => s.phase === phase).reduce((sum, s) => sum + s.end - s.start, 0) })).filter(p => p.secs > 0);
  const cls = (phase: string) => `p${Math.max(0, PHASES.indexOf(phase))}`;
  return `<div class="tl" role="img" aria-label="${h(byPhase.map(p => `${p.phase}${minutes(p.secs)}`).join('，'))}">${t.map(s => `<i class="${cls(s.phase)}" style="left:${(s.start / end) * 100}%;width:${((s.end - s.start) / end) * 100}%" title="${h(`${clock(s.start)}–${clock(s.end)} ${s.phase} · ${s.title}`)}"></i>`).join('')}</div>
    <div class="tl-axis"><span>00:00</span><span>${clock(end / 2)}</span><span>${clock(end)}</span></div>
    <ul class="legend">${byPhase.map(p => `<li><i class="p${p.i}"></i>${p.phase}<b>${minutes(p.secs)}</b><span>${pct(p.secs, total)}</span></li>`).join('')}</ul>
    <ol class="steps">${t.map(s => `<li><span class="when">${clock(s.start)}–${clock(s.end)}</span><i class="${cls(s.phase)}"></i><b>${h(s.phase)}</b><span>${h(s.title)}</span></li>`).join('')}</ol>`;
}

/** 知识点用时：一段讲了几个知识点就平分这段时间；占比按整节课算 */
function pointTimeSection(t: NonNullable<ReportData['report']['timeline']>) {
  const total = t.reduce((sum, s) => sum + s.end - s.start, 0);
  const secs = new Map<string, number>();
  for (const s of t) for (const p of s.points) secs.set(p, (secs.get(p) ?? 0) + (s.end - s.start) / s.points.length);
  const rows = [...secs].sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '';
  const max = rows[0][1];
  return `<div class="bars">${rows.map(([name, v]) => `<div class="bar"><span>${h(name)}</span><div class="track"><i style="width:${(v / max) * 100}%"></i></div><b>${minutes(v)} · ${pct(v, total)}</b></div>`).join('')}</div>`;
}

/** 会议纪要网页：版式见 docs/meeting-report.html */
function renderMeeting(d: ReportData, m: MeetingReport) {
  const at = (t: number | null) => (t === null ? '' : clock(t));
  const sections = m.sections.map((s, i) => ({ ...s, i: i % PHASES.length, secs: s.items.reduce((a, it) => a + it.end - it.start, 0) }));
  const items = sections.flatMap(s => s.items.map(it => ({ ...it, i: s.i, section: s.title })));
  const end = Math.max(...items.map(it => it.end));
  const total = sections.reduce((a, s) => a + s.secs, 0);
  const talk = m.speakers.reduce((a, [, v]) => a + v, 0);
  const blocks: Array<[string, string]> = [
    ['决定事项', m.decisions.length ? `<ol class="decisions">${m.decisions.map(x => `<li>${x.time === null ? '' : `<span class="when">${at(x.time)}</span>`}<span>${h(x.text)}</span></li>`).join('')}</ol>` : '<p class="meta">这场会没有明确拍板的事项。</p>'],
    ['待办事项', m.todos.length ? `<div class="table-wrap"><table class="todos"><thead><tr><th scope="col">事项</th><th scope="col">负责人</th><th scope="col">截止</th><th scope="col">时间点</th></tr></thead><tbody>${m.todos.map(t => `<tr><td>${h(t.task)}</td><td class="${t.owner ? '' : 'practice'}">${h(t.owner || '待认领')}</td><td>${h(t.due || '—')}</td><td class="when">${at(t.time)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="meta">没有明确的待办。</p>'],
    ['会议时间分布', `<div class="tl" role="img" aria-label="${h(sections.map(s => `${s.title}${minutes(s.secs)}`).join('，'))}">${items.map(it => `<i class="p${it.i}" style="left:${(it.start / end) * 100}%;width:${((it.end - it.start) / end) * 100}%" title="${h(`${clock(it.start)}–${clock(it.end)} ${it.section} · ${it.title}`)}"></i>`).join('')}</div>
      <div class="tl-axis"><span>00:00</span><span>${clock(end / 2)}</span><span>${clock(end)}</span></div>
      <ul class="legend">${sections.map(s => `<li><i class="p${s.i}"></i>${h(s.title)}<b>${minutes(s.secs)}</b><span>${pct(s.secs, total)}</span></li>`).join('')}</ul>`],
    ['议题详情', sections.map(s => `<div class="agenda"><h3><i class="p${s.i}"></i>${h(s.title)}<span>${s.items.length} 项</span></h3><ol class="steps">${s.items.map(it => `<li><span class="when">${clock(it.start)}–${clock(it.end)}</span><b>${h(it.title)}</b><span class="${it.conclusion === '未定' ? 'practice' : ''}">${h(it.conclusion)}</span></li>`).join('')}</ol></div>`).join('')],
    ...(m.followups.length ? [['待跟进', `<ul>${m.followups.map(f => `<li>${h(f)}</li>`).join('')}</ul>`] as [string, string]] : []),
    ...(talk ? [['发言占比', `<div class="bars">${m.speakers.map(([name, v]) => `<div class="bar"><span>${h(name)}</span><div class="track"><i style="width:${(v / m.speakers[0][1]) * 100}%"></i></div><b>${minutes(v)} · ${pct(v, talk)}</b></div>`).join('')}</div><p class="meta" style="margin-top:10px">说话人由录音自动区分，同一个人可能被分成两个编号。</p>`] as [string, string]] : []),
  ];
  document.title = `${m.title}_${d.date}_会议纪要`;
  root.innerHTML = `
    <div class="brand"><span class="mark">菁</span>菁仕教育</div>
    <div class="eyebrow">会议纪要</div><h1>${h(m.title)}</h1>
    <p class="meta">${[d.date.replaceAll('-', '.'), d.time, m.speakers.length ? `${m.speakers.length} 位发言人` : ''].filter(Boolean).map(h).join(' · ')}</p>
    <p class="lead">${h(m.lead)}</p>
    <div class="facts four"><div><small>会议时长</small><b>${h(d.mins || Math.round(end / 60))} 分钟</b></div><div><small>议题</small><b>${items.length} 个</b></div><div><small>决定</small><b>${m.decisions.length} 项</b></div><div><small>待办</small><b>${m.todos.length} 项</b></div></div>
    ${blocks.map(([title, body], i) => `<section><h2><small>${String(i + 1).padStart(2, '0')}</small>${title}</h2>${body}</section>`).join('')}
    <footer class="foot">菁仕教育 · 内容由会议录音整理，说话人和错字以实际会议为准。</footer>`;
  download.hidden = false;
}

function render(d: ReportData) {
  if (d.kind === 'meeting') return renderMeeting(d, d.report as unknown as MeetingReport);
  const r = d.report;
  const timeline = r.timeline ?? [];
  const questions = r.questions ?? [];
  const pointTime = timeline.length ? pointTimeSection(timeline) : '';
  // 旧报告没有时间轴 / 提问，对应板块整块不显示，编号顺延
  const top: Array<[string, string]> = [
    ['本课学习内容', `<ul>${r.content.map(line => `<li>${h(line.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ul>`],
    ...(timeline.length ? [['课堂时间分布', timelineSection(timeline)] as [string, string]] : []),
    ...(pointTime ? [['知识点用时', pointTime] as [string, string]] : []),
    ['知识点掌握情况', `<div class="table-wrap"><table><thead><tr><th scope="col">知识点</th><th scope="col">课堂表现</th><th scope="col">判断依据</th></tr></thead><tbody>${r.mastery.map(m => `<tr><td>${h(m.name)}</td><td class="${m.status === '需要巩固' ? 'practice' : 'good'}">${h(m.status)}</td><td class="evidence">${h(m.evidence)}</td></tr>`).join('')}</tbody></table></div>`],
  ];
  const bottom: Array<[string, string]> = [
    ...(questions.length ? [['主动提问', `<p class="meta">${h(d.student || '学生')}这节课主动提了 ${questions.length} 个问题：</p><div class="qs">${questions.map(q => `<figure class="q">${q.time === null ? '' : `<span class="when">${clock(q.time)}</span>`}<blockquote>“${h(q.text)}”</blockquote>${q.answer ? `<figcaption>${h(q.answer)}</figcaption>` : ''}</figure>`).join('')}</div>`] as [string, string]] : []),
    ['学生课堂表现', `<p class="insight">${h(r.performance)}</p>`],
    ['易错点与改进方法', `<div class="issue"><b>${h(r.issue.title)}</b><p>${h(r.issue.fix)}</p></div>`],
    ['课后巩固计划', `<div class="plan"><div><h3>作业与练习</h3><p>${h(r.homework)}</p></div><div><h3>复习方法</h3><p>${h(r.review)}</p></div></div>`],
    ['下节课衔接', `<p>${h(r.next)}</p>`],
  ];
  const section = ([title, body]: [string, string], i: number) => `<section><h2><small>${String(i + 1).padStart(2, '0')}</small>${title}</h2>${body}</section>`;
  const teacher = /^[一-龥]+$/.test(d.teacher) ? `${d.teacher}老师` : d.teacher;
  document.title = `${d.student}_${d.course}_${d.date}_课堂学情报告`; // 打印另存 PDF 时浏览器用它作文件名
  root.innerHTML = `
    <div class="brand"><span class="mark">菁</span>菁仕教育</div>
    <div class="eyebrow">课堂学情报告</div><h1>${[d.course, r.topic].filter(Boolean).map(h).join(' · ')}</h1>
    <p class="meta">${[d.student, teacher, d.date.replaceAll('-', '.'), d.time].filter(Boolean).map(h).join(' · ')}</p>
    ${d.gapMinutes > 0 ? `<p class="meta">录音缺失约 ${h(d.gapMinutes)} 分钟，以下内容依据已收到的录音整理。</p>` : ''}
    <p class="lead">${h(r.lead)}</p>
    <div class="facts"><div><small>学生</small><b>${h(d.student || '—')}</b></div><div><small>课堂记录时长</small><b>${h(d.mins)} 分钟</b></div><div><small>学习重点</small><b>${r.mastery.length} 项</b></div></div>
    ${top.map(section).join('')}
    <div class="report-bottom">
      ${bottom.map((s, i) => section(s, top.length + i)).join('')}
      <footer class="foot">菁仕教育 · 内容由课堂录音整理，网页版与 PDF 内容一致。</footer>
    </div>`;
  download.hidden = false;
}

// ponytail: PDF 用浏览器打印另存（@media print 已排好 A4），不做服务端生成；需要一键直出 .pdf 文件时再加服务端渲染。
download.addEventListener('click', () => window.print());

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
  const token = new URLSearchParams(location.search).get('t');
  if (!token) return message('未找到这份课堂报告', '请从菁仕课堂中选择已完成的课程，再打开完整报告。');
  try {
    const response = await fetch(`/classroom-api/report?t=${encodeURIComponent(token)}`);
    if (response.status === 404) return message('未找到这份课堂报告', '请从菁仕课堂中选择已完成的课程，再打开完整报告。');
    if (!response.ok) throw new Error(String(response.status));
    render(await response.json() as ReportData);
  } catch {
    message('暂时无法打开报告', '网络或服务暂时不可用，请稍后刷新重试。');
  }
}
load();
