import { Upload } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { db } from "../web/cloudbase";
import { errorText, giftPhoto, loadGifts, money, resizePhoto, saveGift, type Gift } from "./data";
import { Badge, Sheet } from "./Sheet";

function EditGift({ gift, close, saved }: { gift: Gift; close: () => void; saved: (gift: Gift) => void }) {
  const [photo, setPhoto] = useState(gift.photo);
  const [photoStatus, setPhotoStatus] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const busy = preparing || saving;

  async function choosePhoto(file?: File) {
    if (!file) return;
    setPreparing(true);
    setPhotoStatus("正在准备预览…");
    try {
      setPhoto(await resizePhoto(file));
      setPhotoStatus("新图已预览，保存后生效。");
    } catch (cause) {
      setPhotoStatus(errorText(cause));
    } finally {
      setPreparing(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label")).trim();
    if (!label) { setError("请输入礼物名称。"); return; }
    const description = String(form.get("description")).trim();
    const value = Number(form.get("value"));
    const enabled = form.has("enabled");
    const changes = {
      ...(label !== gift.label && { label }),
      ...(description !== gift.description && { description }),
      ...(value !== Number(gift.value) && { value }),
      ...(enabled !== gift.enabled && { enabled }),
      ...(photo !== gift.photo && { photo }),
    };
    if (!Object.keys(changes).length) { close(); return; }
    setSaving(true);
    setError("");
    try {
      saved(await saveGift(db, gift.id, changes));
    } catch (cause) {
      setError("礼物设置保存失败：" + errorText(cause));
      setSaving(false);
    }
  }
  return <Sheet title="编辑礼物" description="修改后将更新家长端可见的礼物。" busy={busy} close={close}>
    <form className="sheet-form" onSubmit={submit}>
      <fieldset className="photo-field"><legend>礼物图片</legend>
        <div className="photo-edit"><img src={giftPhoto({ id: gift.id, photo })} alt="礼物图片预览" />
          <div><button className="btn" type="button" aria-describedby="photo-help" disabled={busy} onClick={() => upload.current?.click()}>
            <Upload className="icon" aria-hidden />更换图片</button>
            <input ref={upload} hidden type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传礼物图片"
              disabled={busy} onChange={event => void choosePhoto(event.target.files?.[0])} />
            <p id="photo-help">JPG、PNG、WebP · 最大 5 MB</p></div></div>
        <p id="photo-status" role="status">{photoStatus}</p></fieldset>
      <label>礼物名称<input name="label" defaultValue={gift.label} maxLength={20} required disabled={saving} /></label>
      <label>礼物说明<input name="description" defaultValue={gift.description} maxLength={30} disabled={saving} /></label>
      <label>礼物价值（元）<input name="value" type="number" min="0" max="9999" step="0.01" defaultValue={gift.value} required disabled={saving} /></label>
      <label className="checkbox"><input name="enabled" type="checkbox" defaultChecked={gift.enabled} disabled={saving} />在家长端启用</label>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="sheet-foot"><button type="button" className="btn" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="btn primary" disabled={busy}>{saving ? "正在保存…" : "保存设置"}</button></div>
    </form>
  </Sheet>;
}

export function Catalog() {
  const [gifts, setGifts] = useState<Gift[] | null>(null);
  const [edit, setEdit] = useState<Gift | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadGifts(db).then(result => { if (active) setGifts(result); })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [attempt]);
  return <section>
    <div className="admin-page-heading"><div><h1>礼物设置</h1><p className="muted">保存后应用于后续送出，已收到的感谢记录保留当时的礼物与价值。</p></div></div>
    {error && <p className="notice" role="alert">{error} <button className="btn compact" onClick={() => { setError(""); setAttempt(value => value + 1); }}>重试</button></p>}
    <div className="table-wrap" tabIndex={0} role="region" aria-label="礼物设置表格，可横向滚动"><table>
      <thead><tr>{["礼物", "礼物说明", "礼物价值", "状态", "操作"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{gifts?.map(item => <tr key={item.id}>
        <th scope="row"><span className="setting-art"><img src={giftPhoto(item)} alt="" />{item.label}</span></th>
        <td>{item.description}</td><td className="numeric">{money(item.value)}</td>
        <td><Badge status={item.enabled ? "done" : "off"}>{item.enabled ? "已启用" : "已停用"}</Badge></td>
        <td><button className="btn compact" type="button" aria-label={"编辑" + item.label} onClick={() => setEdit(item)}>编辑</button></td>
      </tr>)}
      {!gifts?.length && <tr><td colSpan={5} className="table-empty">{error ? "未能读取礼物" : gifts ? "暂无礼物" : "正在读取礼物…"}</td></tr>}</tbody>
    </table></div>
    {edit && <EditGift gift={edit} close={() => setEdit(null)} saved={gift => {
      setGifts(previous => previous?.map(item => item.id === gift.id ? gift : item) ?? null);
      setEdit(null);
    }} />}
  </section>;
}
