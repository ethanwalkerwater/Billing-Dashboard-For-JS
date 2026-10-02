import { ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KIND_LABELS, MIN_SAMPLES, OUTCOME_LABELS, SUBJECTS, averageDelta, emptyTally, groupTally, positiveRate, tally, teachersOf } from "@/domain/progress";
import type { Outcome, Sample, ScoreRecord, Subject, Tally } from "@/domain/progress";
import { cn } from "@/lib/utils";
import { Matrix, OutcomeRows, pct, signed, sortOutcomeRows } from "./charts";
import { SortHead, useSort } from "./sort";

const SCORE_TABLE_URL = import.meta.env.VITE_FEISHU_SCORE_TABLE_URL as string | undefined;
export const recordUrl = (recordId: string) => (SCORE_TABLE_URL ? `${SCORE_TABLE_URL}&record=${recordId}` : null);

export interface Nav {
  teacher: (name: string) => void;
  student: (id: string) => void;
}

const OUTCOME_DOT: Record<Outcome, string> = { up: "bg-viz-up", flat: "bg-viz-flat", down: "bg-viz-down" };
const OUTCOME_RANK: Record<Outcome, number> = { up: 2, flat: 1, down: 0 };
const outcomeOf = (delta: number): Outcome => (delta > 0 ? "up" : delta < 0 ? "down" : "flat");

function Dot({ outcome }: { outcome: Outcome }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", OUTCOME_DOT[outcome])} aria-label={OUTCOME_LABELS[outcome]} />;
}

/** 正负号 + 圆点，圆点表明提升 / 持平 / 下降，文字保持正文色。 */
function Delta({ value, digits }: { value: number | null; digits?: number }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <Dot outcome={outcomeOf(value)} />
      {signed(value, digits)}
    </span>
  );
}

export function Stat({ label, value, hint, className }: { label: string; value: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-1 py-4", className)}>
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
      </CardHeader>
    </Card>
  );
}

