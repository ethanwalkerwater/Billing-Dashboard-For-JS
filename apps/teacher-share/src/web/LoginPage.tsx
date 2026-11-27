import { useState } from "react";

import { startFeishuLogin } from "./cloudbase";

/** 飞书登录，和反馈工作台共用登录端点与 feedback_admins 名单 */
export function LoginPage({ error }: { error?: string | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-card">
        <div className="logo">菁</div>
        <h1>老师分享</h1>
        {error ? (
          <p className="err-line" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            startFeishuLogin();
          }}
        >
          {busy ? "正在打开飞书…" : "用飞书登录"}
        </button>
      </div>
    </main>
  );
}
