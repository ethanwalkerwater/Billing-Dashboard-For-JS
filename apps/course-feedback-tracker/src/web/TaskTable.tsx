import { ArrowDown, ArrowUp, ChevronsUpDown, QrCode } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TASK_OWNERS, TASK_STATUS_LABELS } from "@/domain";
import type { TaskStatus } from "@/domain";
import { cn } from "@/lib/utils";
import type { StoredFeedbackTask } from "@/server/tasks/types";
import type { SortKey } from "./useWorkbenchData";
import { lastActivityAt, respondedBy } from "./useWorkbenchData";

const STATUS_VARIANT: Record<TaskStatus, "secondary" | "outline" | "success" | "destructive"> = {
  unsent: "outline",
  sent: "secondary",
  completed: "success",
  declined: "destructive",
};

function formatMoment(value?: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function SortableHead({
  label,
  sortKey,
  active,
  asc,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  asc: boolean;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <TableHead className={className}>
      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => onSort(sortKey)}>
        {label}
        {isActive ? (asc ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />) : <ChevronsUpDown className="size-3.5 opacity-50" />}
      </Button>
    </TableHead>
  );
}

function Dot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={`${label}${on ? "已评" : "未评"}`}>
      <span className={cn("size-2 rounded-full", on ? "bg-success" : "bg-border")} />
      <span className={on ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </span>
  );
}

/**
 * 一行一个学生-老师对：状态、谁评了、最近动作同屏，不用切 tab。
 * table-fixed + 显式列宽：否则 nowrap 的列把宽度让给「课程」，中间一大片空白，操作列被顶到最右边。
 */
export function TaskTable({
  tasks,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onOwnerChange,
  sortKey,
  sortAsc,
  onSort,
  loading,
}: {
  tasks: StoredFeedbackTask[];
  selected: Set<string>;
  onToggle: (taskId: string) => void;
  onToggleAll: () => void;
  onOpen: (task: StoredFeedbackTask) => void;
  onOwnerChange: (taskId: string, owner: string) => void;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  loading: boolean;
}) {
  const allSelected = tasks.length > 0 && tasks.every((task) => selected.has(task.taskId));
  const someSelected = tasks.some((task) => selected.has(task.taskId));

  return (
    <div className="rounded-md border">
      <Table className="table-fixed">
        <colgroup>
          <col className="w-10" />
          <col className="w-[18%]" />
          <col className="w-[13%]" />
          <col />
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-36" />
          <col className="w-44" />
          <col className="w-28" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-3">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={onToggleAll}
                aria-label="全选当前筛选结果"
              />
            </TableHead>
            <SortableHead label="学生" sortKey="student" active={sortKey} asc={sortAsc} onSort={onSort} />
            <SortableHead label="老师" sortKey="teacher" active={sortKey} asc={sortAsc} onSort={onSort} />
            <TableHead>课程</TableHead>
            <TableHead>负责人</TableHead>
            <SortableHead label="状态" sortKey="status" active={sortKey} asc={sortAsc} onSort={onSort} />
            <TableHead>谁评了</TableHead>
            <SortableHead label="最近动作" sortKey="activity" active={sortKey} asc={sortAsc} onSort={onSort} />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            const responded = respondedBy(task);
            const isSelected = selected.has(task.taskId);
            return (
              <TableRow key={task.taskId} data-state={isSelected ? "selected" : undefined}>
                <TableCell className="pl-3">
                  <Checkbox checked={isSelected} onCheckedChange={() => onToggle(task.taskId)} aria-label={`选择 ${task.studentName}`} />
                </TableCell>
                <TableCell className="truncate font-medium">
                  {task.studentName}
                  {task.boundBy === "manual" ? (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      手动绑定
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="truncate">{task.teacherCanonicalName}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {task.courseNames.map((course) => (
                      <Badge key={course} variant="outline" className="font-normal">
                        {course}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Select value={task.owner ?? ""} onValueChange={(owner) => onOwnerChange(task.taskId, owner)}>
                    <SelectTrigger
                      size="sm"
                      // 沿用之前月份的设定显示成灰色；在这个月改了就从这个月起生效
                      className={cn("h-7 w-full", task.owner && task.ownerFromMonth !== task.courseMonth && "text-muted-foreground")}
                      title={task.owner && task.ownerFromMonth !== task.courseMonth ? `沿用 ${Number(task.ownerFromMonth!.slice(5))} 月的设置，在这里改会从本月起生效` : undefined}
                      aria-label={`${task.studentName} 的负责人`}
                    >
                      <SelectValue placeholder="未分配" />
                    </SelectTrigger>
                    <SelectContent>
                      {TASK_OWNERS.map((owner) => (
                        <SelectItem key={owner} value={owner}>
                          {owner}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[task.status]}>{TASK_STATUS_LABELS[task.status]}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Dot on={responded.student} label="学生" />
                    <Dot on={responded.parent} label="家长" />
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <span className="mr-1.5 text-xs">{task.submittedAt ? "填写" : task.sentAt ? "发送" : "未发送"}</span>
                  <span className="font-mono text-xs">{formatMoment(lastActivityAt(task))}</span>
                </TableCell>
                <TableCell>
                  <Button variant="outline" size="sm" onClick={() => onOpen(task)}>
                    <QrCode /> 二维码
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {!loading && tasks.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="text-muted-foreground h-24 text-center whitespace-normal">
                当前筛选没有任务。先选择月份，再点「生成名单」。
              </TableCell>
            </TableRow>
          ) : null}
          {loading ? (
            <TableRow>
              <TableCell colSpan={9} className="text-muted-foreground h-24 text-center">
                正在读取…
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
