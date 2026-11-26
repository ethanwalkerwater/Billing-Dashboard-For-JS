import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { nameMatchKey } from "../domain/identity";
import { isMonth } from "../domain/month";
import { db } from "../web/cloudbase";
import { countValue, errorText, loadRecords, money, updateStatuses, type Status, type ThanksRecord } from "./data";
import { Badge, Sheet, statusName } from "./Sheet";

export function Records({ month, changeMonth, onCount }: {
  month: string; changeMonth: (month: string) => void; onCount: (count: number | null) => void;
}) {
  const [records, setRecords] = useState<ThanksRecord[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState(new Set<string>());
  const [detail, setDetail] = useState<ThanksRecord | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pickAll = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    loadRecords(db, month).then(result => {
      if (active) setRecords(result);
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [month, attempt]);

  const pending = records?.filter(row => row.status === "pending").length ?? null;
  useEffect(() => onCount(pending), [pending, onCount]);
  const term = nameMatchKey(search);
  const visible = (records ?? []).filter(row => (filter === "all" || row.status === filter) &&
    (nameMatchKey(row.student_name).includes(term) || nameMatchKey(row.teacher_name).includes(term)));
  const selected = visible.filter(row => selection.has(row.task_id));
  useEffect(() => {
    if (pickAll.current) pickAll.current.indeterminate = selected.length > 0 && selected.length < visible.length;
  }, [selected.length, visible.length]);

  function clearSelection() {
    setSelection(new Set());
    setNotice("");
  }
  async function changeStatus(chosen: ThanksRecord[], status: Status) {
    const ids = chosen.filter(row => row.status !== status).map(row => row.task_id);
    if (busy || !ids.length) return;
    setBusy(true);
    setError("");
    try {
      await updateStatuses(db, month, ids, status);
      const changed = new Set(ids);
      setRecords(previous => previous?.map(row => changed.has(row.task_id) ? { ...row, status } : row) ?? null);
      setSelection(new Set());
      setNotice("已将 " + ids.length + " 条记录改为" + statusName[status]);
    } catch (cause) {
      setError("处理状态保存失败：" + errorText(cause));
      setRecords(null);
      clearSelection();
      setAttempt(value => value + 1);
    } finally {
      setDetail(null);
      setBusy(false);
    }
  }

  return <section>
    <div className="admin-page-heading"><h1>感谢记录</h1></div>
    <dl className="stats" aria-label="所选课程月汇总">{[
      ["本月感谢", records?.length ?? "—"], ["待处理", pending ?? "—"],
      ["已处理", records ? records.length - (pending ?? 0) : "—"],
      ["礼物总价值", records ? money(countValue(records)) : "—"],
    ].map(([label, value]) => <div className="stat" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="filters">
      <label className="search-box"><Search className="icon" /><input type="search" placeholder="搜索学生或老师"
        aria-label="搜索学生或老师" value={search} onChange={e => { setSearch(e.target.value); clearSelection(); }} /></label>
      <input type="month" aria-label="课程月份" required disabled={busy} value={month}
        onChange={e => { if (isMonth(e.target.value)) changeMonth(e.target.value); }} />
      <select aria-label="处理状态" value={filter} onChange={e => { setFilter(e.target.value); clearSelection(); }}>
        <option value="all">全部状态</option><option value="pending">待处理</option><option value="done">已处理</option>
      </select>
    </div>
    {error && <p role="alert" className="notice">{error} {!records && <button className="btn compact"
      onClick={() => { setError(""); setAttempt(value => value + 1); }}>重试</button>}</p>}
    <div className="batch-line"><span id="batch-status" role="status">{busy ? "正在保存…" : notice ||
      (selected.length ? "已选 " + selected.length + " 条" : "勾选记录可批量修改状态")}</span>
      <button className="btn compact" disabled={busy || !selected.some(row => row.status === "done")} onClick={() => void changeStatus(selected, "pending")}>批量恢复待处理</button>
      <button className="btn compact" disabled={busy || !selected.some(row => row.status === "pending")} onClick={() => void changeStatus(selected, "done")}>批量标记已处理</button>
    </div>
    <div className="table-wrap" tabIndex={0} role="region" aria-label="感谢记录表格，可横向滚动"><table>
      <thead><tr><th scope="col"><input ref={pickAll} className="pick" type="checkbox" aria-label="全选当前筛选结果"
        checked={!!visible.length && visible.length === selected.length} disabled={busy || !visible.length}
        onChange={e => { setNotice(""); setSelection(new Set(e.target.checked ? visible.map(row => row.task_id) : [])); }} /></th>
        {["学生", "老师", "礼物", "礼物价值", "感谢语", "状态", "操作"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{visible.map(row => <tr key={row.task_id}>
        <td><input type="checkbox" className="pick" disabled={busy} aria-label={`选择${row.student_name}给${row.teacher_name}的记录`}
          checked={selection.has(row.task_id)} onChange={e => {
            const next = new Set(selection);
            if (e.target.checked) next.add(row.task_id); else next.delete(row.task_id);
            setSelection(next);
            setNotice("");
          }} /></td>
        <th scope="row">{row.student_name}</th><td>{row.teacher_name}</td><td>{row.gift_label}</td><td className="numeric">{money(row.gift_value)}</td>
        <td className="cell-message">{row.note}</td><td><select className={"status " + row.status} value={row.status} disabled={busy}
          aria-label={`修改${row.student_name}给${row.teacher_name}的处理状态`} onChange={e => void changeStatus([row], e.target.value as Status)}>
          <option value="pending">待处理</option><option value="done">已处理</option></select></td>
        <td><button type="button" className="btn compact" disabled={busy} aria-label={`查看${row.student_name}给${row.teacher_name}的感谢`} onClick={() => setDetail(row)}>查看详情</button></td>
      </tr>)}
      {!visible.length && <tr><td colSpan={8} className="table-empty">{records ? "没有符合条件的感谢记录" : error ? "未能读取感谢记录" : "正在读取感谢记录…"}</td></tr>}</tbody>
    </table></div>
    {detail && <Sheet title="感谢详情" description="礼物与感谢语供教务转达。" busy={busy} close={() => setDetail(null)}>
      <dl className="detail-list">{[["课程月份", detail.course_month], ["学生", detail.student_name], ["老师", detail.teacher_name],
        ["礼物", detail.gift_label], ["礼物价值", money(detail.gift_value)]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
        <div><dt>处理状态</dt><dd><Badge status={detail.status}>{statusName[detail.status]}</Badge></dd></div></dl>
      <strong>感谢语</strong><blockquote>{detail.note}</blockquote><div className="sheet-foot">
        <button type="button" className="btn" disabled={busy} onClick={() => setDetail(null)}>关闭</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void changeStatus([detail], detail.status === "pending" ? "done" : "pending")}>
          {busy ? "正在保存…" : detail.status === "pending" ? "标记已处理" : "恢复为待处理"}</button></div>
    </Sheet>}
  </section>;
}
