import { Check, Gift, Mail, Send, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import "./feedback-thanks.css";

export interface ThanksGift {
  id: string;
  label: string;
  description: string;
  value: number;
  photo: string | null;
  enabled: boolean;
}

export type ThanksResult = { ok: true } | { error: string; thanks: { gifts: ThanksGift[] } };

const messages = [
  "感谢老师的耐心与负责",
  "孩子最近进步很明显",
  "老师的教学方式很适合孩子",
  "感谢老师课后的及时反馈",
];
const customChoice = "我想自己写一句";
const amount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function FeedbackThanksDialog({ teacher, gifts, onSend, onFinish }: {
  teacher: string;
  gifts: ThanksGift[];
  onSend: (gift: ThanksGift, note: string) => Promise<ThanksResult>;
  onFinish: (sent: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const sending = useRef(false);
  const [step, setStep] = useState<"invite" | "gifts" | "message">("invite");
  const [selected, setSelected] = useState<ThanksGift>();
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const note = choice === customChoice ? custom.trim() : choice;

  useLayoutEffect(() => {
    const modal = dialog.current!;
    if (!modal.open) modal.showModal();
    modal.scrollTop = 0;
    title.current?.focus({ preventScroll: true });
  }, [step]);

  function skip() {
    if (!sending.current) onFinish(false);
  }

  async function submit() {
    if (!selected || !note || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onSend(selected, note);
      if ("error" in result) {
        setSelected(undefined);
        setStep("gifts");
        throw new Error(result.error);
      }
      onFinish(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "感谢礼暂未确认，请重试。");
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="thanks-dialog" aria-labelledby="thanks-title"
      onCancel={(event) => { event.preventDefault(); skip(); }}>
      <div className="thanks-body">
        <header className="thanks-top">
          <span className="wordmark"><img src="/feedback/logo-blue.svg" alt="" />菁仕教育</span>
          <button type="button" className="tool" onClick={skip} disabled={busy} aria-label="关闭并跳过感谢礼"><X /></button>
        </header>
        {step !== "invite" && (
          <ol className="step" aria-label="传递感谢的步骤">
            <li aria-current={step === "gifts" ? "step" : undefined}>{step === "gifts" ? "选礼物" : "已选礼物"}</li>
            <li aria-current={step === "message" ? "step" : undefined}><span aria-hidden="true">›</span>留感谢语</li>
          </ol>
        )}
        {step === "invite" && <div className="envelope"><img src="/feedback/thanks/envelope.webp" alt="" /></div>}
        <h2 id="thanks-title" ref={title} tabIndex={-1} className={step === "invite" ? "text-center" : undefined}>
          {step === "invite" ? `给${teacher}一份小小的感谢` : step === "gifts" ? `选一份心意送给${teacher}` : `想对${teacher}说些什么？`}
        </h2>
        {step === "invite" && <>
          <p className="invite-copy">这位老师的评价已提交。</p>
          <p className="sponsor"><Gift /><span><strong>礼物我们来准备，您不用花钱</strong><small>我们会把礼物和您的感谢一起送给老师。</small></span></p>
          <div className="thanks-actions">
            <button type="button" className="primary" onClick={() => setStep("gifts")}><Mail />传递感谢</button>
            <button type="button" onClick={skip}>暂时不用</button>
          </div>
        </>}
        {step === "gifts" && <>
          <p className="heading-note">这些礼物由菁仕准备，您不用花钱。</p>
          {error && <p className="send-error" role="alert">{error}</p>}
          <fieldset className="gift-grid" aria-label="礼物类型">
            {gifts.map((gift) => <label className="gift-card" key={gift.id}>
              <input type="radio" className="sr-only" name="gift" checked={selected?.id === gift.id} onChange={() => { setSelected(gift); setError(""); }} />
              <span className="gift-surface">
                <span className="gift-art" data-gift={gift.id}><img src={gift.photo || `/feedback/thanks/${gift.id}.webp`} alt="" /></span>
                <span className="mark"><Check /></span>
                <strong>{gift.label}</strong><small>{gift.description}</small>
                <span className="price">价值 ¥{amount.format(gift.value)}</span>
              </span>
            </label>)}
          </fieldset>
          <div className="thanks-actions split">
            {gifts.length ? <>
              <button type="button" onClick={() => setStep("invite")}>上一步</button>
              <button type="button" className="primary" disabled={!selected} onClick={() => setStep("message")}>选感谢语</button>
            </> : <button type="button" onClick={skip}>暂时不用</button>}
          </div>
        </>}
        {step === "message" && selected && <>
          <div className="gift-summary"><span><Gift /> 已选礼物</span><strong>{selected.label}</strong></div>
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <fieldset className="message-options" aria-label="感谢语" disabled={busy}>
              {[...messages, customChoice].map((message) => <label key={message} className="message-option">
                <input type="radio" name="message" checked={choice === message} onChange={() => setChoice(message)} />{message}
              </label>)}
            </fieldset>
            <textarea aria-label="自己写一句感谢语" placeholder="写下您想对老师说的话…" maxLength={200}
              value={custom} disabled={busy} onChange={(event) => { setCustom(event.target.value); setChoice(customChoice); }} />
            <p className="counter">{custom.length}/200</p>
            {error && <p className="send-error" role="alert">{error}</p>}
            <div className="thanks-actions split">
              <button type="button" disabled={busy} onClick={() => setStep("gifts")}>上一步</button>
              <button type="submit" className="primary" disabled={!note || busy}><Send />{busy ? "正在送出…" : "确认送出"}</button>
            </div>
          </form>
        </>}
      </div>
    </dialog>
  );
}
