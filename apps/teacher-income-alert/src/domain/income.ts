/**
 * 教师薪资预警的全部计算。纯函数，前后端共用，云函数里跑 aggregateSchedule，浏览器里跑 evaluateTeacher。
 */

/** 飞书课表一条记录里本系统关心的字段（已按 v1 records 接口的真实形状读取）。 */
export interface ScheduleRow {
  teacher: string;
  studentName: string;
  startsAt: number;
  unitPrice: number | null;
  hours: number;
  /** 「课程总价格」公式列已含临时取消折扣，直接汇总即课时费 */
  amount: number;
}

/** 某老师某月的课表汇总；存 income_teacher_months */
export interface TeacherMonth {
  teacher: string;
  lessonFee: number;
  lessons: number;
  hours: number;
  students: string[];
  /** 当月每小时平均课时费（课时费 ÷ 小时数），教务没手填单价时用它算还差几小时 */
  unitPriceAuto: number | null;
}

export interface TeacherSettings {
  baseSalary: number | null;
  unitPrice: number | null;
  note: string;
}

export interface Rates {
  min: number;
  max: number;
}

export const DEFAULT_RATES: Rates = { min: 0.47, max: 0.62 };

export type AlertStatus = "alert" | "between" | "reached" | "no-base";

export const STATUS_LABELS: Record<AlertStatus, string> = {
  alert: "预警",
  between: "区间内",
  reached: "已达标",
  "no-base": "无底薪",
};

export interface Evaluation {
  status: AlertStatus;
  predictedMin: number;
  predictedMax: number;
  /** 预测最高 − 基础薪水。正数已越过预警线，负数还差这么多 */
  marginToAlert: number | null;
  /** 预测最低 − 基础薪水。正数已达标，负数还差这么多 */
  marginToTarget: number | null;
  unitPrice: number | null;
  /** 脱离预警还要上多少小时课：|marginToAlert| ÷ (单价 × 最高系数)；已越线为 0 */
  hoursToAlert: number | null;
  /** 达标还要上多少小时课：|marginToTarget| ÷ (单价 × 最低系数)；已达标为 0 */
  hoursToTarget: number | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function monthRangeMs(month: string): [number, number] {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) throw new Error(`月份格式无效：${month}`);
  // 上海时区固定 UTC+8，不用 Intl 反查
  const offset = 8 * 3600_000;
  return [Date.UTC(year, monthNumber - 1, 1) - offset, Date.UTC(year, monthNumber, 1) - offset];
}

/** 学生关联字段的 text 形如「张海錤 Linda-3777」，尾巴是学生表的编号（有些学生编号为空只剩「-」），展示时去掉。 */
export function cleanStudentName(text: string): string {
  return text.replace(/-\d*$/, "").trim();
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,¥￥\s]/g, ""));
    return Number.isFinite(parsed) && value.trim() ? parsed : null;
  }
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "text" in value[0]) {
    return readNumber((value[0] as { text: unknown }).text);
  }
  return null;
}

/**
 * 只保留计费课：没有课程单价的记录是老师日历里的会议、自习、备课之类的占位（实测 9 月 1392 行里 400 多行，
 * 有的长达 23 小时），不算课时、不算学生。另有个别记录下课时间早于上课时间，时长为负，一并丢掉。
 */
export function parseScheduleRow(fields: Record<string, unknown>): ScheduleRow | null {
  const teacher = typeof fields["老师"] === "string" ? fields["老师"].trim() : "";
  const startsAt = fields["上课时间"];
  const unitPrice = readNumber(fields["课程单价"]);
  const hours = readNumber(fields["课程时长"]) ?? 0;
  if (!teacher || typeof startsAt !== "number" || !unitPrice || hours <= 0) return null;
  const students = Array.isArray(fields["学生"]) ? (fields["学生"] as Array<{ text?: string }>) : [];
  return {
    teacher,
    studentName: students.map((item) => cleanStudentName(item.text ?? "")).filter(Boolean).join("、"),
    startsAt,
    unitPrice,
    hours,
    amount: readNumber(fields["课程总价格"]) ?? 0,
  };
}

/** 把整张课表按月份切出来，按老师汇总。 */
export function aggregateSchedule(rows: Array<ScheduleRow | null>, month: string): TeacherMonth[] {
  const [start, end] = monthRangeMs(month);
  const byTeacher = new Map<string, TeacherMonth>();
  for (const row of rows) {
    if (!row || row.startsAt < start || row.startsAt >= end) continue;
    const entry =
      byTeacher.get(row.teacher) ?? { teacher: row.teacher, lessonFee: 0, lessons: 0, hours: 0, students: [] as string[], unitPriceAuto: null };
    entry.lessonFee += row.amount;
    entry.lessons += 1;
    entry.hours += row.hours;
    // 一节课可能挂多个学生（刷题班），拆开各记一个
    for (const name of row.studentName.split("、")) if (name && !entry.students.includes(name)) entry.students.push(name);
    byTeacher.set(row.teacher, entry);
  }
  return [...byTeacher.values()]
    .map((entry) => ({
      ...entry,
      lessonFee: round2(entry.lessonFee),
      hours: round2(entry.hours),
      students: [...entry.students].sort((a, b) => a.localeCompare(b, "zh-CN")),
      // 用均价而不是最常见的单价：同一位老师 1v1 是 1000、刷题班是 350，取众数会把差距换算成离谱的小时数
      unitPriceAuto: entry.hours > 0 ? Math.round(entry.lessonFee / entry.hours) : null,
    }))
    .sort((a, b) => a.teacher.localeCompare(b.teacher, "zh-CN"));
}

export function evaluateTeacher(input: {
  lessonFee: number;
  unitPriceAuto: number | null;
  settings: TeacherSettings;
  rates: Rates;
}): Evaluation {
  const { lessonFee, settings, rates } = input;
  const predictedMin = round2(lessonFee * rates.min);
  const predictedMax = round2(lessonFee * rates.max);
  const unitPrice = settings.unitPrice ?? input.unitPriceAuto;
  const base = settings.baseSalary;
  if (base == null) {
    return { status: "no-base", predictedMin, predictedMax, marginToAlert: null, marginToTarget: null, unitPrice, hoursToAlert: null, hoursToTarget: null };
  }
  const marginToAlert = round2(predictedMax - base);
  const marginToTarget = round2(predictedMin - base);
  const hours = (margin: number, rate: number) =>
    margin >= 0 ? 0 : unitPrice ? Math.ceil((-margin / (unitPrice * rate)) * 10) / 10 : null;
  return {
    status: predictedMax < base ? "alert" : predictedMin > base ? "reached" : "between",
    predictedMin,
    predictedMax,
    marginToAlert,
    marginToTarget,
    unitPrice,
    hoursToAlert: hours(marginToAlert, rates.max),
    hoursToTarget: hours(marginToTarget, rates.min),
  };
}
