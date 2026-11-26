import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { monthlyTeacherDone, nextMonthlyTeacher, PARENT_IDENTITY, STUDENT_IDENTITY } from "@/domain/monthly-feedback";
import type { MonthlyFeedback, MonthlyIdentity, MonthlyTeacher } from "@/domain/monthly-feedback";
import { IDENTITY_OPTIONS, isAnswered, monthlyQuestions, OTHER_MAX, OTHER_OPTION, SUGGESTION_MAX } from "@/domain/monthly-questions";
import type { MonthlyAnswers, MonthlyQuestion } from "@/domain/monthly-questions";

import { FeedbackThanksDialog, type ThanksGift, type ThanksResult } from "./FeedbackThanksDialog";
import { DEMO_TOKEN, demoRequest, resetDemo } from "./monthly-demo";
import "./monthly-feedback.css";

// 学生月度反馈：一屏一题，答案写回飞书答卷表（feedback-api 的 submit），评完一位老师接感谢礼。设计稿 docs/student-feedback-demo/v9.html。
const token = window.location.hash.slice(1);
const demo = token === DEMO_TOKEN;
const logo = "/feedback/logo-blue.svg";

type Confirmation = MonthlyFeedback & { thanks?: { gifts: ThanksGift[] } };
type PendingThanks = { taskId: string; identity: MonthlyIdentity; gifts: ThanksGift[] };
type Draft = { identity: MonthlyIdentity | ""; a: MonthlyAnswers; i: number };
type Sent = { id: string; identity: MonthlyIdentity; gift: boolean; settled: boolean; play: boolean };
type Step = { kind: "identity" } | { kind: "question"; q: MonthlyQuestion } | { kind: "end" };

const IDENTITY_STEP: Step = { kind: "identity" };
const END_STEP: Step = { kind: "end" };
const steps = (draft: Draft): Step[] =>
  [IDENTITY_STEP, ...(draft.identity ? monthlyQuestions(draft.identity).map((q): Step => ({ kind: "question", q })) : []), END_STEP];
const freshDraft = (): Draft => ({ identity: "", a: {}, i: 0 });
const full = (t: MonthlyTeacher) => t.studentDone && t.parentDone;
const pad = (n: number) => String(n).padStart(2, "0");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 体验版默认忽略系统「减少动态效果」，开了这项的电脑也能看到动效；正式页面照系统设置
const reduced = () => !demo && matchMedia("(prefers-reduced-motion: reduce)").matches;
// 「改进方面」里选了「已经很好了」就不能再选具体改进项，反之亦然
const NONE_OPTION = "已经很好了，没有需要提升的";
// 旧版 iOS（15.4 以下）的微信没有 <dialog>，感谢礼弹窗打不开，就不弹
const canDialog = typeof HTMLDialogElement === "function" && "showModal" in HTMLDialogElement.prototype;

// 草稿按任务存在这台设备上；兄弟姐妹共用手机时各是各的
const prefix = demo ? "feedback.demo." : "feedback.m.";
const store = {
  get<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(prefix + key) ?? "null"); } catch { return null; } },
  set(key: string, value: unknown) { try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* Private mode: no draft recovery. */ } },
  del(key: string) { try { localStorage.removeItem(prefix + key); } catch { /* ignore */ } },
};
function readDraft(taskId: string): Draft {
  const saved = store.get<Draft>("draft." + taskId);
  if (!saved || typeof saved !== "object" || typeof saved.a !== "object" || !saved.a) return freshDraft();
  return { identity: IDENTITY_OPTIONS.includes(saved.identity as MonthlyIdentity) ? saved.identity : "", a: saved.a, i: Number(saved.i) || 0 };
}

