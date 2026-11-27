import { useCallback, useEffect, useState } from "react";

import { Shares } from "./web/Shares";
import { LoginPage } from "./web/LoginPage";
import { auth, completeFeishuLogin, getSignedInUser } from "./web/cloudbase";

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoginError(await completeFeishuLogin());
    setSignedIn(Boolean(await getSignedInUser()));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (signedIn === null) return null;
  if (!signedIn) return <LoginPage error={loginError} />;
  return (
    <Shares
      onSignOut={async () => {
        await auth.signOut();
        setSignedIn(false);
      }}
    />
  );
}