function Section({ title, description, action, children, className }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (next: T) => void; label: string }) {
  return (
    <div className="flex shrink-0 rounded-md border p-0.5 text-sm" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={cn("rounded-[5px] px-2.5 py-1 transition-colors", value === key ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-accent")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const rateDiff = (a: Tally | undefined, b: Tally | undefined) => {
  const x = a && positiveRate(a);
  const y = b && positiveRate(b);
  return x == null || y == null ? null : x - y;
};

function PointDiff({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const points = Math.round(value * 100);
  return <span className="tabular-nums">{points > 0 ? `+${points}` : points} 个百分点</span>;
}

const teacherRowsOf = (samples: Sample[]) => sortOutcomeRows([...groupTally(samples, teachersOf)].map(([key, value]) => ({ key, tally: value })));

// ---------- 明细（各视图共用） ----------

export function SamplesTable({ samples, nav, maxHeight = "max-h-[560px]" }: { samples: Sample[]; nav: Nav; maxHeight?: string }) {
  const { sorted, sort } = useSort(
    samples,
    {
      date: (s) => s.date,
      student: (s) => s.studentName,
      subject: (s) => SUBJECTS.indexOf(s.subject),
      teacher: (s) => s.teachers[0]?.name,
      prev: (s) => s.prevDate,
      after: (s) => s.after,
      delta: (s) => s.delta,
      outcome: (s) => OUTCOME_RANK[s.outcome],
    },
    { key: "date", dir: "desc" },
  );
  return (
    <div className={cn("overflow-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-card", maxHeight)}>
      <Table containerClassName="overflow-visible">
        <TableHeader>
          <TableRow>
            <SortHead label="考试日期" sortKey="date" sort={sort} />
            <SortHead label="学生" sortKey="student" sort={sort} text />
            <SortHead label="科目" sortKey="subject" sort={sort} text />
            <SortHead label="老师（期间课数）" sortKey="teacher" sort={sort} text />
            <SortHead label="上一次" sortKey="prev" sort={sort} />
            <SortHead label="成绩" sortKey="after" sort={sort} className="text-right" />
            <SortHead label="提分" sortKey="delta" sort={sort} className="text-right" />
            <SortHead label="结果" sortKey="outcome" sort={sort} />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((sample) => (
            <TableRow key={sample.key}>
              <TableCell className="tabular-nums">{sample.date}</TableCell>
              <TableCell>
                <button type="button" className="hover:underline" onClick={() => nav.student(sample.studentId)}>
                  {sample.studentName}
                </button>
              </TableCell>
              <TableCell>{sample.subject}</TableCell>
              <TableCell className="whitespace-normal">
                {sample.teachers.map((item, index) => (
                  <span key={item.name}>
                    {index > 0 ? "、" : null}
                    <button type="button" className="hover:underline" onClick={() => nav.teacher(item.name)}>
                      {item.name}
                    </button>
                    {item.lessons ? <span className="text-muted-foreground"> {item.lessons}</span> : null}
                  </span>
                ))}
                {sample.assigned ? <span className="text-muted-foreground text-xs">（指定）</span> : null}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {KIND_LABELS[sample.prevKind!]} {sample.prevDate}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {sample.before} → {sample.after}
              </TableCell>
              <TableCell className="text-right">
                <Delta value={sample.delta} />
              </TableCell>
              <TableCell>{OUTCOME_LABELS[sample.outcome]}</TableCell>
              <TableCell>
                {recordUrl(sample.recordId) ? (
                  <a className="text-primary inline-flex items-center gap-1 text-xs hover:underline" href={recordUrl(sample.recordId)!} target="_blank" rel="noreferrer">
                    飞书 <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------- 总览 ----------

type MatrixBy = "subject" | "month";
const columnOf = (sample: Sample, by: MatrixBy) => (by === "subject" ? sample.subject : sample.date.slice(0, 7));

export function OverviewView({ samples, subjects, nav }: { samples: Sample[]; subjects: Set<Subject>; nav: Nav }) {
  const [matrixBy, setMatrixBy] = useState<MatrixBy>("subject");
  const [focus, setFocus] = useState<{ teacher: string | null; column: string | null }>({ teacher: null, column: null });
  const overall = useMemo(() => tally(samples), [samples]);
  const teacherRows = useMemo(() => teacherRowsOf(samples), [samples]);
  const matrix = useMemo(() => {
    const columns = matrixBy === "subject" ? SUBJECTS.filter((subject) => subjects.has(subject)) : [...new Set(samples.map((s) => s.date.slice(0, 7)))].sort();
    return {
      columns: columns as string[],
      cells: groupTally(samples, (sample) => teachersOf(sample).map((teacher) => `${teacher}|${columnOf(sample, matrixBy)}`)),
      overall: groupTally(samples, (sample) => [columnOf(sample, matrixBy)]),
    };
  }, [samples, matrixBy, subjects]);
  const detail = useMemo(
    () => samples.filter((s) => (!focus.teacher || teachersOf(s).includes(focus.teacher)) && (!focus.column || columnOf(s, matrixBy) === focus.column)),
    [samples, focus, matrixBy],
  );

  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="样本" value={overall.n} hint="实考 × 科目，去重" className="col-span-2 md:col-span-1" />
        <Stat label="正向率" value={pct(positiveRate(overall))} hint="本次比上一次高" />
        <Stat label="平均提分" value={signed(averageDelta(overall), 2)} />
        <Stat label="持平" value={pct(overall.flat / overall.n)} hint={`${overall.flat} 条`} />
        <Stat label="下降" value={pct(overall.down / overall.n)} hint={`${overall.down} 条`} />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Section title="老师对比" description="一科多位老师时每人各算一次；点老师进入老师详情">
          <OutcomeRows rows={teacherRows} head="老师" onPick={nav.teacher} />
        </Section>
        <Section
          title="正向率矩阵"
          description={`颜色越深正向率越高；虚线格样本少于 ${MIN_SAMPLES} 条；点格子筛明细`}
          action={
            <Segmented
              label="矩阵列"
              value={matrixBy}
              options={[
                ["subject", "按科目"],
                ["month", "按月份"],
              ]}
              onChange={(next) => {
                setMatrixBy(next);
                setFocus({ teacher: null, column: null });
              }}
            />
          }
        >
          <Matrix
            teachers={teacherRows.map((row) => row.key)}
            columns={matrix.columns}
            cells={matrix.cells}
            overall={matrix.overall}
            active={focus}
            onPick={(teacher, column) => setFocus((cur) => (cur.teacher === teacher && cur.column === column ? { teacher: null, column: null } : { teacher, column }))}
          />
        </Section>
      </div>

      <Section
        title={`明细 · ${detail.length} 条`}
        description="点表头排序；点学生或老师名字进入对应视图"
        action={
          focus.teacher || focus.column ? (
            <Badge variant="secondary" className="gap-1">
              {[focus.teacher ?? "整体", focus.column].filter(Boolean).join(" · ")}
              <button type="button" onClick={() => setFocus({ teacher: null, column: null })} aria-label="清除">
                <X className="size-3" />
              </button>
            </Badge>
          ) : null
        }
      >
        <SamplesTable samples={detail} nav={nav} />
      </Section>
    </>
  );
}

// ---------- 老师 ----------

export function TeacherView({ samples, teacher, onTeacher, nav }: { samples: Sample[]; teacher: string | null; onTeacher: (name: string) => void; nav: Nav }) {
  const ranking = useMemo(() => teacherRowsOf(samples), [samples]);
  const current = teacher && ranking.some((row) => row.key === teacher) ? teacher : (ranking[0]?.key ?? null);
  const mine = useMemo(() => samples.filter((s) => current && teachersOf(s).includes(current)), [samples, current]);
  const mineTally = useMemo(() => tally(mine), [mine]);
  const ranked = ranking.filter((row) => row.tally.n >= MIN_SAMPLES);
  const rank = ranked.findIndex((row) => row.key === current);

  const bySubject = useMemo(
    () => SUBJECTS.flatMap((subject) => {
      const value = tally(mine.filter((s) => s.subject === subject));
      return value.n ? [{ key: subject, tally: value }] : [];
    }),
    [mine],
  );

  const months = useMemo(() => {
    const allByMonth = groupTally(samples, (s) => [s.date.slice(0, 7)]);
    return [...groupTally(mine, (s) => [s.date.slice(0, 7)])].map(([month, value]) => ({ month, value, all: allByMonth.get(month)! }));
  }, [samples, mine]);
  const monthSort = useSort(
    months,
    {
      month: (r) => r.month,
      n: (r) => r.value.n,
      rate: (r) => positiveRate(r.value),
      avg: (r) => averageDelta(r.value),
      all: (r) => positiveRate(r.all),
      diff: (r) => rateDiff(r.value, r.all),
    },
    { key: "month", dir: "desc" },
  );

  if (!current) return <Empty />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={current} onValueChange={onTeacher}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ranking.map((row) => (
              <SelectItem key={row.key} value={row.key}>
                {row.key}（{row.tally.n}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">
          {rank >= 0 ? `正向率排名 ${rank + 1} / ${ranked.length}` : `样本少于 ${MIN_SAMPLES} 条，不参与排名`}
        </span>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="样本" value={mineTally.n} className="col-span-2 md:col-span-1" />
        <Stat label="正向率" value={pct(positiveRate(mineTally))} hint={<>全体 {pct(positiveRate(tally(samples)))}</>} />
        <Stat label="平均提分" value={signed(averageDelta(mineTally), 2)} hint={<>全体 {signed(averageDelta(tally(samples)), 2)}</>} />
        <Stat label="学生" value={new Set(mine.map((s) => s.studentId)).size} />
        <Stat label="持平 / 下降" value={`${mineTally.flat} / ${mineTally.down}`} />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
        <Section title="按科目">
          <OutcomeRows rows={bySubject} head="科目" />
        </Section>
        <Section title="按月份" description="和同月全体老师比；点表头排序">
          <Table>
            <TableHeader>
              <TableRow>
                <SortHead label="月份" sortKey="month" sort={monthSort.sort} />
                <SortHead label="样本" sortKey="n" sort={monthSort.sort} className="text-right" />
                <SortHead label="正向率" sortKey="rate" sort={monthSort.sort} className="text-right" />
                <SortHead label="平均提分" sortKey="avg" sort={monthSort.sort} className="text-right" />
                <SortHead label="同月全体" sortKey="all" sort={monthSort.sort} className="text-right" />
                <SortHead label="差距" sortKey="diff" sort={monthSort.sort} className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthSort.sorted.map((row) => (
                <TableRow key={row.month}>
                  <TableCell className="tabular-nums">{row.month}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.value.n}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(positiveRate(row.value))}</TableCell>
                  <TableCell className="text-right">
                    <Delta value={averageDelta(row.value)} digits={2} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">{pct(positiveRate(row.all))}</TableCell>
                  <TableCell className="text-right">
                    <PointDiff value={rateDiff(row.value, row.all)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      </div>

      <Section title={`${current} 的学生 · ${mine.length} 条`} description="点表头排序，比如按提分从高到低">
        <SamplesTable samples={mine} nav={nav} />
      </Section>
    </>
  );
}

// ---------- 月度 ----------

export function MonthView({ samples, subjects, nav }: { samples: Sample[]; subjects: Set<Subject>; nav: Nav }) {
  const months = useMemo(() => [...new Set(samples.map((s) => s.date.slice(0, 7)))].sort().reverse(), [samples]);
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked && months.includes(picked) ? picked : (months[0] ?? null);
  const prevMonth = month ? (months[months.indexOf(month) + 1] ?? null) : null;
  const cur = useMemo(() => samples.filter((s) => s.date.startsWith(month ?? "-")), [samples, month]);
  const prev = useMemo(() => samples.filter((s) => s.date.startsWith(prevMonth ?? "-")), [samples, prevMonth]);
  const curTally = tally(cur);
  const prevTally = tally(prev);
  const curRows = useMemo(() => teacherRowsOf(cur), [cur]);

  const compare = useMemo(() => {
    const before = groupTally(prev, teachersOf);
    return curRows.map((row) => ({ teacher: row.key, now: row.tally, before: before.get(row.key) }));
  }, [curRows, prev]);
  const compareSort = useSort(
    compare,
    {
      teacher: (r) => r.teacher,
      n: (r) => r.now.n,
      rate: (r) => positiveRate(r.now),
      before: (r) => (r.before ? positiveRate(r.before) : null),
      diff: (r) => rateDiff(r.now, r.before),
      avg: (r) => averageDelta(r.now),
    },
    { key: "rate", dir: "desc" },
  );
  const matrixCells = useMemo(() => groupTally(cur, (s) => teachersOf(s).map((t) => `${t}|${s.subject}`)), [cur]);
  const matrixOverall = useMemo(() => groupTally(cur, (s) => [s.subject]), [cur]);

  if (!month) return <Empty />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={month} onValueChange={setPicked}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">按考试日期归月；{prevMonth ? `环比对象 ${prevMonth}` : "没有更早的月份可比"}</span>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="样本" value={curTally.n} hint={prevMonth ? `上月 ${prevTally.n}` : undefined} />
        <Stat label="正向率" value={pct(positiveRate(curTally))} hint={prevMonth ? <PointDiff value={rateDiff(curTally, prevTally)} /> : undefined} />
        <Stat label="平均提分" value={signed(averageDelta(curTally), 2)} hint={prevMonth ? `上月 ${signed(averageDelta(prevTally), 2)}` : undefined} />
        <Stat label="参与老师" value={curRows.length} hint={`学生 ${new Set(cur.map((s) => s.studentId)).size} 人`} />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Section title={`${month} 老师对比`} description="点老师进入老师详情">
          <OutcomeRows rows={curRows} head="老师" onPick={nav.teacher} />
        </Section>
        <Section title={`${month} 老师 × 科目`}>
          <Matrix
            teachers={curRows.map((row) => row.key)}
            columns={SUBJECTS.filter((s) => subjects.has(s))}
            cells={matrixCells}
            overall={matrixOverall}
            active={{ teacher: null, column: null }}
            onPick={(teacher) => teacher && nav.teacher(teacher)}
          />
        </Section>
      </div>

      <Section title="和上月比" description="点表头排序">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="老师" sortKey="teacher" sort={compareSort.sort} text />
              <SortHead label="本月样本" sortKey="n" sort={compareSort.sort} className="text-right" />
              <SortHead label="本月正向率" sortKey="rate" sort={compareSort.sort} className="text-right" />
              <SortHead label="上月正向率" sortKey="before" sort={compareSort.sort} className="text-right" />
              <SortHead label="环比" sortKey="diff" sort={compareSort.sort} className="text-right" />
              <SortHead label="本月平均提分" sortKey="avg" sort={compareSort.sort} className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {compareSort.sorted.map((row) => (
              <TableRow key={row.teacher} className={cn(row.now.n < MIN_SAMPLES && "text-muted-foreground")}>
                <TableCell>
                  <button type="button" className="hover:underline" onClick={() => nav.teacher(row.teacher)}>
                    {row.teacher}
                  </button>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.now.n}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(positiveRate(row.now))}</TableCell>
                <TableCell className="text-right tabular-nums">{row.before ? `${pct(positiveRate(row.before))}（${row.before.n}）` : "—"}</TableCell>
                <TableCell className="text-right">
                  <PointDiff value={rateDiff(row.now, row.before)} />
                </TableCell>
                <TableCell className="text-right">
                  <Delta value={averageDelta(row.now)} digits={2} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={`${month} 明细 · ${cur.length} 条`}>
        <SamplesTable samples={cur} nav={nav} />
      </Section>
    </>
  );
}

// ---------- 学生 ----------

interface StudentLine {
  id: string;
  name: string;
  exams: number;
  latest: string | null;
  bySubject: Partial<Record<Subject, Sample>>;
  tally: Tally;
}

export function StudentView({ samples, records, student, onStudent, nav }: { samples: Sample[]; records: ScoreRecord[]; student: string | null; onStudent: (id: string | null) => void; nav: Nav }) {
  const lines = useMemo<StudentLine[]>(() => {
    const map = new Map<string, StudentLine>();
    for (const record of records) {
      if (!map.has(record.studentId)) map.set(record.studentId, { id: record.studentId, name: record.studentName, exams: 0, latest: null, bySubject: {}, tally: emptyTally() });
      if (record.kind === "exam") map.get(record.studentId)!.exams += 1;
    }
    for (const sample of samples) {
      const line = map.get(sample.studentId);
      if (!line) continue;
      const existing = line.bySubject[sample.subject];
      if (!existing || existing.date < sample.date) line.bySubject[sample.subject] = sample;
      if (!line.latest || line.latest < sample.date) line.latest = sample.date;
    }
    const byStudent = new Map<string, Sample[]>();
    for (const sample of samples) byStudent.set(sample.studentId, [...(byStudent.get(sample.studentId) ?? []), sample]);
    for (const line of map.values()) line.tally = tally(byStudent.get(line.id) ?? []);
    return [...map.values()];
  }, [samples, records]);

  const { sorted, sort } = useSort(
    lines,
    {
      name: (l) => l.name,
      exams: (l) => l.exams,
      latest: (l) => l.latest,
      ...Object.fromEntries(SUBJECTS.map((subject) => [subject, (l: StudentLine) => l.bySubject[subject]?.delta ?? null])),
      avg: (l) => averageDelta(l.tally),
      rate: (l) => positiveRate(l.tally),
    },
    { key: "latest", dir: "desc" },
  );
  const selected = lines.find((line) => line.id === student) ?? null;

  return (
    <>
      <Section title={`学生 · ${lines.length} 人`} description="每科显示最近一次实考相对上一次的变化；点学生看完整成绩记录和各老师的提升">
        <div className="max-h-[520px] overflow-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-card">
          <Table containerClassName="overflow-visible">
            <TableHeader>
              <TableRow>
                <SortHead label="学生" sortKey="name" sort={sort} text />
                <SortHead label="实考次数" sortKey="exams" sort={sort} className="text-right" />
                <SortHead label="最近实考" sortKey="latest" sort={sort} />
                {SUBJECTS.map((subject) => (
                  <SortHead key={subject} label={subject} sortKey={subject} sort={sort} className="text-right" />
                ))}
                <SortHead label="平均提分" sortKey="avg" sort={sort} className="text-right" />
                <SortHead label="正向率" sortKey="rate" sort={sort} className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((line) => (
                <TableRow
                  key={line.id}
                  data-state={line.id === student ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => onStudent(line.id === student ? null : line.id)}
                >
                  <TableCell className="font-medium">{line.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{line.exams}</TableCell>
                  <TableCell className="tabular-nums">{line.latest ?? <span className="text-muted-foreground">未实考</span>}</TableCell>
                  {SUBJECTS.map((subject) => {
                    const sample = line.bySubject[subject];
                    return (
                      <TableCell key={subject} className="text-right tabular-nums">
                        {sample ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-muted-foreground">
                              {sample.before}→{sample.after}
                            </span>
                            <Delta value={sample.delta} />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right">
                    <Delta value={averageDelta(line.tally)} digits={2} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{pct(positiveRate(line.tally))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      {selected ? <StudentDetail key={selected.id} line={selected} samples={samples.filter((s) => s.studentId === selected.id)} records={records.filter((r) => r.studentId === selected.id)} nav={nav} /> : null}
    </>
  );
}

function StudentDetail({ line, samples, records, nav }: { line: StudentLine; samples: Sample[]; records: ScoreRecord[]; nav: Nav }) {
  // 选中学生后详情在长列表下面，滚过去，不然看起来像没反应
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), []);
  const timeline = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const teachers = useMemo(() => {
    const rows = new Map<string, { teacher: string; subjects: Set<Subject>; samples: Sample[] }>();
    for (const sample of samples) {
      for (const name of teachersOf(sample)) {
        const row = rows.get(name) ?? { teacher: name, subjects: new Set<Subject>(), samples: [] };
        row.subjects.add(sample.subject);
        row.samples.push(sample);
        rows.set(name, row);
      }
    }
    return [...rows.values()].map((row) => ({ ...row, tally: tally(row.samples) })).sort((a, b) => (averageDelta(b.tally) ?? 0) - (averageDelta(a.tally) ?? 0));
  }, [samples]);

  return (
    <div ref={ref} className="grid scroll-mt-4 grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      <Section title={`${line.name} 的成绩记录`} description="阶段模考只做记录，不参与正向率">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead>类型</TableHead>
              {SUBJECTS.map((subject) => (
                <TableHead key={subject} className="text-right">
                  {subject}
                </TableHead>
              ))}
              <TableHead>备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {timeline.map((record) => (
              <TableRow key={record.id} className={cn(record.kind === "mock" && "text-muted-foreground")}>
                <TableCell className="tabular-nums">{record.date}</TableCell>
                <TableCell>
                  <Badge variant={record.kind === "exam" ? "default" : "outline"}>{KIND_LABELS[record.kind!]}</Badge>
                </TableCell>
                {SUBJECTS.map((subject) => (
                  <TableCell key={subject} className="text-right tabular-nums">
                    {record.scores[subject] ?? "—"}
                  </TableCell>
                ))}
                <TableCell className="text-muted-foreground max-w-64 truncate text-xs" title={record.note}>
                  {recordUrl(record.id) ? (
                    <a href={recordUrl(record.id)!} target="_blank" rel="noreferrer" className="hover:underline">
                      {record.note || "飞书"}
                    </a>
                  ) : (
                    record.note
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
      <Section title="各老师的提升" description="按平均提分从高到低">
        {teachers.length === 0 ? (
          <p className="text-muted-foreground text-sm">还没有可比较的实考。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>老师</TableHead>
                <TableHead>科目</TableHead>
                <TableHead className="text-right">样本</TableHead>
                <TableHead className="text-right">平均提分</TableHead>
                <TableHead>每次结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teachers.map((row) => (
                <TableRow key={row.teacher}>
                  <TableCell>
                    <button type="button" className="hover:underline" onClick={() => nav.teacher(row.teacher)}>
                      {row.teacher}
                    </button>
                  </TableCell>
                  <TableCell>{SUBJECTS.filter((s) => row.subjects.has(s)).join("、")}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.tally.n}</TableCell>
                  <TableCell className="text-right">
                    <Delta value={averageDelta(row.tally)} digits={2} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-normal tabular-nums">
                    {row.samples.map((s) => `${s.subject} ${s.before}→${s.after}`).join("；")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function Empty() {
  return (
    <Card>
      <CardContent className="text-muted-foreground py-14 text-center text-sm">当前筛选下没有样本。</CardContent>
    </Card>
  );
}