// 换身份：手上这份草稿按原身份收起来，换成新身份收起过的那份（家长和学生共用手机时互不覆盖）
function swapDraft(taskId: string, d: Draft, identity: MonthlyIdentity): Draft {
  if (d.identity === identity) return d;
  if (d.identity && Object.keys(d.a).length) store.set(`draft.${taskId}.${d.identity}`, d);
  const kept = store.get<Draft>(`draft.${taskId}.${identity}`);
  store.del(`draft.${taskId}.${identity}`);
  if (kept && typeof kept.a === "object" && kept.a) return { identity, a: kept.a, i: Number(kept.i) || 1 };
  return d.identity ? { identity, a: {}, i: 1 } : { ...d, identity };
}

const pendingKey = "feedback.pending-thanks";
function rememberThanks(pending?: PendingThanks) {
  try {
    if (pending?.gifts.length) sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* Private browsing or full storage can disable refresh recovery. */ }
}
function recoverThanks(data: MonthlyFeedback): PendingThanks | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    if (data.closed || !stored || ![STUDENT_IDENTITY, PARENT_IDENTITY].includes(stored.identity)) return;
    const teacher = data.teachers.find((entry) => entry.id === stored.taskId);
    if (!teacher || !monthlyTeacherDone(teacher, stored.identity) || !Array.isArray(stored.gifts) || !stored.gifts.length) return;
    if (!stored.gifts.every((gift: ThanksGift) => gift?.enabled === true && typeof gift.id === "string"
      && typeof gift.label === "string" && typeof gift.description === "string" && Number.isFinite(gift.value)
      && (gift.photo === null || (typeof gift.photo === "string" && gift.photo.startsWith("data:image/webp;base64,"))))) return;
    return stored;
  } catch { return; }
}

async function requestFeedback<T>(input: Record<string, unknown> | undefined, fallback: string): Promise<T> {
  if (demo) {
    try { return await demoRequest(input ?? {}) as T; } catch (cause) { throw cause instanceof Error ? cause : new Error(fallback); }
  }
  let response: Response, result;
  // AbortSignal.timeout 在 iOS 16 以下的微信里没有，手动计时；读完响应体才停表
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 25_000);
  try {
    response = await fetch("/auth/monthly-feedback", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ token, ...input }), signal: abort.signal,
    });
    result = await response.json().catch(() => null);
  } catch {
    throw new Error(fallback);
  } finally {
    clearTimeout(timer);
  }
  if (input?.action === "thanks" && response.status === 409 && result?.error && Array.isArray(result.thanks?.gifts)) return result;
  if (!response.ok || !result || result.error || (input?.action === "thanks" && result.ok !== true)) {
    throw new Error(result?.error && result.error !== "INTERNAL_ERROR" ? result.error : fallback);
  }
  return result;
}

