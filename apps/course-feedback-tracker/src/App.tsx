import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminSettings } from "./web/AdminSettings";
import { RoleContext, usePage } from "./web/AppNav";
import { LoginPage } from "./web/LoginPage";
import { CourseTypes } from "./web/CourseTypes";
import { TeacherScores } from "./web/TeacherScores";
import { Workbench } from "./web/Workbench";
import { auth, completeFeishuLogin, getSignedInUser } from "./web/cloudbase";
import { allowedPages } from "./shared/roles";
import type { Role } from "./shared/roles";

export function App() {
  const [me, setMe] = useState<{ uid: string; role: Role } | null>(null);
  const [checking, setChecking] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [page, setPage] = usePage();

  const refresh = useCallback(async () => {
    setLoginError(await completeFeishuLogin());
    setMe(await getSignedInUser());
    setChecking(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useMemo(
    () => async () => {
      await auth.signOut();
      setMe(null);
    },
    [],
  );

  if (checking) {
    return <p className="text-muted-foreground p-20 text-center text-sm">正在检查登录状态…</p>;
  }
  if (!me) return <LoginPage error={loginError} />;
  // 没权限的页面（老链接、手改地址）一律落回问卷跟踪；数据本身由数据库权限挡住
  const shown = allowedPages(me.role).includes(page) ? page : "tracking";
  return (
    <RoleContext.Provider value={me}>
      {shown === "scores" ? (
        <TeacherScores page={shown} onPageChange={setPage} onSignOut={signOut} />
      ) : shown === "course-types" ? (
        <CourseTypes page={shown} onPageChange={setPage} onSignOut={signOut} />
      ) : shown === "admin" ? (
        <AdminSettings page={shown} onPageChange={setPage} onSignOut={signOut} />
      ) : (
        <Workbench page={shown} onPageChange={setPage} onSignOut={signOut} />
      )}
    </RoleContext.Provider>
  );
}
