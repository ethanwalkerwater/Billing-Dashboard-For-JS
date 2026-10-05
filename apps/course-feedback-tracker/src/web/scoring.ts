/**
 * 浏览器里做的两件事：累计评分（按存好的月度分数加权）和排除老师后重排名次。
 * 口径逐行对应 apps/teacher-feedback/scripts/cumulative_teacher_feedback.py 的 aggregate_monthly_summaries
 * 和 monthly_teacher_feedback.py 的 finalize_teacher_score_rows：
 *   - 月度分数 × 当月课时，按老师加权平均；
 *   - 三项都有分才算总评分（三项平均），排名按未截断的总评分降序，真正同分同名次；
 *   - 显示保留三位小数，四舍五入（ROUND_HALF_UP，不是 JS toFixed 的二进制舍入）。
 * tests/scoring.test.ts 用 Python 跑出来的结果锁住。
 */
import { METRICS } from "./report-types";
import type { Contribution, CumulativeTeacher, MetricId, MonthReport, TeacherScore } from "./report-types";

const SCALE = 20n;
const TEN = 10n;

/** 浮点数按它的最短十进制写法（与 Python str(float) 相同）转成 ×10^20 的整数，做精确的十进制运算。 */
function toScaled(value: number): bigint {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  const negative = whole.startsWith("-");
  const digits = BigInt(whole.replace("-", "") + fraction.padEnd(Number(SCALE), "0").slice(0, Number(SCALE)));
  return negative ? -digits : digits;
}

/** 有理数 numerator / denominator 四舍五入（半数进位）到三位小数。 */
function roundHalfUp3(numerator: bigint, denominator: bigint): number {
  const scaled = numerator * 1000n;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return Number(quotient) / 1000;
}

/** 与 Python format(Decimal(str(value)).quantize(0.001, ROUND_HALF_UP)) 相同。 */
export function roundScore(value: number): number {
  return roundHalfUp3(toScaled(value), TEN ** SCALE);
}

/** 三项都有分：返回三项和（精确值，用于排名）与总评分（三位小数）。 */
function overallOf(scores: Record<MetricId, number | null>): { sum: bigint; overall: number } | null {
  const values = METRICS.map((metric) => scores[metric.id]);
  if (values.some((value) => value == null)) return null;
  const sum = values.reduce<bigint>((total, value) => total + toScaled(value!), 0n);
  return { sum, overall: roundHalfUp3(sum, 3n * TEN ** SCALE) };
}

/** Python 的 str 比较是按码点，不是按拼音；同分时的先后顺序要和它一致。 */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 按精确总和降序排，真正相等才同名次；无总评分的排在最后、按姓名。 */
function assignRanks<T extends { teacher: string; rank: number | null }>(rows: Array<{ row: T; sum: bigint | null }>): T[] {
  const scored = rows.filter((item) => item.sum != null).sort((a, b) => (a.sum! === b.sum! ? byCodePoint(a.row.teacher, b.row.teacher) : a.sum! > b.sum! ? -1 : 1));
  let lastSum: bigint | null = null;
  let rank = 0;
  scored.forEach((item, index) => {
    if (lastSum === null || item.sum !== lastSum) {
      rank = index + 1;
      lastSum = item.sum;
    }
    item.row.rank = rank;
  });
  const blank = rows.filter((item) => item.sum == null).sort((a, b) => byCodePoint(a.row.teacher, b.row.teacher));
  for (const item of blank) item.row.rank = null;
  return [...scored, ...blank].map((item) => item.row);
}

/** 月度：排除老师后剩下的人重新排名（分数不变，名次重排，和老看板「勾选即排除」一致）。 */
export function rerankMonth(teachers: TeacherScore[], hidden: ReadonlySet<string>): TeacherScore[] {
  return assignRanks(
    teachers
      .filter((teacher) => !hidden.has(teacher.teacher))
      .map((teacher) => ({ row: { ...teacher }, sum: overallOf(teacher.scores)?.sum ?? null })),
  );
}

/**
 * 某个月某位老师用于累计的分数（都是未截断的原精度）。
 * 实时月份：该项有效评分份数为 0 时不计（与脚本的 value_count 判断一致）；
 * 历史月份：以导入的定稿分数为准，分项份数是补算的，不参与判断。
 */
function monthScore(teacher: TeacherScore, metric: MetricId, source: MonthReport["source"]): number | null {
  if (source === "live" && teacher.counts && (teacher.counts[metric]?.total ?? 0) <= 0) return null;
  return teacher.scores[metric];
}

export function cumulative(
  months: MonthReport[],
  hidden: ReadonlySet<string>,
): { months: string[]; teachers: CumulativeTeacher[]; contributions: Contribution[] } {
  interface Accumulator {
    months: Set<string>;
    hours: number;
    respondedHours: number;
    responses: number;
    numerators: Record<MetricId, number>;
    metricHours: Record<MetricId, number>;
  }
  const zero = () => ({ learning_effect: 0, responsibility: 0, charisma: 0 }) as Record<MetricId, number>;
  const byTeacher = new Map<string, Accumulator>();
  const contributions: Contribution[] = [];
  const sorted = [...months].sort((a, b) => byCodePoint(a.month, b.month));

  for (const month of sorted) {
    for (const teacher of month.teachers) {
      if (hidden.has(teacher.teacher) || !(teacher.hours > 0)) continue;
      const item = byTeacher.get(teacher.teacher) ?? {
        months: new Set<string>(),
        hours: 0,
        respondedHours: 0,
        responses: 0,
        numerators: zero(),
        metricHours: zero(),
      };
      item.months.add(month.month);
      item.hours += teacher.hours;
      item.respondedHours += teacher.coverage * teacher.hours;
      item.responses += teacher.responses;
      const scores = {} as Record<MetricId, number | null>;
      for (const metric of METRICS) {
        const value = monthScore(teacher, metric.id, month.source);
        scores[metric.id] = value;
        if (value == null) continue;
        item.numerators[metric.id] += value * teacher.hours;
        item.metricHours[metric.id] += teacher.hours;
      }
      byTeacher.set(teacher.teacher, item);
      contributions.push({ month: month.month, teacher: teacher.teacher, hours: teacher.hours, source: month.source, scores });
    }
  }

  const rows = [...byTeacher].map(([teacher, item]) => {
    const scores = {} as Record<MetricId, number | null>;
    for (const metric of METRICS) {
      scores[metric.id] = item.metricHours[metric.id] > 0 ? item.numerators[metric.id] / item.metricHours[metric.id] : null;
    }
    const total = overallOf(scores);
    const monthList = [...item.months].sort();
    const row: CumulativeTeacher = {
      teacher,
      rank: null,
      overall: total?.overall ?? null,
      scores,
      hours: item.hours,
      monthCount: monthList.length,
      firstMonth: monthList[0],
      lastMonth: monthList[monthList.length - 1],
      coverage: item.hours > 0 ? item.respondedHours / item.hours : 0,
      responses: item.responses,
    };
    return { row, sum: total?.sum ?? null };
  });

  return {
    months: [...new Set(contributions.map((row) => row.month))].sort(),
    teachers: assignRanks(rows),
    contributions,
  };
}