const svg = (d: ReactNode, props: { viewBox?: string; className?: string; stroke?: string } = {}) => (
  <svg viewBox={props.viewBox ?? "0 0 24 24"} className={props.className} fill="none" stroke={props.stroke ?? "currentColor"} strokeWidth="2.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const CheckIcon = () => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />);
const ArrowIcon = () => svg(<path d="M5 12h14M13 6l6 6-6 6" />);
const ChevIcon = () => svg(<path d="M9 5l7 7-7 7" />, { className: "chev" });
const WarnIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l10 17.6H2z" fill="#c2620c" /><path d="M12 9.5v5M12 17.2v.3" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" /></svg>
);
// 状态图形：待评价=虚线空心圈，一方已评=描边圈加勾，双方已评=实心圈加勾（不靠颜色区分）
function Status({ teacher }: { teacher: MonthlyTeacher }) {
  const kind = full(teacher) ? "full" : monthlyTeacherDone(teacher) ? "part" : "none";
  const label = full(teacher) ? "双方已评" : teacher.studentDone ? "学生已评" : teacher.parentDone ? "家长已评" : "待评价";
  return (
    <span className={`st ${kind}`}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        {kind === "none" && <circle cx="6" cy="6" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.6" />}
        {kind === "part" && <><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.6 6.2l1.6 1.6 3.2-3.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>}
        {kind === "full" && <><circle cx="6" cy="6" r="6" fill="currentColor" /><path d="M3.4 6.2l1.8 1.8 3.4-3.5" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>}
      </svg>{label}
    </span>
  );
}
function optionLabel(option: string) {
  const [head, detail] = option.split(" — ");
  return detail ? <><b>{head}</b><span className="o-d">{detail}</span></> : option;
}

// 圆章弹出时，纸屑从圆章向上炸开再飘落，约 1.5 秒；只用品牌深蓝和金色
function burst(origin: Element | null) {
  if (!origin) return;
  const rect = origin.getBoundingClientRect(), cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const colors = ["#0e2848", "#ba8d45", "#3d6aa3", "#d9b878", "#9fb4cf"];
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement("i"), angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5, speed = 110 + Math.random() * 130;
    const dx = Math.cos(angle) * speed, dy = Math.sin(angle) * speed, fall = 170 + Math.random() * 140, rot = (Math.random() - 0.5) * 900;
    piece.className = "mf-confetti" + (i % 4 === 3 ? " dot" : "");
    piece.style.cssText = `left:${cx}px;top:${cy}px;background:${colors[i % colors.length]}`;
    document.body.append(piece);
    piece.animate([
      { transform: "translate(-50%,-50%) scale(.4)", opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) rotate(${rot / 2}deg) rotateX(${rot}deg)`, opacity: 1, offset: 0.32 },
      { transform: `translate(calc(-50% + ${dx * 1.3}px),calc(-50% + ${dy + fall}px)) rotate(${rot}deg) rotateX(${rot * 2}deg)`, opacity: 0 },
    ], { duration: 1300 + Math.random() * 500, easing: "cubic-bezier(.15,.75,.35,1)", fill: "forwards" }).onfinish = () => piece.remove();
  }
}

export function MonthlyFeedbackPage() {
  const [feedback, setFeedback] = useState<MonthlyFeedback>();
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<"hub" | "form" | "sent">("hub");
  const [sel, setSel] = useState("");
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [idx, setIdx] = useState(0);
  const [screen, setScreen] = useState({ n: 0, anim: "in-fade" });
  const [miss, setMiss] = useState(false);
  const [blink, setBlink] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const [sent, setSent] = useState<Sent>();
  const [offer, setOffer] = useState<PendingThanks>();
  const [flash, setFlash] = useState("");
  const [toast, setToast] = useState({ n: 0, text: "" });

  const stage = useRef<HTMLElement>(null);
  const ghosts = useRef<HTMLDivElement>(null);
  const chips = useRef<HTMLElement>(null);
  const other = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const settling = useRef(false);
  const gen = useRef(0);
  // Timers read the latest state through this ref, not the render they were scheduled in.
  const live = useRef({ feedback, view, sel, draft, idx, busy, offer });
  live.current = { feedback, view, sel, draft, idx, busy, offer };

  async function load() {
    setLoadError("");
    try {
      if (!token) throw new Error("请打开教务发送的月度反馈链接。");
      const data = await requestFeedback<MonthlyFeedback>(undefined, "暂时无法读取反馈进度，请重试。");
      setFeedback(data);
      document.title = `${Number(data.courseMonth.slice(5))}月课程反馈 · ${data.studentName}`;
      const pending = recoverThanks(data);
      rememberThanks(pending);
      if (pending) {
        setSel(pending.taskId);
        setSent({ id: pending.taskId, identity: pending.identity, gift: false, settled: false, play: false });
        setView("sent");
        setOffer(pending);
        return;
      }
      const resume = !data.closed && data.teachers.find((t) => !full(t) && Object.keys(readDraft(t.id).a).length);
      if (resume) openTeacher(resume.id, data, true);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "暂时无法打开，请重试。");
    }
  }
  useEffect(() => { void load(); }, []);

  // 换屏：旧屏复制一份钉在原位淡出，新屏进场；dir 1 = 下一题，-1 = 上一题，0 = 淡入
  function go(dir: number, apply: () => void) {
    const calm = reduced(), old = stage.current?.firstElementChild as HTMLElement | null;
    if (old && ghosts.current) {
      const rect = old.getBoundingClientRect(), ghost = old.cloneNode(true) as HTMLElement;
      Object.assign(ghost.style, { position: "fixed", top: rect.top + "px", left: rect.left + "px", width: rect.width + "px", margin: "0", pointerEvents: "none" });
      ghost.inert = true;
      ghost.classList.remove("in-up", "in-down", "in-fade", "play");
      ghost.classList.add(calm || !dir ? "out-fade" : dir > 0 ? "out-up" : "out-down");
      ghosts.current.append(ghost);
      setTimeout(() => ghost.remove(), 340);
    }
    setMiss(false);
    setBlink("");
    apply();
    setScreen((s) => ({ n: s.n + 1, anim: calm || !dir ? "in-fade" : dir > 0 ? "in-up" : "in-down" }));
    // 新题进场时不收选项点击，避免连点落到下一题的选项上
    settling.current = true;
    setTimeout(() => { settling.current = false; }, 420);
  }

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    const el = stage.current?.firstElementChild;
    (el?.querySelector("h1,h2") as HTMLElement | null)?.focus({ preventScroll: true });
    const area = el?.querySelector("textarea");
    if (area) area.style.height = area.scrollHeight + "px";
  }, [screen.n]);
  // 感谢礼弹窗关掉后焦点交给「继续评价」，读屏和键盘用户不会落空
  useEffect(() => {
    if (sent?.settled) stage.current?.querySelector<HTMLElement>(".sent .act .cta")?.focus({ preventScroll: true });
  }, [sent?.settled]);
  useLayoutEffect(() => {
    const on = chips.current?.querySelector<HTMLElement>(".on");
    if (on && chips.current) chips.current.scrollLeft = on.offsetLeft - (chips.current.clientWidth - on.offsetWidth) / 2;
  }, [sel, view]);

  function saveDraft(taskId: string, next: Draft) { store.set("draft." + taskId, next); }
  function showToast(text: string) { setToast((t) => ({ n: t.n + 1, text })); }

  // carry：从完成页点「继续评价」，同一个人接着评，用他刚才的身份从第一题开始（上一题仍可改身份）
  function openTeacher(id: string, data = live.current.feedback, announce = false, carry?: MonthlyIdentity) {
    const teacher = data?.teachers.find((t) => t.id === id);
    if (!data || !teacher || data.closed || full(teacher)) return;
    gen.current++;
    lock.current = false;
    let next = readDraft(id);
    if (next.identity && monthlyTeacherDone(teacher, next.identity)) next = freshDraft();
    if (carry && !monthlyTeacherDone(teacher, carry)) {
      next = swapDraft(id, next, carry);
      next = { ...next, i: Math.max(next.i, 1) };
      saveDraft(id, next);
    } else if (!next.identity) {
      const last = store.get<MonthlyIdentity>("identity");
      if (last && IDENTITY_OPTIONS.includes(last) && !monthlyTeacherDone(teacher, last)) next = { ...next, identity: last };
    }
    const at = Math.min(Math.max(next.i, 0), steps(next).length - 1);
    go(1, () => { setSel(id); setView("form"); setDraft(next); setIdx(at); setFailed(""); setSent(undefined); });
    if (announce) showToast("已恢复上次未提交的内容");
  }
  function hub() {
    gen.current++;
    lock.current = false;
    go(0, () => { setView("hub"); setSent(undefined); });
  }

  const required = (step: Step) => step.kind === "identity" || (step.kind === "question" && step.q.required);
  const answered = (step: Step, d: Draft) => step.kind === "identity" ? Boolean(d.identity) : step.kind === "question" ? isAnswered(step.q, d.a) : true;

  function flagMiss() {
    setMiss(true);
    const opts = stage.current?.querySelector(".opts");
    if (opts && !reduced()) { opts.classList.remove("shake"); void (opts as HTMLElement).offsetWidth; opts.classList.add("shake"); }
  }
  // 单选选中后会自动进下一题；这期间和新题进场时不收「确定」「上一题」，免得一下跳两题
  const moving = () => lock.current || settling.current;
  function next() {
    if (moving()) return;
    const { draft: d, idx: i, sel: id } = live.current;
    const step = steps(d)[i];
    if (!step || step.kind === "end") return;
    if (required(step) && !answered(step, d)) return flagMiss();
    const to = i + 1;
    saveDraft(id, { ...d, i: to });
    go(1, () => setIdx(to));
  }
  function prev() {
    if (moving()) return;
    const { draft: d, idx: i, sel: id } = live.current;
    if (i <= 0) return;
    saveDraft(id, { ...d, i: i - 1 });
    go(-1, () => setIdx(i - 1));
  }
  function pick(option: string) {
    if (lock.current || settling.current || live.current.busy) return;
    const { draft: d, idx: i, sel: id } = live.current;
    const step = steps(d)[i];
    let updated: Draft;
    if (step.kind === "identity") updated = swapDraft(id, d, option as MonthlyIdentity);
    else if (step.kind === "question" && step.q.type === "multi") {
      const set = new Set((d.a[step.q.field] as string[] | undefined) ?? []);
      if (set.has(option)) set.delete(option);
      else { if (option === NONE_OPTION) set.clear(); else set.delete(NONE_OPTION); set.add(option); }
      updated = { ...d, a: { ...d.a, [step.q.field]: [...set] } };
    } else if (step.kind === "question") updated = { ...d, a: { ...d.a, [step.q.field]: option } };
    else return;
    updated.i = i;
    setDraft(updated);
    saveDraft(id, updated);
    live.current.draft = updated;
    setMiss(false);
    const single = step.kind === "identity" || (step.kind === "question" && step.q.type === "single");
    if (option === OTHER_OPTION && step.kind === "question" && step.q.otherField) {
      requestAnimationFrame(() => other.current?.focus());
      return;
    }
    if (!single) return;
    // 单选：选中的那项闪两下，再进下一题
    const g = gen.current;
    lock.current = true;
    setBlink(option);
    setTimeout(() => { if (g !== gen.current) return; lock.current = false; next(); }, reduced() ? 150 : 460);
  }
  function write(field: string, value: string) {
    const { draft: d, sel: id, idx: i } = live.current;
    const updated = { ...d, a: { ...d.a, [field]: value }, i };
    setDraft(updated);
    saveDraft(id, updated);
  }

  async function submit() {
    const { draft: d, sel: id, feedback: data, busy: running } = live.current;
    if (running || !data || !d.identity) return;
    const identity = d.identity;
    const questions = monthlyQuestions(identity);
    const gap = questions.findIndex((q) => q.required && !isAnswered(q, d.a));
    if (gap >= 0) { // 必填没答：回到第一道没答的
      saveDraft(id, { ...d, i: gap + 1 });
      go(-1, () => { setIdx(gap + 1); setMiss(true); });
      return;
    }
    // 换过身份时，另一分支的答案不交
    const answers = Object.fromEntries(questions.flatMap((q) => [q.field, q.otherField ?? []].flat())
      .filter((field) => d.a[field] !== undefined).map((field) => [field, d.a[field]]));
    const g = gen.current;
    new Image().src = "/feedback/thanks/envelope.webp"; // 感谢礼弹窗的信封图先加载，弹出时不空白
    setBusy(true);
    setFailed("");
    let result: Confirmation;
    try {
      result = await requestFeedback<Confirmation>({ action: "submit", taskId: id, identity, answers, includeThanks: true },
        "提交没有成功，填写的内容已保留。请检查网络后重新提交。");
      const teacher = result.teachers.find((t) => t.id === id);
      if (!teacher || !monthlyTeacherDone(teacher, identity)) throw new Error("提交没有成功，请重试。");
    } catch (cause) {
      setBusy(false);
      setFailed(cause instanceof Error ? cause.message : "提交没有成功，请重试。");
      return;
    }
    setBusy(false);
    store.del("draft." + id);
    store.set("identity", identity);
    setFeedback(result);
    if (g !== gen.current) return;
    const calm = reduced();
    go(0, () => { setView("sent"); setSent({ id, identity, gift: false, settled: false, play: true }); setFlash(id); });
    if (!calm) setTimeout(() => { if (g === gen.current) burst(stage.current?.querySelector(".seal") ?? null); }, 380);
    await wait(calm ? 600 : 1300);
    if (g !== gen.current) return;
    const gifts = result.thanks?.gifts.filter((gift) => gift.enabled) ?? [];
    if (!result.closed && gifts.length && canDialog) {
      const pending = { taskId: id, identity, gifts };
      rememberThanks(pending);
      setOffer(pending);
    } else setSent((s) => s && { ...s, settled: true });
  }

  useEffect(() => {
    // 电脑上：字母键选选项、回车确定
    function onKey(event: KeyboardEvent) {
      const { view: v, draft: d, idx: i, busy: running, offer: dialog } = live.current;
      if (event.isComposing || v !== "form" || lock.current || settling.current || running || dialog || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement).tagName;
      const step = steps(d)[i];
      if (event.key === "Enter" && tag !== "TEXTAREA" && tag !== "BUTTON") {
        event.preventDefault();
        if (step.kind === "end") void submit(); else next();
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const at = "ABCDEFGHIJ".indexOf(event.key.toUpperCase());
      const button = at >= 0 ? stage.current?.querySelectorAll<HTMLButtonElement>(".opt")[at] : undefined;
      if (button && !button.disabled) pick(button.dataset.o!);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!feedback) {
    return (
      <div className="mf">
        <main className="stage"><section className="screen">
          <h2>{loadError ? "暂时无法打开" : "正在读取本月反馈…"}</h2>
          {loadError && <><p className="sum" role="alert">{loadError}</p>
            {token && <div className="act"><button className="cta" onClick={() => void load()}>重新读取</button></div>}</>}
        </section></main>
      </div>
    );
  }

  const month = `${Number(feedback.courseMonth.slice(5))}月`;
  const teacher = feedback.teachers.find((t) => t.id === sel);
  const list = steps(draft);
  const step = list[Math.min(idx, list.length - 1)];
  const screenClass = `screen ${screen.anim}`;

  let body: ReactNode;
  if (view === "hub" || !teacher) {
    const all = feedback.teachers.every(full);
    // 这台设备上提交过的身份：进度和「下一位」按这个身份算；没提交过就按任一方已评算
    const remembered = store.get<MonthlyIdentity>("identity");
    const me = remembered && IDENTITY_OPTIONS.includes(remembered) ? remembered : undefined;
    const first = me ? nextMonthlyTeacher(feedback.teachers, me) : nextMonthlyTeacher(feedback.teachers) ?? feedback.teachers.find((t) => !full(t));
    const doneCount = feedback.teachers.filter((t) => monthlyTeacherDone(t, me)).length;
    body = (
      <section className={`${screenClass} hub`} key={screen.n}>
        <div className="hero">
          <p className="eyebrow"><img src={logo} alt="" />菁仕教育</p>
          <h1 tabIndex={-1}>{feedback.closed ? `${month}反馈已截止` : all ? <><CheckIcon />{month}反馈已全部提交</> : `${month}课程反馈`}</h1>
          <p className="meta">学生 {feedback.studentName} · {me
            ? <>您已评价 <b>{doneCount}/{feedback.teachers.length}</b> 位老师</>
            : <><b>{doneCount}/{feedback.teachers.length}</b> 位老师已有反馈</>}</p>
          <div className="tcards">
            {feedback.teachers.map((t, i) => {
              const can = !feedback.closed && !full(t);
              // 下一位该评的老师用白底卡片突出，和答题页的老师条一致
              const className = `tcard${can && t === first ? " next" : ""}`;
              const inner = <><span className="av" aria-hidden="true">{t.name[0]}</span>
                <span className="tc"><b>{t.name}</b><small>{t.courses.join(" · ")}</small><Status teacher={t} /></span>{can && <ChevIcon />}</>;
              const style = { "--i": i } as CSSProperties;
              return can
                ? <button key={t.id} className={className} style={style} onClick={() => openTeacher(t.id)}>{inner}</button>
                : <div key={t.id} className={className} style={style}>{inner}</div>;
            })}
          </div>
        </div>
        {!feedback.closed && first && <button className="cta" onClick={() => openTeacher(first.id)}>开始评价{first.name}<ArrowIcon /></button>}
        {feedback.closed && <p className="foot">如需补充评价，请联系教务老师。</p>}
        {demo && <p className="foot">体验版：答案只保存在这台设备上，不会写入飞书。<button className="link" onClick={() => { resetDemo(); location.reload(); }}>重新开始体验</button></p>}
      </section>
    );
  } else if (view === "sent" && sent) {
    const following = sent.settled ? nextMonthlyTeacher(feedback.teachers, sent.identity, sent.id) : undefined;
    body = (
      <section className={`${screenClass} sent${sent.play ? " play" : ""}`} key={screen.n}>
        <div className="seal" aria-hidden="true"><span className="halo" /><span className="halo h2" />
          <svg viewBox="0 0 64 64"><circle className="disc" cx="32" cy="32" r="32" /><path className="tk" d="M20.5 33l7.5 7.5L44 24.5" /></svg></div>
        <h2 tabIndex={-1}>已提交对{teacher.name}的评价</h2>
        {sent.gift && <p className="sum">感谢礼已登记，菁仕教育将为您转达</p>}
        {sent.settled && <div className="act in-fade">
          {following ? <><button className="cta" onClick={() => openTeacher(following.id, undefined, false, sent.identity)}>继续评价{following.name}<ArrowIcon /></button>
            <button className="link" onClick={hub}>查看全部老师</button></>
            : <button className="cta" onClick={hub}>查看全部老师</button>}
        </div>}
      </section>
    );
  } else if (step.kind === "end") {
    const questions = draft.identity ? monthlyQuestions(draft.identity) : [];
    const skipped = questions.filter((q) => !isAnswered(q, draft.a)).length;
    body = (
      <section className={`${screenClass} end`} key={screen.n}>
        <h2 tabIndex={-1}>提交对{teacher.name}的评价</h2>
        <p className="sum">{draft.identity} · {skipped ? `已答 ${questions.length - skipped} 题，跳过 ${skipped} 道选填题` : `已答完全部 ${questions.length} 题`}</p>
        <div className="act">
          <button className="prev" disabled={busy} onClick={prev}>上一题</button>
          <button className="cta" disabled={busy} aria-busy={busy || undefined} onClick={() => void submit()}>
            {busy ? <><span className="spin" />正在提交…</> : failed ? "重新提交" : "提交"}
          </button>
        </div>
        {failed && <p className="err" role="alert"><WarnIcon />{failed}</p>}
      </section>
    );
  } else {
    const q = step.kind === "question" ? step.q : undefined;
    const title = q ? q.title : "请选择您的身份";
    const options = q ? q.options ?? [] : IDENTITY_OPTIONS;
    const value = q ? draft.a[q.field] : draft.identity;
    const selected = (option: string) => Array.isArray(value) ? value.includes(option) : value === option;
    const showOther = Boolean(q?.otherField) && selected(OTHER_OPTION);
    body = (
      <section className={`${screenClass}${miss ? " miss" : ""}`} key={screen.n}>
        <p className="qn">{pad(idx + 1)}{draft.identity && <span>/ {pad(list.length - 1)}</span>}</p>
        <h2 tabIndex={-1}>{title}{required(step) && <span className="req" aria-label="必填">*</span>}</h2>
        {q?.type === "multi" && <p className="hint">可多选</p>}
        {q?.type === "text" ? <>
          <textarea className="line" rows={1} maxLength={SUGGESTION_MAX} placeholder="在这里输入您的建议" aria-label={title}
            value={(value as string | undefined) ?? ""} onChange={(event) => {
              event.target.style.height = "auto";
              event.target.style.height = event.target.scrollHeight + "px";
              write(q.field, event.target.value);
            }} />
          <p className="count">{((value as string | undefined) ?? "").length}/{SUGGESTION_MAX}</p>
        </> : <>
          <div className="opts" role="group" aria-label={title} aria-describedby={miss ? "mf-err" : undefined}>
            {options.map((option, i) => {
              const taken = !q && monthlyTeacherDone(teacher, option as MonthlyIdentity);
              return (
                <button key={option} className={`opt${blink === option ? " blink" : ""}`} style={{ "--i": i } as CSSProperties} data-o={option}
                  aria-pressed={selected(option)} disabled={taken} onClick={() => pick(option)}>
                  <span className="lab">{optionLabel(option)}</span>
                  {taken ? <span className="aside">已提交</span> : <span className="tick"><CheckIcon /></span>}
                </button>
              );
            })}
          </div>
          {showOther && q?.otherField && <input ref={other} className="line other" placeholder="请补充其他内容" aria-label="其他内容" maxLength={OTHER_MAX}
            value={(draft.a[q.otherField] as string | undefined) ?? ""} onChange={(event) => write(q.otherField!, event.target.value)} />}
        </>}
        <div className="act">
          {idx > 0 && <button className="prev" onClick={prev}>上一题</button>}
          <button className="ok" onClick={next}>{!required(step) && !answered(step, draft) ? "跳过" : "确定"}<CheckIcon /></button>
          {miss && <p className="err" id="mf-err" role="alert"><WarnIcon />请选择一项</p>}
        </div>
      </section>
    );
  }

  const progress = view === "sent" ? 1 : idx / Math.max(list.length - 1, 1);
  return (
    <div className={`mf${reduced() ? " calm" : ""}`}>
      {view !== "hub" && teacher && <div className="top">
        <div className="brand"><img src={logo} alt="" /><b>菁仕教育</b><span>{month}课程反馈</span></div>
        <nav className="chips" ref={chips} aria-label="本月要评价的老师"><div className="chips-in">
          {feedback.teachers.map((t) => (
            <button key={t.id + (t.id === flash ? "-pop" : "")} className={`chip${t.id === sel ? " on" : ""}${t.id === flash ? " pop" : ""}`}
              aria-current={t.id === sel || undefined} disabled={full(t) && t.id !== sel}
              onClick={() => { if (!busy && !lock.current && !(t.id === sel && view === "form")) openTeacher(t.id); }}>
              <b>{t.name}</b><Status teacher={t} />
            </button>
          ))}
        </div></nav>
        <div className="prog" role="progressbar" aria-label="答题进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ transform: `scaleX(${progress})` }} /></div>
      </div>}
      <main className="stage" ref={stage}>{body}</main>
      <div ref={ghosts} />
      {toast.n > 0 && <p className="toast show" role="status" key={toast.n}>{toast.text}</p>}
      {offer && teacher && <FeedbackThanksDialog teacher={teacher.name} gifts={offer.gifts}
        onSend={async (gift, note) => {
          const result = await requestFeedback<ThanksResult>({ action: "thanks", taskId: offer.taskId, giftId: gift.id,
            note, expectedLabel: gift.label, expectedValue: gift.value }, "感谢礼暂未确认，请重试。");
          if ("error" in result) {
            const updated = { ...offer, gifts: result.thanks.gifts.filter((item) => item.enabled) };
            rememberThanks(updated);
            setOffer(updated);
          }
          return result;
        }}
        onFinish={(given) => {
          rememberThanks();
          setOffer(undefined);
          setFlash("");
          setSent((s) => s && { ...s, gift: given, settled: true, play: false });
        }} />}
    </div>
  );
}
