import { CheckCircle2, CircleHelp, RefreshCw, Search, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { COURSE_TEACHING_TYPES, NON_COURSE_KEYWORDS, canonicalizeName, classifyLesson } from "@/domain";
import type { LessonKindSource } from "@/domain";
import { cn } from "@/lib/utils";
import { parseCsv } from "@/server/export/csv";
import { LIVE_SCORES_FROM } from "@/server/scores/recompute";
import { COURSE_TYPE_RULES_TABLE, SCORE_RESULTS_TABLE, SNAPSHOTS_TABLE } from "@/shared/rdb";
import { PageHeader } from "./AppNav";
import type { Page } from "./AppNav";
import { callFeedbackApi, db } from "./cloudbase";
import { monthName } from "./report-types";

/** 只看最近几个课程月份出现过的课程类型；课程类型是自由填写的，历史上有 462 个选项，大多早就不用了。 */
const RECENT_MONTHS = 3;

interface TypeRow {
  courseType: string;
  lessons: number;
  hours: number;
  teachingTypes: Map<string, number>;
  teachers: Map<string, number>;
  /** 不看手动设定时，系统按规则的判断（同一类型下不同授课类型可能结论不同，取课时多的那一边） */
  auto: { isCourse: boolean; reason: string; source: LessonKindSource };
  autoCourseLessons: number;
  manual?: boolean;
}

type View = "all" | "course" | "non-course" | "review" | "manual";

function useCourseTypes() {
  const [rows, setRows] = useState<TypeRow[] | null>(null);
  const [months, setMonths] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [snapshots, rules] = await Promise.all([
      db.from(SNAPSHOTS_TABLE).select<{ month: string; csv: string }>("month,csv").eq("kind", "schedule").order("month", { ascending: false }),
      db.from(COURSE_TYPE_RULES_TABLE).select<{ course_type: string; is_course: boolean }>("course_type,is_course"),
    ]);
    if (snapshots.error) throw new Error(snapshots.error.message);
    if (rules.error) throw new Error(rules.error.message);
    const recent = (snapshots.data ?? []).slice(0, RECENT_MONTHS);
    const manual = new Map((rules.data ?? []).map((rule) => [rule.course_type, rule.is_course]));

    const byType = new Map<
      string,
      TypeRow & {
        courseHours: number;
        nonCourseHours: number;
        reasons: Map<string, number>;
      }
    >();
    for (const snapshot of recent) {
      const [header, ...lines] = parseCsv(snapshot.csv);
      const col = (name: string) => header.indexOf(name);
      for (const cells of lines) {
        const hours = Number(cells[col("课程时长")]) || 0;
        const cancelled = cells[col("临时取消")] ?? "";
        if ((cancelled && cancelled !== "false") || hours <= 0) continue;
        const teachingType = (cells[col("授课类型")] ?? "").split("、").map(canonicalizeName).filter(Boolean).join("、");
        // 一节课可能挂了多个课程类型（「、」分隔），每个类型各记一次，按它自己判断
        const courseTypes = (cells[col("课程类型")] ?? "").split("、").map(canonicalizeName).filter(Boolean);
        for (const courseType of courseTypes.length ? courseTypes : ["（空）"]) {
          const kind = classifyLesson({
            courseTypes: courseType === "（空）" ? [] : [courseType],
            teachingTypes: teachingType ? teachingType.split("、") : [],
          });
          const row = byType.get(courseType) ?? {
            courseType,
            lessons: 0,
            hours: 0,
            teachingTypes: new Map(),
            teachers: new Map(),
            auto: kind,
            autoCourseLessons: 0,
            courseHours: 0,
            nonCourseHours: 0,
            reasons: new Map(),
          };
          row.lessons += 1;
          row.hours += hours;
          row.teachingTypes.set(teachingType || "空", (row.teachingTypes.get(teachingType || "空") ?? 0) + 1);
          const teacher = cells[col("老师")];
          if (teacher) row.teachers.set(teacher, (row.teachers.get(teacher) ?? 0) + hours);
          if (kind.isCourse) {
            row.autoCourseLessons += 1;
            row.courseHours += hours;
          } else row.nonCourseHours += hours;
          row.reasons.set(kind.reason, (row.reasons.get(kind.reason) ?? 0) + hours);
          byType.set(courseType, row);
        }
      }
    }
    setRows(
      [...byType.values()]
        .map((row) => {
          const isCourse = row.courseHours >= row.nonCourseHours;
          const reason = [...row.reasons].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
          const source: LessonKindSource = reason.startsWith("未标注") ? "default" : reason.startsWith("授课类型") ? "teaching-type" : "keyword";
          return {
            ...row,
            auto: { isCourse, reason, source },
            manual: manual.get(row.courseType),
          };
        })
        .sort((a, b) => b.hours - a.hours),
    );
    setMonths(recent.map((snapshot) => snapshot.month).sort());
    setOverrides(manual);
  }, []);

  useEffect(() => {
    load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  return { rows, months, overrides, error, setError, reload: load };
}

function Decision({ isCourse }: { isCourse: boolean }) {
  return isCourse ? (
    <Badge variant="success" className="font-normal">
      <CheckCircle2 /> 算课程
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground font-normal">
      <XCircle /> 不算课程
    </Badge>
  );
}

function top(map: Map<string, number>, count: number, unit = ""): string {
  return [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name, value]) => `${name}${unit ? ` ${Math.round(value * 10) / 10}${unit}` : `×${value}`}`)
    .join("、");
}

