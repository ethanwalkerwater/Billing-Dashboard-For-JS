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
  /** 课时以外的固定收入（如管理费），从预警线里扣掉，课时费要覆盖的就少这么多 */
  extraIncome: number | null;
  /** 教务想看的另一个系数；不填则自定义三列为空 */
  customRate: number | null;
  note: string;
}

export interface Rates {
  min: number;
  max: number;
  /**
   * 预警线 = 基础薪水 × 底薪倍数。和「老师收入详情」的底薪扣减系数一致（Bonus = … − 基础薪水 × 1.2），
   * 课时费要覆盖底薪的 1.2 倍才算达到公司目标；基础薪水本身按收入详情的原值填，不要把 1.2 乘进去。
   */
  baseMultiplier: number;
}

export const DEFAULT_RATES: Rates = { min: 0.47, max: 0.62, baseMultiplier: 1.2 };

export type AlertStatus = "alert" | "between" | "reached" | "no-base";

export const STATUS_LABELS: Record<AlertStatus, string> = {
  alert: "预警",
  between: "区间内",
  reached: "已达标",
  "no-base": "无底薪",
};

export interface Evaluation {
  status: AlertStatus;
  /** 预警线 = 基础薪水 × 底薪倍数 − 额外收入；没底薪为 null */
  alertLine: number | null;
  predictedMin: number;
  predictedMax: number;
  /** 预测最高 − 预警线。正数已越过预警线，负数还差这么多 */
  marginToAlert: number | null;
  /** 预测最低 − 预警线。正数已达标，负数还差这么多 */
  marginToTarget: number | null;
  unitPrice: number | null;
  /** 脱离预警还要上多少小时课：|marginToAlert| ÷ (单价 × 最高系数)；已越线为 0 */
  hoursToAlert: number | null;
  /** 达标还要上多少小时课：|marginToTarget| ÷ (单价 × 最低系数)；已达标为 0 */
  hoursToTarget: number | null;
  /** 课时费 × 自定义系数；没填自定义系数为 null */
  predictedCustom: number | null;
  /** 课时费 × 自定义系数 − 预警线；没填自定义系数或没底薪为 null */
  marginCustom: number | null;
  /** |marginCustom| ÷ (单价 × 自定义系数)；已越线为 0 */
  hoursCustom: number | null;
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
  // search 接口里公式列（课程时长、课程总价格）返回 {type: 2, value: [359]}
  if (value && typeof value === "object" && Array.isArray((value as { value?: unknown }).value)) {
    return readNumber((value as { value: unknown[] }).value[0]);
  }
  return null;
}

/** 同步只需要这几列；全表 30 多列（会议信息、日历 ID…）每页都拖慢接口。 */
export const SCHEDULE_FIELDS = ["老师", "学生", "上课时间", "课程单价", "课程时长", "课程总价格"];

/**
 * 「查询记录」接口按上课时间过滤当月。飞书的 ExactDate 只精确到天（实测 isGreater 9/1 会带出 8/31 的课），
 * 所以前后各放宽一天取一个超集，精确到毫秒的月份边界仍由 aggregateSchedule 判断。
 */
export function monthSearchFilter(month: string) {
  const [start, end] = monthRangeMs(month);
  const day = 24 * 3600_000;
  return {
    conjunction: "and" as const,
    conditions: [
      { field_name: "上课时间", operator: "isGreater", value: ["ExactDate", String(start - 2 * day)] },
      { field_name: "上课时间", operator: "isLess", value: ["ExactDate", String(end + day)] },
    ],
  };
}

/**
 * 学生关联字段两种形状：list 接口带显示文本 [{text: "张海錤 Linda-3777", record_ids}]；
 * search 接口只有 {link_record_ids: [...]}，要用学生表的 记录 ID → 显示文本 对照补名字。
 */
function readStudentNames(value: unknown, studentNames?: ReadonlyMap<string, string>): string[] {
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? String((item as { text?: unknown }).text ?? "") : ""));
  const ids = value && typeof value === "object" ? (value as { link_record_ids?: unknown }).link_record_ids : undefined;
  return Array.isArray(ids) ? ids.map((id) => studentNames?.get(String(id)) ?? "") : [];
}

/**
 * 只保留计费课：没有课程单价的记录是老师日历里的会议、自习、备课之类的占位（实测 9 月 1392 行里 400 多行，
 * 有的长达 23 小时），不算课时、不算学生。另有个别记录下课时间早于上课时间，时长为负，一并丢掉。
 */
export function parseScheduleRow(fields: Record<string, unknown>, studentNames?: ReadonlyMap<string, string>): ScheduleRow | null {
  const teacher = typeof fields["老师"] === "string" ? fields["老师"].trim() : "";
  const startsAt = fields["上课时间"];
  const unitPrice = readNumber(fields["课程单价"]);
  const hours = readNumber(fields["课程时长"]) ?? 0;
  if (!teacher || typeof startsAt !== "number" || !unitPrice || hours <= 0) return null;
  return {
    teacher,
    studentName: readStudentNames(fields["学生"], studentNames).map(cleanStudentName).filter(Boolean).join("、"),
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
  const custom = settings.customRate;
  const predictedCustom = custom ? round2(lessonFee * custom) : null;
  if (settings.baseSalary == null) {
    return { status: "no-base", alertLine: null, predictedMin, predictedMax, marginToAlert: null, marginToTarget: null, unitPrice, hoursToAlert: null, hoursToTarget: null, predictedCustom, marginCustom: null, hoursCustom: null };
  }
  // 额外收入和收入详情里一样进 Bonus，抵扣「基础薪水 × 1.2」：底薪 30000、额外 10000、倍数 1 时课时费 × 系数只要够 20000
  const line = round2(settings.baseSalary * rates.baseMultiplier - (settings.extraIncome ?? 0));
  const marginToAlert = round2(predictedMax - line);
  const marginToTarget = round2(predictedMin - line);
  const hours = (margin: number, rate: number) =>
    margin >= 0 ? 0 : unitPrice ? Math.ceil((-margin / (unitPrice * rate)) * 10) / 10 : null;
  const marginCustom = predictedCustom == null ? null : round2(predictedCustom - line);
  return {
    status: predictedMax < line ? "alert" : predictedMin > line ? "reached" : "between",
    alertLine: line,
    predictedMin,
    predictedMax,
    marginToAlert,
    marginToTarget,
    unitPrice,
    hoursToAlert: hours(marginToAlert, rates.max),
    hoursToTarget: hours(marginToTarget, rates.min),
    predictedCustom,
    marginCustom,
    hoursCustom: custom && marginCustom != null ? hours(marginCustom, custom) : null,
  };
}
