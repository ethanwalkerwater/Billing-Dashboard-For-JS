import { Gift, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { monthOfShanghai } from "../domain/month";
import { LoginPage } from "../web/LoginPage";
import { completeFeishuLogin, getSignedInUser } from "../web/cloudbase";
import { Catalog } from "./Catalog";
import { Records } from "./Records";
import { errorText } from "./data";
import "./admin.css";

function ThanksAdmin() {
  const [page, setPage] = useState<"records" | "catalog">("records");
  const [catalogVisited, setCatalogVisited] = useState(false);
  const [month, setMonth] = useState(() => monthOfShanghai(new Date().toISOString()));
  const [pending, setPending] = useState<number | null>(null);
  return <div className="admin"><div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="admin-brand"><img src="/feedback/logo-blue.svg" alt="" /><div>菁仕教育<small>感谢礼管理</small></div></div>
      <nav aria-label="感谢礼管理导航">
        <button type="button" aria-current={page === "records" ? "page" : undefined} onClick={() => setPage("records")}>
          <Inbox className="icon" aria-hidden />感谢记录<span className="count">{pending}</span></button>
        <button type="button" aria-current={page === "catalog" ? "page" : undefined} onClick={() => { setCatalogVisited(true); setPage("catalog"); }}>
          <Gift className="icon" aria-hidden />礼物设置</button>
      </nav>
    </aside>
    <div><header className="crumb"><span className="crumb-root">感谢礼管理</span><span className="slash" aria-hidden>/</span>
      <strong>{page === "records" ? "感谢记录" : "礼物设置"}</strong></header>
      <main className="admin-content"><div hidden={page !== "records"}>
        <Records key={month} month={month} changeMonth={setMonth} onCount={setPending} /></div>
        {catalogVisited && <div hidden={page !== "catalog"}><Catalog /></div>}
      </main></div>
  </div></div>;
}
function App() {
  const [signedIn, setSignedIn] = useState<boolean>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    async function login() {
      setError(await completeFeishuLogin());
      setSignedIn((await getSignedInUser())?.feishuMember ?? false);
    }
    void login().catch(cause => { setError(errorText(cause)); setSignedIn(false); });
  }, []);
  if (signedIn === undefined) return <p className="text-muted-foreground p-20 text-center text-sm">正在检查登录状态…</p>;
  if (!signedIn) return <LoginPage title="感谢礼管理" description="使用菁仕教育团队的飞书账号登录" error={error} />;
  return <ThanksAdmin />;
}
createRoot(document.getElementById("root")!).render(<App />);
