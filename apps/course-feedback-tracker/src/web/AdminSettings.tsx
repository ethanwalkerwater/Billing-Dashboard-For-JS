import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLES, ROLE_LABELS } from "@/shared/roles";
import type { Role } from "@/shared/roles";
import { PageHeader, useRole } from "./AppNav";
import type { Page } from "./AppNav";
import { db } from "./cloudbase";
import { formatMoment } from "./report-types";

interface Member {
  user_id: string;
  display_name: string | null;
  role: Role;
  created_at: string;
}

const ORDER: Record<Role, number> = { super: 0, admin: 1, teacher: 2 };

/**
 * 超级管理员给每个飞书账号设权限。账号在第一次飞书登录时自动出现在这里，默认「只看问卷跟踪」。
 * 改权限直接写 feedback_admins.role，数据库只放行 super（feedback_admins_super_update 策略）。
 */
export function AdminSettings({
  page,
  onPageChange,
  onSignOut,
}: {
  page: Page;
  onPageChange: (page: Page) => void;
  onSignOut: () => void | Promise<void>;
}) {
  const { uid } = useRole();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await db
      .from("feedback_admins")
      .select<Member>("user_id,display_name,role,created_at")
      .eq("active", true);
    if (result.error) throw new Error(result.error.message);
    setMembers(result.data ?? []);
    return result.data ?? [];
  }, []);

  useEffect(() => {
    load().catch((cause) => setNotice(`读取账号失败：${cause instanceof Error ? cause.message : String(cause)}`));
  }, [load]);

  const rows = useMemo(
    () =>
      (members ?? [])
        .filter((member) => !query || (member.display_name ?? "").includes(query.trim()))
        .sort((a, b) => ORDER[a.role] - ORDER[b.role] || (a.display_name ?? "").localeCompare(b.display_name ?? "", "zh-CN")),
    [members, query],
  );

  async function changeRole(member: Member, role: Role) {
    setSaving(member.user_id);
    try {
      const result = await db.from("feedback_admins").update({ role }).eq("user_id", member.user_id);
      if (result.error) throw new Error(result.error.message);
      // 没权限时数据库不报错、只是一行都不改，所以重读一遍确认真的改了
      const fresh = await load();
      if (fresh.find((row) => row.user_id === member.user_id)?.role !== role) throw new Error("没有改成功，请确认自己仍是超级管理员");
      setNotice(`${member.display_name ?? "该账号"}：${ROLE_LABELS[role]}`);
    } catch (cause) {
      setNotice(`修改失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="bg-muted/40 min-h-screen">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6 lg:p-8">
        <PageHeader page={page} onPageChange={onPageChange} onSignOut={onSignOut} />

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名" className="h-8 w-64 pl-8" />
            </div>
            {notice ? <span className="text-muted-foreground ml-2 text-xs">{notice}</span> : null}
            <span className="text-muted-foreground ml-auto text-xs">共 {members?.length ?? "—"} 个账号</span>
          </div>

          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead className="w-64">权限</TableHead>
                  <TableHead className="w-40 text-right">首次登录</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members === null ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground py-10 text-center">
                      正在读取…
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((member) => (
                    <TableRow key={member.user_id}>
                      <TableCell className="font-medium">
                        {member.display_name || "（未知姓名）"}
                        {member.user_id === uid ? <span className="text-muted-foreground ml-2 text-xs">我</span> : null}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={member.role}
                          disabled={member.user_id === uid || saving !== null}
                          onValueChange={(value) => void changeRole(member, value as Role)}
                        >
                          <SelectTrigger size="sm" className="w-48" aria-label={`${member.display_name ?? ""}的权限`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right tabular-nums">{formatMoment(member.created_at)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </section>
      </div>
    </div>
  );
}
