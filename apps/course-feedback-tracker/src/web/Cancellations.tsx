import { Check, Copy, QrCode, RefreshCw, Search, UserPlus } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cancelLinkUrl } from "@/cancellation/links";
import { PageHeader } from "./AppNav";
import type { Page } from "./AppNav";
import { app, db } from "./cloudbase";
import { downloadBlob } from "./qr";

interface LinkRow {
  token: string;
  student_key: string;
  student_name: string;
}

interface CancelRecord {
  intent_id: string;
  student_name: string;
  lesson_label: string | null;
  teacher_name: string | null;
  status: "applied" | "rejected";
  tier: string | null;
  reason: string | null;
  message: string | null;
  processed_at: string;
}

/** 只取最近的记录；更早的到飞书「取消申请」表查 */
const RECORD_LIMIT = 300;

function useCancellationData() {
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [records, setRecords] = useState<CancelRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [linkResult, recordResult] = await Promise.all([
      db.from("cancel_links").select<LinkRow>("token,student_key,student_name").eq("active", true).order("student_name", { ascending: true }),
      db
        .from("cancel_intents")
        .select<CancelRecord>("intent_id,student_name,lesson_label,teacher_name,status,tier,reason,message,processed_at")
        .in("status", ["applied", "rejected"])
        .order("processed_at", { ascending: false })
        .limit(RECORD_LIMIT),
    ]);
    if (linkResult.error || recordResult.error) {
      setError((linkResult.error ?? recordResult.error)!.message);
      return;
    }
    setLinks(linkResult.data ?? []);
    setRecords(recordResult.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { links, records, error, reload: load };
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function LinkActions({ row }: { row: LinkRow }) {
  const [copied, setCopied] = useState(false);
  const url = cancelLinkUrl(row.token);
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check /> : <Copy />} {copied ? "已复制" : "复制链接"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void QRCode.toDataURL(url, { width: 480, margin: 2 })
            .then((dataUrl) => fetch(dataUrl))
            .then((response) => response.blob())
            .then((blob) => downloadBlob(blob, `${row.student_name}-取消课程二维码.png`))
        }
        aria-label={`下载 ${row.student_name} 的二维码`}
      >
        <QrCode /> 二维码
      </Button>
    </div>
  );
}

export function Cancellations({
  page,
  onPageChange,
  onSignOut,
}: {
  page: Page;
  onPageChange: (page: Page) => void;
  onSignOut: () => void | Promise<void>;
}) {
  const { links, records, error, reload } = useCancellationData();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const keyword = query.trim().toLowerCase();
  const matches = (name: string) => !keyword || name.toLowerCase().includes(keyword);
  const visibleLinks = useMemo(() => (links ?? []).filter((row) => matches(row.student_name)), [links, keyword]);
  const visibleRecords = useMemo(() => records.filter((row) => matches(row.student_name)), [records, keyword]);

  async function generateLinks() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await app.callFunction({ name: "cancel-api", data: { action: "ensure-links" } });
      const payload = result.result as { ok: boolean; error?: string; created?: number; existing?: number; names?: string[] };
      if (!payload.ok) throw new Error(payload.error ?? "生成失败");
      setNotice(
        payload.created
          ? `新生成 ${payload.created} 位学生的链接：${payload.names!.slice(0, 10).join("、")}${payload.created > 10 ? " 等" : ""}`
          : `所有在读学生都已有链接（共 ${payload.existing} 位）`,
      );
      await reload();
    } catch (cause) {
      setNotice(`生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-muted/40 min-h-screen">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6 lg:p-8">
        <PageHeader
          page={page}
          onPageChange={onPageChange}
          onSignOut={onSignOut}
          actions={
            <>
              <Button variant="outline" onClick={() => void reload()}>
                <RefreshCw /> 刷新
              </Button>
              <Button onClick={() => void generateLinks()} disabled={busy}>
                <UserPlus /> {busy ? "正在生成…" : "为新学生生成链接"}
              </Button>
            </>
          }
          status={
            <p className="text-muted-foreground text-xs">
              学生用专属链接选课取消，提交飞书问卷后自动写入课表「临时取消」并通知老师。新学生加入学员信息表后，点「为新学生生成链接」。
            </p>
          }
        />

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>读取失败：{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <div className="relative max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索学生姓名" className="bg-background pl-9" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">学生取消链接</CardTitle>
              <CardDescription>{links ? `${visibleLinks.length} / ${links.length} 位学生` : "正在读取…"}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>学生</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleLinks.map((row) => (
                    <TableRow key={row.token}>
                      <TableCell className="font-medium">{row.student_name}</TableCell>
                      <TableCell>
                        <LinkActions row={row} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {links && !visibleLinks.length ? (
                    <TableRow>
                      <TableCell colSpan={2} className="text-muted-foreground py-8 text-center">
                        {links.length ? "没有匹配的学生" : "还没有生成链接，点右上角「为新学生生成链接」"}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">取消记录</CardTitle>
              <CardDescription>最近 {RECORD_LIMIT} 条；病假和未生效的记录需要教务跟进</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>提交时间</TableHead>
                    <TableHead>学生</TableHead>
                    <TableHead>课程</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRecords.map((row) => (
                    <TableRow key={row.intent_id}>
                      <TableCell className="text-muted-foreground whitespace-nowrap tabular-nums">{formatTime(row.processed_at)}</TableCell>
                      <TableCell className="font-medium">{row.student_name}</TableCell>
                      <TableCell>
                        <div>{row.lesson_label ?? "—"}</div>
                        {row.teacher_name ? <div className="text-muted-foreground text-xs">{row.teacher_name}</div> : null}
                      </TableCell>
                      <TableCell>
                        {row.status === "applied" ? (
                          <Badge variant={row.reason === "sick" ? "warning" : "success"}>{row.tier}</Badge>
                        ) : (
                          <Badge variant="destructive">未生效</Badge>
                        )}
                        <div className="text-muted-foreground mt-1 text-xs">
                          {row.reason === "sick" ? "病假 · " : ""}
                          {row.message}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!visibleRecords.length ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-muted-foreground py-8 text-center">
                        暂无取消记录
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
