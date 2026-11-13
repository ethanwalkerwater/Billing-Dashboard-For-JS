import { Check, Circle, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  monthlyFeedbackTitle, monthlyTeacherDone, nextMonthlyTeacher, PARENT_IDENTITY, STUDENT_IDENTITY,
} from "@/domain/monthly-feedback";
import type { MonthlyFeedback, MonthlyTeacher } from "@/domain/monthly-feedback";

const token = window.location.hash.slice(1);

async function requestFeedback(confirmation?: { taskId: string; studentDone: boolean; parentDone: boolean }): Promise<MonthlyFeedback> {
  const response = await fetch("/auth/monthly-feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(confirmation ? { token, action: "confirm", ...confirmation } : { token }),
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error === "INTERNAL_ERROR" ? "暂时无法确认，请重试。" : result.error);
  return result;
}

export function MonthlyFeedbackPage() {
  const [feedback, setFeedback] = useState<MonthlyFeedback>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(true);
  const title = useRef<HTMLHeadingElement>(null);
  const confirmLock = useRef(false);

  async function open() {
    setBusy(true);
    setError("");
    try {
      if (!token) throw new Error("请打开教务发送的月度反馈链接。");
      const data = await requestFeedback();
      setFeedback(data);
      document.title = monthlyFeedbackTitle(data.courseMonth, data.studentName);
      setSelected(nextMonthlyTeacher(data.teachers)?.id ?? data.teachers.find((teacher) => !teacher.studentDone || !teacher.parentDone)?.id ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法打开，请重试。");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void open(); }, []);

  useEffect(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  async function confirm(active: MonthlyTeacher) {
    if (confirmLock.current || busy) return;
    confirmLock.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const data = await requestFeedback({ taskId: active.id, studentDone: active.studentDone, parentDone: active.parentDone });
      const teacher = data.teachers.find((entry) => entry.id === active.id);
      if (!teacher || !monthlyTeacherDone(teacher)) throw new Error("暂时无法确认，请重试。");
      setFeedback(data);
      const identity = teacher.studentDone && !active.studentDone ? STUDENT_IDENTITY : PARENT_IDENTITY;
      setSelected(nextMonthlyTeacher(data.teachers, identity, active.id)?.id ?? "");
      setStatus(`${active.name}的反馈已提交。`);
      window.scrollTo(0, 0);
      requestAnimationFrame(() => title.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "确认失败，请重试。");
    } finally {
      setBusy(false);
      confirmLock.current = false;
    }
  }

  if (!feedback) {
    return (
      <main className="mx-auto max-w-xl px-4 py-8">
        <h1 className="text-xl font-semibold">月度反馈</h1>
        <p className="mt-3 text-sm" role={error ? "alert" : "status"}>{error || "正在读取本月反馈…"}</p>
        {error && token && <Button className="mt-4" disabled={busy} onClick={() => void open()}>重新读取</Button>}
      </main>
    );
  }

  const done = feedback.teachers.filter((teacher) => monthlyTeacherDone(teacher)).length;
  const active = feedback.teachers.find((teacher) => teacher.id === selected);
  const formUrl = active?.formUrl;
  const titleText = monthlyFeedbackTitle(feedback.courseMonth, feedback.studentName);

  return (
    <Tabs value={selected} onValueChange={(teacherId) => {
      setError("");
      setStatus("");
      setSelected(teacherId);
      window.scrollTo(0, 0);
    }} className="min-h-svh gap-0 bg-zinc-50">
      <header className="sticky top-0 z-10 border-b bg-white">
        <div className="mx-auto max-w-xl px-4 pt-2 pb-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <h1 className="min-w-0 font-semibold">{titleText}</h1>
            <span className="shrink-0 text-xs tabular-nums">已提交 {done}/{feedback.teachers.length}</span>
          </div>
          <TabsList aria-label="选择评价老师" className="mt-1.5 flex h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent p-1"
            onKeyDown={(event) => {
              const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
              if (!keys.includes(event.key)) return;
              const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
              const index = tabs.indexOf(event.target as HTMLButtonElement);
              const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              event.preventDefault();
              tabs[target]?.click();
              tabs[target]?.focus({ preventScroll: true });
            }}>
            {feedback.teachers.map((teacher, index) => {
              const complete = monthlyTeacherDone(teacher);
              const label = teacher.studentDone && teacher.parentDone ? "双方已评" : teacher.studentDone ? "学生已评" : teacher.parentDone ? "家长已评" : "待评价";
              return (
                <TabsTrigger key={teacher.id} value={teacher.id} disabled={busy}
                  id={"teacher-" + teacher.id} aria-controls={active ? "teacher-feedback" : undefined}
                  tabIndex={teacher.id === selected || (!selected && index === 0) ? 0 : -1}
                  className="flex min-h-11 min-w-20 flex-none flex-col gap-0 rounded-md border border-zinc-200 px-2 py-1 text-xs data-[state=active]:border-blue-700 data-[state=active]:bg-blue-50">
                  <span className="font-semibold">{teacher.name}</span>
                  <span className={`flex items-center gap-1 ${complete ? "text-blue-800" : "text-zinc-600"}`}>
                    {complete ? <Check aria-hidden="true" className="size-3" /> : <Circle aria-hidden="true" className="size-3" />}
                    {label}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl px-4 pt-1.5 pb-4">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 text-sm">
          <h2 ref={title} tabIndex={-1} className="min-w-0 font-semibold outline-none">
            {active?.courses.join("、") || (done === feedback.teachers.length ? "本月反馈已全部提交" : "课程反馈")}
          </h2>
        </div>
        {status && <p role="status" className="mb-2 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">{status}</p>}
        {active ? (
          <section id="teacher-feedback" role="tabpanel" aria-labelledby={"teacher-" + active.id}>
            {active.studentDone && active.parentDone ? <p className="text-sm">学生和家长都已提交反馈。</p>
              : feedback.closed ? <p className="text-sm">本月反馈已结束。</p>
              : formUrl ? (
                <>
                  {monthlyTeacherDone(active) && <p className="mb-2 text-xs text-zinc-700">
                    {active.studentDone ? "学生已提交，家长仍可填写。" : "家长已提交，学生仍可填写。"}
                  </p>}
                  <p className="mb-1.5 text-xs text-zinc-700">请先在问卷里选择身份（学生 8 题，家长 9 题）。</p>
                  <iframe key={formUrl} src={formUrl} title={`${active.name}的飞书问卷`}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                    referrerPolicy="no-referrer"
                    className="block h-[max(420px,calc(100dvh-215px))] w-full rounded-lg border bg-white" />
                  <div className="sticky bottom-0 grid gap-1 bg-zinc-50 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                    {error && <p role="alert" className="rounded-md bg-orange-50 px-3 py-2 text-sm text-orange-900">{error}</p>}
                    <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-zinc-700">
                      <p>在飞书提交后，回来确认进度。</p>
                      <a href={formUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1 underline">
                        <ExternalLink aria-hidden="true" className="size-3" /> 在飞书打开
                      </a>
                    </div>
                    <Button className="min-h-11 w-full" disabled={busy} onClick={() => void confirm(active)}>
                      {busy ? "正在确认…" : "我已提交，确认进度"}
                    </Button>
                  </div>
                </>
              ) : <p className="text-sm" role="alert">飞书问卷暂时无法打开，请刷新页面。</p>}
          </section>
        ) : feedback.closed && <p className="text-sm">本月反馈已结束。</p>}
      </main>
    </Tabs>
  );
}
