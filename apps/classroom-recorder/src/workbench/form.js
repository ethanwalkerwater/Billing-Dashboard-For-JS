/**
 * 家长收集表（/classroom/workbench/form.html?t=…）：不用登录，凭链接里的随机 token。
 * 选项和建档用的是同一套画像词表，填完由 classroom-api 的 /wb-form 并进学生画像。
 */
import './styles.css';

const API = '/classroom-api/wb-form';
const token = new URLSearchParams(location.search).get('t') || '';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const done = (title, text) => { $('#fp').innerHTML = `<div class="card login"><span class="logo">菁</span><h2 style="margin:16px 0 8px;font-size:20px">${esc(title)}</h2><p class="muted" style="margin:0">${esc(text)}</p></div>`; };

async function start() {
  const res = await fetch(`${API}?t=${encodeURIComponent(token)}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return done('链接打不开', d.message || '请向老师要一个新的链接');
  document.title = `${d.name} · 学习情况收集表`;
  $('#fp').innerHTML = `
    <div class="brand"><span class="logo">菁</span><b>菁仕教育</b></div>
    <h1>${esc(d.name)}的学习情况</h1>
    <p class="muted">点选符合的，再写一句具体的情况。只给老师看。</p>
    <label class="who">您是<select class="input" id="who"><option>妈妈</option><option>爸爸</option><option>其他家人</option></select></label>
    ${d.keys.map(k => `<section class="card fb"><h3>${esc(k.key)}</h3><p class="muted sm">${esc(k.ask)}</p>
      <div class="chips">${k.tags.map(t => `<button type="button" class="chip" data-k="${esc(k.key)}">${esc(t)}</button>`).join('')}</div>
      <textarea class="input" rows="2" data-text="${esc(k.key)}" placeholder="具体说一句"></textarea></section>`).join('')}
    <button class="btn" id="send" style="width:100%;margin-top:8px">提交</button>`;
}
document.addEventListener('click', async e => {
  const chip = e.target.closest('.chip');
  if (chip) return chip.classList.toggle('on');
  if (e.target.id !== 'send') return;
  const blocks = {};
  for (const ta of document.querySelectorAll('[data-text]')) {
    const k = ta.dataset.text, tags = [...document.querySelectorAll(`.chip.on[data-k="${k}"]`)].map(b => b.textContent);
    if (tags.length || ta.value.trim()) blocks[k] = {tags, text:ta.value.trim()};
  }
  if (!Object.keys(blocks).length) return alert('至少选一项或写一句');
  e.target.disabled = true;
  const res = await fetch(`${API}?t=${encodeURIComponent(token)}`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({who:$('#who').value, blocks})});
  if (!res.ok) { e.target.disabled = false; return alert('没提交成功，请稍后再试'); }
  done('提交好了，谢谢', '老师上课前会看到这些。之后想补充，再打开这个链接填一次就行。');
});
start().catch(() => done('链接打不开', '网络不太好，请稍后再试'));
