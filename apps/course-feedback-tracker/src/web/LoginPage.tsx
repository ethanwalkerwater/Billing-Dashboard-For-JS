import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { startFeishuLogin } from "./cloudbase";

export function LoginPage({
  error,
  title = "月度课程反馈",
  description = "用飞书账号登录工作台",
}: {
  /** 飞书回跳后登录或绑定失败的原因 */
  error?: string | null;
  title?: string;
  description?: string;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <main className="bg-muted/40 flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
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