export function CourseTypes({ page, onPageChange, onSignOut }: { page: Page; onPageChange: (page: Page) => void; onSignOut: () => void | Promise<void> }) {
  const { rows, months, error, setError, reload } = useCourseTypes();
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const decided = (row: TypeRow) => row.manual ?? row.auto.isCourse;
  const counts = useMemo(() => {
    const list = rows ?? [];
    return {
      all: list.length,
      course: list.filter(decided).length,
      "non-course": list.filter((row) => !decided(row)).length,
      review: list.filter((row) => row.manual === undefined && row.auto.source === "default").length,
      manual: list.filter((row) => row.manual !== undefined).length,
    } satisfies Record<View, number>;
  }, [rows]);

  const visible = (rows ?? []).filter((row) => {
    if (query.trim() && !row.courseType.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (view === "course") return decided(row);
    if (view === "non-course") return !decided(row);
    if (view === "review") return row.manual === undefined && row.auto.source === "default";
    if (view === "manual") return row.manual !== undefined;
    return true;
  });

  /** 改一个类型的设定：存库，再把还没定稿的评分月份重算一遍（几秒），问卷名单下次「生成名单」生效。 */
  async function setRule(courseType: string, value: "auto" | "course" | "non-course") {
    setSaving(courseType);
    try {
      const result =
        value === "auto"
          ? await db.from(COURSE_TYPE_RULES_TABLE).delete().eq("course_type", courseType)
          : await db.from(COURSE_TYPE_RULES_TABLE).upsert(
              [
                {
                  course_type: courseType,
                  is_course: value === "course",
                  updated_by: "workbench",
                  updated_at: new Date().toISOString(),
                },
              ],
              {
                onConflict: "course_type",
              },
            );
      if (result.error) throw new Error(result.error.message);
      const drafts = await db.from(SCORE_RESULTS_TABLE).select<{ course_month: string }>("course_month").eq("status", "draft");
      const draftMonths = (drafts.data ?? []).map((row) => row.course_month).filter((month) => month >= LIVE_SCORES_FROM);
      for (const courseMonth of draftMonths) await callFeedbackApi({ action: "recompute-scores", courseMonth });
      await reload();
      setNotice(
        `已保存「${courseType}」：${value === "auto" ? "跟随系统判断" : value === "course" ? "算课程" : "不算课程"}。` +
          (draftMonths.length ? `已重算 ${draftMonths.map(monthName).join("、")} 的老师评分；` : "") +
          "问卷名单在下次「生成名单」时生效。",
      );
    } catch (cause) {
      setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="bg-muted/40 min-h-screen">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 p-6 lg:p-8">
        <PageHeader
          page={page}
          onPageChange={onPageChange}
          onSignOut={onSignOut}
          status={
            <p className="text-muted-foreground text-xs">
              统计范围：{months.length ? months.map(monthName).join("、") : "—"} 课表 · 只列这些月份实际用到的课程类型
            </p>
          }
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">什么算「课程」</CardTitle>
            <CardDescription className="leading-relaxed">
              只有课程才生成反馈问卷、才计入老师总课时和评分权重。系统按下面的顺序自动判断，判断不对的在表里改「设定」， 问卷名单和老师评分同时生效（已公布的 9
              月以前分数不重算）。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-3">
            <div className="rounded-lg border p-3">
              <div className="mb-1 font-medium">1. 课程类型名里有这些词 → 不算</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {NON_COURSE_KEYWORDS.map((rule) => `${rule.group}（${rule.pattern.source.replaceAll("|", "、")}）`).join("；")}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="mb-1 font-medium">2. 授课类型 → 是否课程</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {COURSE_TEACHING_TYPES.join("、")} 算课程；学生规划、自习、作业、助教、模考、学生模测、其他会议等其他授课类型不算。
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                3. 没填授课类型 → 先按课程算 <CircleHelp className="text-muted-foreground size-3.5" />
              </div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                比如「雅思刷题班」常常没填授课类型，默认排除会漏掉真课。这类放在「待复核」里，确认后设定一次就行。
              </div>
            </div>
          </CardContent>
        </Card>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>出错了</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={view} onValueChange={(value) => setView(value as View)}>
            <TabsList>
              <TabsTrigger value="all">全部 {counts.all}</TabsTrigger>
              <TabsTrigger value="course">算课程 {counts.course}</TabsTrigger>
              <TabsTrigger value="non-course">不算课程 {counts["non-course"]}</TabsTrigger>
              <TabsTrigger value="review">待复核 {counts.review}</TabsTrigger>
              <TabsTrigger value="manual">已手动设定 {counts.manual}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程类型" className="h-8 w-56 pl-8" />
          </div>
          {notice ? <span className="text-muted-foreground text-xs">{notice}</span> : null}
        </div>

        <Card className="py-0">
          <CardContent className="px-0">
            {!rows ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
                <RefreshCw className="size-4 animate-spin" /> 正在读取课表…
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">课程类型</TableHead>
                    <TableHead className="text-right">节数</TableHead>
                    <TableHead className="text-right">课时</TableHead>
                    <TableHead>授课类型</TableHead>
                    <TableHead>主要老师</TableHead>
                    <TableHead>系统判断</TableHead>
                    <TableHead className="pr-6">设定</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <TableRow key={row.courseType} className={cn(row.manual === undefined && row.auto.source === "default" && "bg-warning/5")}>
                      <TableCell className="pl-6 font-medium whitespace-normal">{row.courseType}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{row.lessons}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{Math.round(row.hours * 10) / 10}</TableCell>
                      <TableCell className="text-muted-foreground text-xs whitespace-normal">{top(row.teachingTypes, 3)}</TableCell>
                      <TableCell className="text-muted-foreground max-w-56 truncate text-xs" title={top(row.teachers, 10, "h")}>
                        {top(row.teachers, 3, "h") || "—"}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="flex flex-col gap-1">
                          <Decision isCourse={row.auto.isCourse} />
                          <span className="text-muted-foreground text-xs">{row.auto.reason}</span>
                        </div>
                      </TableCell>
                      <TableCell className="pr-6">
                        <Select
                          value={row.manual === undefined ? "auto" : row.manual ? "course" : "non-course"}
                          onValueChange={(value) => void setRule(row.courseType, value as "auto" | "course" | "non-course")}
                          disabled={saving !== null}
                        >
                          <SelectTrigger size="sm" className={cn("w-36", row.manual !== undefined && "border-primary/40")}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">跟随系统判断</SelectItem>
                            <SelectItem value="course">算课程</SelectItem>
                            <SelectItem value="non-course">不算课程</SelectItem>
                          </SelectContent>
                        </Select>
                        {saving === row.courseType ? <RefreshCw className="text-muted-foreground ml-2 inline size-3.5 animate-spin" /> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                  {visible.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground py-12 text-center">
                        没有符合条件的课程类型
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
