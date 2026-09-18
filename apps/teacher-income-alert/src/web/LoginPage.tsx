import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { auth } from "./cloudbase";

export function LoginPage({ onSignedIn }: { onSignedIn: () => void | Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // CloudBase SDK 登录失败时返回 { error }，不会 throw——只 catch 的话页面会一声不吭。
      // username 字段既接受用户名（jsjy）也接受绑定的邮箱，服务端会自己解析。
      const result = (await auth.signInWithPassword({ username: email.trim(), password })) as {
        error?: { message?: string } | null;
      };
      if (result?.error) {
        setError(result.error.message || "登录失败，请检查账号和密码");
        return;
      }
      await onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请检查账号和密码");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bg-muted/40 flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">教师薪资预警</CardTitle>
          <CardDescription>用教务账号登录</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-2">
              <label htmlFor="email" className="text-sm font-medium">
                账号
              </label>
              <Input
                id="email"
                type="text"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label htmlFor="password" className="text-sm font-medium">
                密码
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "登录中…" : "登录"}
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              环境 {import.meta.env.VITE_CLOUDBASE_ENV_ID} · 仅管理员白名单可访问
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
