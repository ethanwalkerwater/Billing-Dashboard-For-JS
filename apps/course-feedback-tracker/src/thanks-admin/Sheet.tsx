import { Check, Clock, Minus, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { Status } from "./data";

export function Sheet({ title, description, busy, close, children }: {
  title: string; description: string; busy: boolean; close: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="sheet" aria-labelledby="sheet-title"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    onClick={event => { if (event.target === ref.current && event.clientX < ref.current.getBoundingClientRect().left && !busy) close(); }}>
    <div className="sheet-inner">
      <header className="sheet-head"><div><h1 id="sheet-title" tabIndex={-1} autoFocus>{title}</h1><p>{description}</p></div>
        <button type="button" className="tool" disabled={busy} onClick={close} aria-label="关闭侧栏"><X className="icon" /></button>
      </header>
      {children}
    </div>
  </dialog>;
}

export const statusName = { pending: "待处理", done: "已处理" };

export function Badge({ status, children }: { status: Status | "off"; children: ReactNode }) {
  const Mark = { pending: Clock, done: Check, off: Minus }[status];
  return <span className={"status " + status}><Mark className="icon" aria-hidden />{children}</span>;
}
