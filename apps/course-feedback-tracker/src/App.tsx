import { useCallback, useEffect, useMemo, useState } from "react";

import { usePage } from "./web/AppNav";
import { LoginPage } from "./web/LoginPage";
import { Cancellations } from "./web/Cancellations";
import { CourseTypes } from "./web/CourseTypes";
import { TeacherScores } from "./web/TeacherScores";
import { Workbench } from "./web/Workbench";
import { auth, getSignedInUser } from "./web/cloudbase";

export function App() {
  const [userId, setUserId] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = usePage();

  const refresh = useCallback(async () => {
    const user = await getSignedInUser();
    setUserId((user as { uid?: string } | null)?.uid ?? null);
    setChecking(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useMemo(
    () => async () => {
      await auth.signOut();
      setUserId(null);
    },
    [],
  );

  if (checking) {
    return <p className="text-muted-foreground p-20 text-center text-sm">正在检查登录状态…</p>;
  }
  if (!userId) return <LoginPage onSignedIn={refresh} />;
  if (page === "scores") return <TeacherScores page={page} onPageChange={setPage} onSignOut={signOut} />;
  if (page === "cancellations") return <Cancellations page={page} onPageChange={setPage} onSignOut={signOut} />;
  if (page === "course-types") return <CourseTypes page={page} onPageChange={setPage} onSignOut={signOut} />;
  return <Workbench page={page} onPageChange={setPage} onSignOut={signOut} />;
}
