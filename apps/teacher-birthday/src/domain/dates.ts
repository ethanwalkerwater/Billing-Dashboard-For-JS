/** 生日日期规则。纯函数；时区固定上海 UTC+8。 */
const DAY = 86_400_000;
const SHANGHAI = 8 * 3600_000;
export const ASK_DAYS_BEFORE = 3;
/** 生日当天群卡片没发成功（飞书报错、函数超时）时，之后几天内补发 */
export const CELEBRATE_CATCH_UP_DAYS = 2;

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

/** 本次收集从生日前 3 天开始，到下一次收集前结束；跨年提交也归到同一次生日。 */
export function wishWindow(birthMs: number | null, year: number): { fromMs: number; toMs: number } {
  if (birthMs === null) return { fromMs: ymdToMs({ y: year, m: 1, d: 1 }), toMs: ymdToMs({ y: year + 1, m: 1, d: 1 }) };
  const birth = shanghaiYmd(birthMs);
  return {
    fromMs: ymdToMs(birthdayIn(year, birth)) - ASK_DAYS_BEFORE * DAY,
    toMs: ymdToMs(birthdayIn(year + 1, birth)) - ASK_DAYS_BEFORE * DAY,
  };
}

/** 今天或之前最近的一次生日，以及过去了几天 */
function lastBirthday(today: Ymd, birth: Ymd): { date: Ymd; daysSince: number } {
  let date = birthdayIn(today.y, birth);
  if (dayIndex(date) > dayIndex(today)) date = birthdayIn(today.y - 1, birth);
  return { date, daysSince: dayIndex(today) - dayIndex(date) };
}

/** 今天该做的事。已发年份 = 生日所在年份，所以重跑、跨年都不会重复；群卡片失败的话之后 2 天内补发。 */
export function dueActions(teachers: TeacherRow[], todayMs: number): DueAction[] {
  const today = shanghaiYmd(todayMs);
  const actions: DueAction[] = [];
  for (const teacher of teachers) {
    if (!teacher.active || teacher.birthMs === null) continue;
    const birth = shanghaiYmd(teacher.birthMs);
    const { date, daysLeft } = nextBirthday(today, birth);
    if (daysLeft <= ASK_DAYS_BEFORE && teacher.askedYear !== date.y) actions.push({ teacher, kind: "ask", date, daysLeft });
    const last = lastBirthday(today, birth);
    if (last.daysSince <= CELEBRATE_CATCH_UP_DAYS && teacher.celebratedYear !== last.date.y) {
      actions.push({ teacher, kind: "celebrate", date: last.date, daysLeft: -last.daysSince });
    }
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
