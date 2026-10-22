import { useCallback, useEffect, useState } from "react";

import { LoginPage } from "./web/LoginPage";
import { Workbench } from "./web/Workbench";
import { auth, completeFeishuLogin, getSignedInUser } from "./web/cloudbase";

export function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoginError(await completeFeishuLogin());
    const user = await getSignedInUser();
    setUserId((user as { uid?: string } | null)?.uid ?? null);
    setChecking(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (checking) return <p className="text-muted-foreground p-20 text-center text-sm">正在检查登录状态…</p>;
  if (!userId) return <LoginPage error={loginError} />;
  return (
    <Workbench
      onSignOut={async () => {
        await auth.signOut();
        setUserId(null);
      }}
    />
  );
}
