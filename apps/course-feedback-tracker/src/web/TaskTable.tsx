import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Circle, QrCode } from "lucide-react";

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
import { respondedBy } from "./useWorkbenchData";

const STATUS_OPTIONS: TaskStatus[] = ["unsent", "sent", "completed", "declined"];

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

function ResponseMark({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={`${label}${on ? "已评" : "未评"}`}>
      {on ? <Check aria-hidden="true" className="size-3 text-blue-700" /> : <Circle aria-hidden="true" className="size-3 text-muted-foreground" />}
      <span className={on ? "text-foreground" : "text-muted-foreground"}>
        {label}<span className="sr-only">{on ? "已评" : "未评"}</span>
      </span>
    </span>
  );
}

export function TaskTable({
  tasks,
  selected,
  highlighted,
  onToggle,
  onToggleAll,
  onOpen,
  onOwnerChange,
  onStatusChange,
  sortKey,
  sortAsc,
  onSort,
  loading,
}: {
  tasks: StoredFeedbackTask[];
  selected: Set<string>;
  /** 生成名单刚新增的任务，置顶后用浅黄底标出来 */
  highlighted?: ReadonlySet<string>;
  onToggle: (taskId: string) => void;
  onToggleAll: () => void;
  onOpen: (task: StoredFeedbackTask) => void;
  onOwnerChange: (taskId: string, owner: string) => void;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  loading: boolean;
}) {
  const allSelected = tasks.length > 0 && tasks.every((task) => selected.has(task.taskId));
  const someSelected = tasks.some((task) => selected.has(task.taskId));

  return (
    <div className="bg-background overflow-hidden rounded-md border">
      <Table className="min-w-[840px] table-fixed">
        <colgroup>
          <col className="w-10" />
          <col className="w-30 xl:w-48" />
          <col className="w-26 xl:w-42" />
          <col />
          <col className="w-26 xl:w-36" />
          <col className="w-28 xl:w-38" />
          <col className="w-30 xl:w-40" />
          <col className="w-25 xl:w-32" />
        </colgroup>
        <TableHeader className="bg-muted">
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
            <TableHead className="xl:px-3">负责人</TableHead>
            <SortableHead label="状态" sortKey="status" active={sortKey} asc={sortAsc} onSort={onSort} className="xl:px-3" />
            <TableHead className="xl:px-3">谁评了</TableHead>
            <TableHead className="bg-muted sticky right-0 z-10 border-l text-center xl:px-3">学生二维码</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_td]:py-1.5">
          {tasks.map((task) => {
            const responded = respondedBy(task);
            const isSelected = selected.has(task.taskId);
            const isNew = highlighted?.has(task.taskId) ?? false;
            const hasResponse = Boolean(task.studentResponseId || task.parentResponseId);
            return (
              <TableRow
                key={task.taskId}
                data-state={isSelected ? "selected" : undefined}
                className={cn("group", isNew && "bg-amber-50 hover:bg-amber-50/90 data-[state=selected]:bg-amber-100")}
              >
                <TableCell className="pl-3">
                  <Checkbox checked={isSelected} onCheckedChange={() => onToggle(task.taskId)} aria-label={`选择 ${task.studentName}`} />
                </TableCell>
                <TableCell className="truncate font-medium" title={task.studentName}>
                  {task.studentName}
                  {isNew ? (
                    <Badge variant="outline" className="ml-2 border-amber-300 bg-amber-100 text-[10px] text-amber-900">
                      新增
                    </Badge>
                  ) : null}
                  {task.boundBy === "manual" ? (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      手动绑定
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="truncate" title={task.teacherCanonicalName}>{task.teacherCanonicalName}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {task.courseNames.map((course) => (
                      <Badge key={course} variant="secondary" className="max-w-full whitespace-normal font-normal [overflow-wrap:anywhere]">
                        {course}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="xl:px-3">
                  <Select value={task.owner ?? ""} onValueChange={(owner) => onOwnerChange(task.taskId, owner)}>
                    <SelectTrigger
                      size="sm"
                      // 沿用之前月份的设定显示成灰色；在这个月改了就从这个月起生效
                      className={cn("w-full gap-1 px-2 shadow-none", task.owner && task.ownerFromMonth !== task.courseMonth && "text-muted-foreground")}
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
                <TableCell className="xl:px-3">
                  <Select
                    value={task.status}
                    onValueChange={(status) => onStatusChange(task.taskId, status as TaskStatus)}
                  >
                    <SelectTrigger size="sm" className="w-full gap-1 px-2 shadow-none" aria-label={`${task.studentName} 的状态`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((status) => (
                        <SelectItem key={status} value={status} disabled={hasResponse && status !== "completed"}>
                          {TASK_STATUS_LABELS[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="xl:px-3">
                  <div className="flex items-center gap-2 xl:gap-4">
                    <ResponseMark on={responded.student} label="学生" />
                    <ResponseMark on={responded.parent} label="家长" />
                  </div>
                </TableCell>
                <TableCell className={cn(
                  "sticky right-0 z-10 border-l text-center xl:px-3",
                  isNew ? "bg-amber-50 group-data-[state=selected]:bg-amber-100"
                    : "bg-background group-hover:bg-muted group-data-[state=selected]:bg-muted",
                )}>
                  <Button variant="outline" size="sm" className="w-full shadow-none has-[>svg]:px-1.5"
                    aria-label={`${task.studentName}的学生二维码`} onClick={() => onOpen(task)}>
                    <QrCode /> 二维码
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {!loading && tasks.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-muted-foreground h-24 text-center whitespace-normal">
                当前筛选没有任务。先选择月份，再点「生成名单」。
              </TableCell>
            </TableRow>
          ) : null}
          {loading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-muted-foreground h-24 text-center">
                正在读取…
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
