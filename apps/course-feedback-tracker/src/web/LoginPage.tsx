import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth, FEISHU_LOGIN_PROVIDER } from "./cloudbase";

function loginFailure(message: string | undefined): string {
  if (message && /provider feishu not found/i.test(message)) {
    return "云开发里还没有开通飞书登录。";
  }
  return message || "飞书登录没有开始，请稍后再试";
}

export function LoginPage({
  denied,
  onSignedIn,
}: {
  denied: boolean;
  onSignedIn: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signInWithFeishu() {
    setBusy(true);
    setError(null);
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const result = (await auth.signInWithOAuth({
        provider: FEISHU_LOGIN_PROVIDER,
        options: { redirectTo },
      })) as { error?: { message?: string } | null; data?: { url?: string | null } };
      if (result?.error) {
        setError(loginFailure(result.error.message));
        return;
      }
      if (result?.data?.url) {
        window.location.assign(result.data.url);
        return;
      }
      await onSignedIn();
    } catch (cause) {
      setError(loginFailure(cause instanceof Error ? cause.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-muted/40 flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">月度课程反馈</CardTitle>
          <CardDescription>使用飞书账号登录。只有指定的管理员可以进入。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {denied ? <p className="text-destructive text-sm">这个飞书账号不能登录。</p> : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <Button type="button" className="w-full" disabled={busy} onClick={() => void signInWithFeishu()}>
            {busy ? "正在前往飞书…" : "使用飞书登录"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
