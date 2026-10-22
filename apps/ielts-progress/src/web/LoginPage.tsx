import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { startFeishuLogin } from "./cloudbase";

/** 飞书登录，和反馈工作台共用 feedback_admins 白名单与登录状态。 */
export function LoginPage({ error }: { error?: string | null }) {
  const [busy, setBusy] = useState(false);

  return (
    <main className="bg-muted/40 flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">雅思正向率</CardTitle>
          <CardDescription>用飞书账号登录</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              startFeishuLogin();
            }}
          >
            {busy ? "正在打开飞书…" : "用飞书登录"}
          </Button>
          <p className="text-muted-foreground text-center text-xs">仅管理员白名单可访问</p>
        </CardContent>
      </Card>
    </main>
  );
}
