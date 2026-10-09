/** 生日日期规则。纯函数；时区固定上海 UTC+8。 */
const DAY = 86_400_000;
const SHANGHAI = 8 * 3600_000;
export const ASK_DAYS_BEFORE = 3;

export type Ymd = { y: number; m: number; d: number };
export interface LessonStats { lessons: number; students: number; hours: number }

export interface TeacherRow {
  recordId: string;
  name: string;
  scheduleName: string;
  subject: string;
  birthMs: number | null;
  joinMs: number | null;
  active: boolean;
  openId: string | null;
  askedYear: number | null;
  celebratedYear: number | null;
  handwritten: string;
  aiBlessing: string;
  teaching: string;
  intro: string;
  photoToken: string | null;
  stats: LessonStats | null;
}

export type DueAction = { teacher: TeacherRow; kind: "ask" | "celebrate"; date: Ymd; daysLeft: number };

export function shanghaiYmd(ms: number): Ymd {
  const t = new Date(ms + SHANGHAI);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function ymdToMs({ y, m, d }: Ymd): number {
  return Date.UTC(y, m - 1, d) - SHANGHAI;
}

const dayIndex = ({ y, m, d }: Ymd) => Date.UTC(y, m - 1, d) / DAY;
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function birthdayIn(year: number, birth: Ymd): Ymd {
  if (birth.m === 2 && birth.d === 29 && !isLeap(year)) return { y: year, m: 2, d: 28 };
  return { y: year, m: birth.m, d: birth.d };
}

export function nextBirthday(today: Ymd, birth: Ymd): { date: Ymd; daysLeft: number } {
  let date = birthdayIn(today.y, birth);
  if (dayIndex(date) < dayIndex(today)) date = birthdayIn(today.y + 1, birth);
  return { date, daysLeft: dayIndex(date) - dayIndex(today) };
}

/** 今天该做的事。已发年份 = 生日所在年份，所以重跑、跨年都不会重复。 */
export function dueActions(teachers: TeacherRow[], todayMs: number): DueAction[] {
  const today = shanghaiYmd(todayMs);
  const actions: DueAction[] = [];
  for (const teacher of teachers) {
    if (!teacher.active || teacher.birthMs === null) continue;
    const { date, daysLeft } = nextBirthday(today, shanghaiYmd(teacher.birthMs));
    if (daysLeft <= ASK_DAYS_BEFORE && teacher.askedYear !== date.y) actions.push({ teacher, kind: "ask", date, daysLeft });
    if (daysLeft === 0 && teacher.celebratedYear !== date.y) actions.push({ teacher, kind: "celebrate", date, daysLeft });
  }
  return actions;
}

/** 在菁仕的第 N 天（入职当天是第 1 天）与蜡烛数（满几年，1–12 根）。 */
export function tenure(joinMs: number | null, todayMs: number): { days: number; candles: number } | null {
  if (joinMs === null) return null;
  const join = shanghaiYmd(joinMs);
  const today = shanghaiYmd(todayMs);
  const days = dayIndex(today) - dayIndex(join) + 1;
  if (days < 1) return null;
  let years = today.y - join.y;
  if (today.m < join.m || (today.m === join.m && today.d < join.d)) years -= 1;
  return { days, candles: Math.min(12, Math.max(1, years)) };
}
