import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COURSE_TAGS, LIMITS, filterTeachers, missingTeachers } from "../domain/share";
import type { ShareRow, SiteTeacher, TeacherFilter } from "../domain/share";
import { ApiError, callShareApi } from "./cloudbase";

const SITE = (import.meta.env.VITE_SITE_ORIGIN || "https://jsjy.asia").replace(/\/$/, "");
const linkOf = (code: string) => `${SITE}/s/${code}`;
const TITLE_PRESETS = ["雅思语培", "语培老师", "A-Level 数学", "IGCSE 理科", "竞赛老师"];

type View = { kind: "list" } | { kind: "edit"; share?: ShareRow } | { kind: "done"; share: ShareRow; refreshed: boolean; created: boolean };
type Saved = { ok: true; share: ShareRow; refreshed: boolean };

function when(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}-`;
  return `${year}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const a = document.createElement("textarea");
    a.value = text;
    document.body.append(a);
    a.select();
    document.execCommand("copy");
    a.remove();
  }
}

export function Shares({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState("");
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [teachers, setTeachers] = useState<SiteTeacher[] | null>(null);
  const [teachersError, setTeachersError] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const say = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await callShareApi<{ me: string; shares: ShareRow[] }>({ action: "list" });
      setMe(r.me);
      setShares(r.shares);
    } catch (e) {
      if (e instanceof ApiError && e.reason === "NO_ACCESS") setDenied(true);
      else if (e instanceof ApiError && e.reason === "LOGIN") onSignOut();
      else setLoadError(e instanceof Error ? e.message : "没加载出来");
    }
  }, [onSignOut]);

  const loadTeachers = useCallback(async () => {
    setTeachersError(false);
    try {
      const r = await fetch(`${SITE}/api/share-teachers`);
      if (!r.ok) throw new Error(String(r.status));
      setTeachers(((await r.json()) as { teachers: SiteTeacher[] }).teachers);
    } catch {
      setTeachersError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadTeachers();
  }, [load, loadTeachers]);

  const siteNames = useMemo(() => new Set((teachers ?? []).map((t) => t.name)), [teachers]);

  const upsert = (share: ShareRow) => setShares((list) => [share, ...(list ?? []).filter((s) => s.code !== share.code)]);

  if (denied) {
    return (
      <>
        <div className="denied-top">
          <div className="logo">菁</div>
          <b>老师分享</b>
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={onSignOut}>
            退出
          </button>
        </div>
        <div className="denied">
          <h2>只有教务能用老师分享</h2>
          <p className="mut">需要的话请管理员在反馈工作台「管理员设置」里给你开教务权限。</p>
        </div>
      </>
    );
  }

  const crumb = view.kind === "list" ? "全部链接" : view.kind === "done" ? view.share.title : view.share ? `编辑「${view.share.title}」` : "新建分享页";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">菁</div>
          <div>
            <b>菁仕教育</b>
            <span>老师分享</span>
          </div>
        </div>
        <nav className="nav">
          <button className={`nav-btn ${view.kind === "list" ? "on" : ""}`} onClick={() => setView({ kind: "list" })}>
            全部链接<span className="cnt">{shares?.length ?? ""}</span>
          </button>
          <button className={`nav-btn ${view.kind === "edit" && !view.share ? "on" : ""}`} onClick={() => setView({ kind: "edit" })}>
            新建分享页
          </button>
        </nav>
        <div className="me">
          <div className="avatar">{me.slice(0, 1)}</div>
          <div>
            <b>{me}</b>
            <button className="link-btn" onClick={onSignOut}>
              退出
            </button>
          </div>
        </div>
      </aside>
      <main>
        <div className="top">
          老师分享 / <b>{crumb}</b>
        </div>
        <div className="page">
          {view.kind === "list" ? (
            <ShareList
              shares={shares}
              loadError={loadError}
              onRetry={load}
              siteNames={teachers ? siteNames : null}
              onNew={() => setView({ kind: "edit" })}
              onEdit={(share) => setView({ kind: "edit", share })}
              onCopy={async (share) => {
                await copy(linkOf(share.code));
                say("链接已复制");
              }}
              onSaved={(r) => {
                upsert(r.share);
                const done = r.share.active ? "已恢复" : "已停用";
                say(r.refreshed ? `${done}，家长刷新就能看到` : `${done}，但官网还没刷新，请点「通知官网」`);
              }}
              onStale={async (msg) => {
                await load();
                say(msg);
              }}
              say={say}
            />
          ) : view.kind === "edit" ? (
            <Editor
              key={view.share?.code ?? "new"}
              share={view.share}
              titles={[...new Set([...TITLE_PRESETS, ...(shares ?? []).map((s) => s.title)])]}
              teachers={teachers}
              teachersError={teachersError}
              onRetryTeachers={loadTeachers}
              onCancel={() => setView({ kind: "list" })}
              onSaved={(r) => {
                upsert(r.share);
                setView({ kind: "done", share: r.share, refreshed: r.refreshed, created: !view.share });
              }}
              onStale={async (msg) => {
                await load();
                setView({ kind: "list" });
                say(msg);
              }}
            />
          ) : (
            <Done
              {...view}
              onCopy={async () => {
                await copy(linkOf(view.share.code));
                say("链接已复制");
              }}
              onRefreshed={() => setView({ ...view, refreshed: true })}
              onBack={() => setView({ kind: "list" })}
            />
          )}
        </div>
      </main>
      <div className={`toast ${toast ? "show" : ""}`} role="status">
        {toast}
      </div>
    </div>
  );
}

