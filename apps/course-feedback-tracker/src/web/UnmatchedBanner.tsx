import { AlertTriangle, Link2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import { diagnoseUnlinked } from "./diagnose-unlinked";
import type { UnlinkedDiagnosis } from "./diagnose-unlinked";
import type { Alias, UnlinkedResponse } from "./useWorkbenchData";

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function Row({
  item,
  tasks,
  onAddAlias,
  onBind,
}: {
  item: UnlinkedDiagnosis;
  tasks: StoredFeedbackTask[];
  onAddAlias: (alias: Alias) => Promise<void>;
  onBind: (taskId: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);

  // 手动绑定的候选限定在"这个学生或这个老师"的任务里，不把 258 行全列出来。
  const bindCandidates = useMemo(
    () =>
      tasks
        .filter(
          (task) =>
            task.teacherCanonicalName === item.teacherName ||
            task.studentName.includes(item.studentName) ||
            item.studentName.includes(task.studentName),
        )
        .slice(0, 40),
    [item.studentName, item.teacherName, tasks],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const canAlias = Boolean(item.aliasKind) && item.candidates.length > 0;

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span>
            {item.studentName || "（学生空）"} <span className="text-muted-foreground">×</span> {item.teacherName || "（老师空）"}
          </span>
          <Badge variant="outline">{item.identity === "parent" ? "家长" : "学生"}</Badge>
          <span className="text-muted-foreground font-mono text-xs font-normal">{shortDate(item.submittedAt)}</span>
        </div>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{item.reason}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Select value={choice} onValueChange={setChoice}>
          <SelectTrigger size="sm" className="w-56">
            <SelectValue placeholder={canAlias ? (item.aliasKind === "teacher" ? "选对应的老师" : "选对应的学生") : "选一个任务手动绑定"} />
          </SelectTrigger>
          <SelectContent>
            {canAlias
              ? item.candidates.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))
              : bindCandidates.map((task) => (
                  <SelectItem key={task.taskId} value={task.taskId}>
                    {task.studentName} × {task.teacherCanonicalName}
                  </SelectItem>
                ))}
          </SelectContent>
        </Select>
        {canAlias ? (
          <Button
            size="sm"
            disabled={!choice || busy}
            onClick={() =>
              void run(() =>
                onAddAlias({
                  kind: item.aliasKind!,
                  alias: item.aliasKind === "teacher" ? item.teacherName : item.studentName,
                  canonical: choice,
                }),
              )
            }
          >
            <UserPlus /> 记住这个写法
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={!choice || busy} onClick={() => void run(() => onBind(choice))}>
            <Link2 /> 绑定
          </Button>
        )}
      </div>
    </div>
  );
}

/** 人员对不上的答卷，放在页面最上方。记住写法后，以后每个月这个人都能自动对上。 */
export function UnmatchedBanner({
  unlinked,
  tasks,
  onAddAlias,
  onBind,
}: {
  unlinked: UnlinkedResponse[];
  tasks: StoredFeedbackTask[];
  onAddAlias: (alias: Alias) => Promise<void>;
  onBind: (input: { responseRecordId: string; taskId: string; identity: "student" | "parent"; submittedAt: string }) => Promise<void>;
}) {
  const items = useMemo(() => diagnoseUnlinked(unlinked, tasks), [unlinked, tasks]);
  if (items.length === 0) return null;
  const aliasFixable = items.filter((item) => item.aliasKind && item.candidates.length > 0).length;

  return (
    <Alert variant="warning">
      <AlertTriangle />
      <AlertTitle>
        有 {items.length} 份反馈的人员对不上课表
        {aliasFixable > 0 ? <span className="text-muted-foreground font-normal">，其中 {aliasFixable} 份只是名字写法不同</span> : null}
      </AlertTitle>
      <AlertDescription className="block w-full">
        <div className="divide-y">
          {items.map((item) => (
            <Row
              key={item.responseRecordId}
              item={item}
              tasks={tasks}
              onAddAlias={onAddAlias}
              onBind={(taskId) => onBind({ responseRecordId: item.responseRecordId, taskId, identity: item.identity, submittedAt: item.submittedAt })}
            />
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}
