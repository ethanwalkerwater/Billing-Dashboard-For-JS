import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Cancellations } from "./web/Cancellations";
import { LoginPage } from "./web/LoginPage";
import { auth, getSignedInUser } from "./web/cloudbase";
import "./styles.css";

/** 取消课程管理页（静态托管 /cancellations/），和月度反馈工作台共用教务账号与登录状态。 */
function CancellationsApp() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const refresh = useCallback(async () => setSignedIn(Boolean(await getSignedInUser())), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (signedIn === null) return <p className="text-muted-foreground p-20 text-center text-sm">正在检查登录状态…</p>;
  if (!signedIn) return <LoginPage onSignedIn={refresh} title="取消课程" description="用教务账号登录，查看学生取消链接和取消记录" />;
  return (
    <Cancellations
      onSignOut={async () => {
        await auth.signOut();
        setSignedIn(false);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CancellationsApp />
  </StrictMode>,
);