function ShareList(props: {
  shares: ShareRow[] | null;
  loadError: string | null;
  onRetry: () => void;
  siteNames: ReadonlySet<string> | null;
  onNew: () => void;
  onEdit: (share: ShareRow) => void;
  onCopy: (share: ShareRow) => void;
  onSaved: (r: Saved) => void;
  onStale: (message: string) => void;
  say: (text: string) => void;
}) {
  const { shares, siteNames } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  if (props.loadError) {
    return (
      <div className="empty slim">
        <h3>没加载出来</h3>
        <p>{props.loadError}</p>
        <button className="btn outline sm" onClick={props.onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (!shares) return <div className="sk" style={{ width: 240 }} />;
  if (shares.length === 0) {
    return (
      <div className="empty">
        <h3>还没有分享页</h3>
        <p>挑几位老师、写个标题，生成一条链接发给家长。</p>
        <button className="btn" onClick={props.onNew}>
          新建分享页
        </button>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q ? shares.filter((s) => s.title.toLowerCase().includes(q) || s.teachers.some((t) => t.toLowerCase().includes(q)) || s.created_by.includes(q)) : shares;

  const toggle = async (share: ShareRow) => {
    setBusy(share.code);
    try {
      props.onSaved(await callShareApi<Saved>({ action: "set-active", code: share.code, updatedAt: share.updated_at, active: !share.active }));
    } catch (e) {
      if (e instanceof ApiError && e.reason === "STALE") props.onStale(e.message);
      else props.say(e instanceof Error ? e.message : "没改成，请重试");
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      const r = await callShareApi<{ refreshed: boolean }>({ action: "refresh" });
      props.say(r.refreshed ? "官网已刷新" : "官网还是没连上，请稍后再试");
    } catch (e) {
      props.say(e instanceof Error ? e.message : "请稍后再试");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="bar">
        <div className="field search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜标题、老师、建的人" aria-label="搜索分享页" />
        </div>
        <button className="btn ghost sm" disabled={busy === "refresh"} onClick={refresh} title="改了之后家长看到的还是旧的时候用">
          通知官网
        </button>
        <button className="btn" style={{ marginLeft: "auto" }} onClick={props.onNew}>
          新建分享页
        </button>
      </div>
      <div className="table">
        <table>
          <colgroup>
            <col style={{ width: "24%" }} />
            <col />
            <col style={{ width: 240 }} />
            <col style={{ width: 228 }} />
          </colgroup>
          <thead>
            <tr>
              <th>标题</th>
              <th>老师</th>
              <th>建的人 · 最后修改</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const missing = siteNames ? missingTeachers(s, siteNames) : [];
              return (
                <tr key={s.code} className={s.active ? "" : "off"}>
                  <td>
                    <span className="title-cell">{s.title}</span>
                    {s.active ? null : <span className="tag-off">已停用</span>}
                  </td>
                  <td title={s.teachers.join("、")}>
                    <span className="mut">{s.teachers.length} 位 · </span>
                    {missing.length ? <span className="missing" title={`官网上已经没有：${missing.join("、")}，家长看不到`}>{missing.length} 位已不在官网</span> : null}
                    {s.teachers.join("、")}
                  </td>
                  <td className="by">
                    {s.created_by}
                    {s.updated_by !== s.created_by ? ` · ${s.updated_by}改` : ""} · {when(s.updated_at)}
                  </td>
                  <td className="x">
                    <button className="btn ghost sm" disabled={!s.active} onClick={() => props.onCopy(s)}>
                      复制链接
                    </button>
                    <button className="btn ghost sm" onClick={() => props.onEdit(s)}>
                      编辑
                    </button>
                    <button className="btn ghost sm" disabled={busy === s.code} onClick={() => toggle(s)}>
                      {s.active ? "停用" : "恢复"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {q && shown.length === 0 ? <p className="foot">没有符合「{query}」的分享页</p> : null}
    </>
  );
}

function Editor(props: {
  share?: ShareRow;
  titles: string[];
  teachers: SiteTeacher[] | null;
  teachersError: boolean;
  onRetryTeachers: () => void;
  onCancel: () => void;
  onSaved: (r: Saved) => void;
  onStale: (message: string) => void;
}) {
  const { share, teachers } = props;
  const [title, setTitle] = useState(share?.title ?? "");
  const [intro, setIntro] = useState(share?.intro ?? "");
  const [picked, setPicked] = useState<string[]>(share?.teachers ?? []);
  const [filter, setFilter] = useState<TeacherFilter>({ query: "", subject: null, tags: [], pool: null });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const subjects = useMemo(() => [...new Set((teachers ?? []).map((t) => t.subject))], [teachers]);
  const shown = useMemo(() => (teachers ? filterTeachers(teachers, filter) : []), [teachers, filter]);
  const byName = useMemo(() => new Map((teachers ?? []).map((t) => [t.name, t])), [teachers]);

  const toggle = (name: string) => setPicked((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]));
  const move = (i: number, d: -1 | 1) =>
    setPicked((list) => {
      const next = [...list];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });

  const save = async () => {
    setError(null);
    if (!title.trim()) return setError("请填写标题");
    if (picked.length === 0) return setError("请至少选一位老师");
    setSaving(true);
    try {
      props.onSaved(await callShareApi<Saved>({ action: "save", code: share?.code, updatedAt: share?.updated_at, title, intro, teachers: picked }));
    } catch (e) {
      if (e instanceof ApiError && e.reason === "STALE") props.onStale(e.message);
      else setError(e instanceof Error ? e.message : "没保存上，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      <div className="form">
        <div className="fld">
          <label htmlFor="title">标题</label>
          <input id="title" className="input" list="title-presets" value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：雅思语培" />
          <datalist id="title-presets">
            {props.titles.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        <div className="fld">
          <label htmlFor="intro">
            介绍<small>{[...intro].length}/{LIMITS.intro}</small>
          </label>
          <textarea id="intro" className="input" rows={3} value={intro} maxLength={LIMITS.intro} onChange={(e) => setIntro(e.target.value)} placeholder="写给家长看的一两句话，可不填" />
        </div>
      </div>

      <h3 className="sec">
        已选 {picked.length} 位<small>家长页按这个顺序显示</small>
      </h3>
      {picked.length ? (
        <div className="picked">
          {picked.map((name, i) => (
            <span className={`chip ${teachers && !byName.has(name) ? "gone" : ""}`} key={name} title={teachers && !byName.has(name) ? "官网上已经没有这位老师，家长看不到" : undefined}>
              {name}
              {teachers && !byName.has(name) ? <small>已不在官网</small> : null}
              <button type="button" aria-label={`${name}往前`} disabled={i === 0} onClick={() => move(i, -1)}>
                ‹
              </button>
              <button type="button" aria-label={`${name}往后`} disabled={i === picked.length - 1} onClick={() => move(i, 1)}>
                ›
              </button>
              <button type="button" aria-label={`去掉${name}`} onClick={() => toggle(name)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mut picked-none">从下面点老师加进来</p>
      )}

      <h3 className="sec">选老师</h3>
      <div className="filters">
        <div className="field search">
          <input value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} placeholder="搜名字、学校、课程" aria-label="搜老师" />
        </div>
        <div className="quick" role="group" aria-label="学科">
          <button type="button" aria-pressed={!filter.subject} onClick={() => setFilter({ ...filter, subject: null })}>
            全部学科
          </button>
          {subjects.map((s) => (
            <button type="button" key={s} aria-pressed={filter.subject === s} onClick={() => setFilter({ ...filter, subject: filter.subject === s ? null : s })}>
              {s}
            </button>
          ))}
        </div>
        <div className="quick" role="group" aria-label="课程">
          {COURSE_TAGS.map((tag) => (
            <button
              type="button"
              key={tag}
              aria-pressed={filter.tags.includes(tag)}
              onClick={() => setFilter({ ...filter, tags: filter.tags.includes(tag) ? filter.tags.filter((t) => t !== tag) : [...filter.tags, tag] })}
            >
              {tag}
            </button>
          ))}
          <span className="sep" />
          {(["名师", "严选"] as const).map((pool) => (
            <button type="button" key={pool} aria-pressed={filter.pool === pool} onClick={() => setFilter({ ...filter, pool: filter.pool === pool ? null : pool })}>
              {pool === "名师" ? "名师团队" : "菁仕严选"}
            </button>
          ))}
        </div>
      </div>

      {props.teachersError ? (
        <div className="empty slim">
          <h3>官网老师名单没读到</h3>
          <p>{SITE}/api/share-teachers 打不开</p>
          <button className="btn outline sm" onClick={props.onRetryTeachers}>
            重试
          </button>
        </div>
      ) : !teachers ? (
        <div className="sk" style={{ width: 240 }} />
      ) : shown.length === 0 ? (
        <p className="foot">没有符合条件的老师</p>
      ) : (
        <div className="grid">
          {shown.map((t) => {
            const on = picked.includes(t.name);
            return (
              <button type="button" key={t.name} className={`tile ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(t.name)}>
                {t.photo ? <img src={t.photo} alt="" loading="lazy" /> : <span className="ph">{t.name.slice(0, 1)}</span>}
                <span className="tile-body">
                  <b>
                    {t.name}
                    {t.pool === "严选" ? <small>严选</small> : null}
                  </b>
                  <span className="mut">
                    {t.subject} · {t.degree}
                  </span>
                  <span className="tile-courses">{t.courses}</span>
                  {t.ielts ? <span className="tile-ielts">雅思 {t.ielts}</span> : null}
                </span>
                <span className="check" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="save-bar">
        {error ? (
          <span className="err-line" role="alert">
            {error}
          </span>
        ) : null}
        <button className="btn outline" onClick={props.onCancel}>
          取消
        </button>
        <button className="btn" disabled={saving} onClick={save}>
          {saving ? "保存中…" : share ? "保存" : "生成链接"}
        </button>
      </div>
    </div>
  );
}

function Done(props: { share: ShareRow; refreshed: boolean; created: boolean; onCopy: () => void; onRefreshed: () => void; onBack: () => void }) {
  const { share } = props;
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    setRetryError(null);
    try {
      const r = await callShareApi<{ refreshed: boolean }>({ action: "refresh" });
      if (r.refreshed) props.onRefreshed();
      else setRetryError("还是没连上官网，请过几分钟再试");
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : "请稍后再试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="done">
      <h2>{props.created ? "链接已生成" : "已保存"}</h2>
      <p className="mut">
        {share.teachers.length} 位老师{props.created ? "，复制下面的链接发给家长" : "，链接不变，家长刷新就能看到新的"}
      </p>
      <div className="link-row">
        <input className="input" readOnly value={linkOf(share.code)} onFocus={(e) => e.target.select()} aria-label="分享链接" />
        <button className="btn" onClick={props.onCopy}>
          复制链接
        </button>
        <a className="btn outline" href={linkOf(share.code)} target="_blank" rel="noreferrer">
          打开看看
        </a>
      </div>
      {props.refreshed ? null : (
        <div className="warn-box" role="alert">
          <b>▲ 官网还没刷新</b>
          <span>{props.created ? "家长现在打开会看到「链接已失效」" : "家长现在看到的还是改之前的"}，请再通知一次。</span>
          <button className="btn outline sm" disabled={busy} onClick={retry}>
            {busy ? "通知中…" : "再通知一次"}
          </button>
          {retryError ? <span className="err-line">{retryError}</span> : null}
        </div>
      )}
      <button className="btn ghost" onClick={props.onBack}>
        返回全部链接
      </button>
    </div>
  );
}
