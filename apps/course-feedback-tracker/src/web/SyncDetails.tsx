import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface SyncSummary {
  scheduleRecordsScanned?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  excludedRecords?: Array<{ recordId: string; reason: string }>;
  reviewRecords?: Array<{ recordId: string; reason: string }>;
  invalidRecords?: Array<{ recordId: string; reasons: string[] }>;
  studentsMissingFromForm?: string[];
  teachersMissingFromForm?: string[];
  responseMonth?: string | null;
  monthTotal?: number;
  matched?: number;
  duplicate?: number;
  unlinked?: number;
  exception?: number;
  tasksCovered?: number;
  outcomes?: Array<{ responseRecordId: string; taskId: string | null; syncStatus: string; exceptionCode?: string }>;
}

function Bucket({ title, hint, items }: { title: string; hint: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className="group border-t py-2 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
        <span>{title}</span>
        <span className="text-muted-foreground font-mono text-xs">{items.length}</span>
      </summary>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{hint}</p>
      <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
        {items.slice(0, 50).map((item, index) => (
          <li key={`${item}-${index}`} className="text-muted-foreground font-mono text-xs">
            {item}
          </li>
        ))}
      </ul>
      {items.length > 50 ? <p className="text-muted-foreground mt-1 text-xs">仅显示前 50 条，完整清单请导出任务 CSV。</p> : null}
    </details>
  );
}

/** 同步明细：默认折叠，排查时才展开。人员对不上已在顶部横幅单独提示。 */
export function SyncDetails({ summary }: { summary: SyncSummary }) {
  const exceptions = (summary.outcomes ?? []).filter((outcome) => outcome.syncStatus === "exception");
  const lines: string[] = [];
  if (summary.scheduleRecordsScanned !== undefined) {
    lines.push(`课表 ${summary.scheduleRecordsScanned} 条 · 新建 ${summary.created} · 更新 ${summary.updated} · 未变 ${summary.unchanged}`);
  }
  if (summary.monthTotal !== undefined) {
    lines.push(
      `${summary.responseMonth} 收到反馈 ${summary.monthTotal} 份 · 对上 ${summary.matched}（${summary.tasksCovered} 个任务）· 对不上 ${summary.unlinked} · 重复 ${summary.duplicate} · 异常 ${summary.exception}`,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">最近一次同步</CardTitle>
        <CardDescription className="font-mono text-xs">{lines.join("　")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Bucket
          title="问卷下拉里缺的姓名"
          hint="课表里有、问卷「学生姓名 / 老师姓名」下拉里没有的名字。系统不会改飞书表；这些人扫码后预填会失败，需要在飞书里手动把选项加上。"
          items={[
            ...(summary.studentsMissingFromForm ?? []).map((name) => `学生 · ${name}`),
            ...(summary.teachersMissingFromForm ?? []).map((name) => `老师 · ${name}`),
          ]}
        />
        <Bucket
          title="课程类型待确认"
          hint="已经生成了任务，但课程类型看起来不像常规授课，复核后决定是否改成「拒绝填写」。"
          items={(summary.reviewRecords ?? []).map((record) => `${record.recordId} · ${record.reason}`)}
        />
        <Bucket
          title="未生成任务的课表记录"
          hint="临时取消或明确的非授课项目，按规则跳过。"
          items={(summary.excludedRecords ?? []).map((record) => `${record.recordId} · ${record.reason}`)}
        />
        <Bucket
          title="课表数据有问题"
          hint="缺学生、缺老师或字段结构异常，需要到飞书课表里修好再重新同步。"
          items={(summary.invalidRecords ?? []).map((record) => `${record.recordId} · ${record.reasons.join("、")}`)}
        />
        <Bucket
          title="字段异常的答卷"
          hint="解析不出提交时间等关键字段，需要到飞书里看这条记录。"
          items={exceptions.map((outcome) => `${outcome.responseRecordId} · ${outcome.exceptionCode ?? "未知原因"}`)}
        />
      </CardContent>
    </Card>
  );
}
