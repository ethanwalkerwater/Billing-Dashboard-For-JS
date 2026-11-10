import { useCallback, useEffect, useMemo, useState } from "react";

import { LoginPage } from "./web/LoginPage";
import { Workbench } from "./web/Workbench";
import { auth, currentUserIsFeedbackAdmin, getSignedInUser } from "./web/cloudbase";

export function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    const user = await getSignedInUser();
    if (!user) {
      setUserId(null);
      setChecking(false);
      return;
    }
    const allowed = await currentUserIsFeedbackAdmin();
    if (!allowed) {
      await auth.signOut();
      setDenied(true);
      setUserId(null);
      setChecking(false);
      return;
    }
    setDenied(false);
    setUserId((user as { uid?: string }).uid ?? "signed-in");
    setChecking(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useMemo(
    () => async () => {
      await auth.signOut();
      setDenied(false);
      setUserId(null);
    },
    [],
  );

  if (checking) {
    return <p className="text-muted-foreground p-20 text-center text-sm">正在检查登录状态…</p>;
  }
  if (!userId) return <LoginPage denied={denied} onSignedIn={refresh} />;
  return <Workbench onSignOut={signOut} />;
}
