const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface MonthRange {
  month: string;
  startInclusive: string;
  endExclusive: string;
}

export function assertMonth(value: string): void {
  if (!MONTH_PATTERN.test(value)) {
    throw new Error(`月份格式无效：${value}，应为 YYYY-MM`);
  }
}

export function shiftMonth(month: string, offset: number): string {
  assertMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function collectionMonthToCourseMonth(collectionMonth: string): string {
  return shiftMonth(collectionMonth, -1);
}

export function courseMonthToCollectionMonth(courseMonth: string): string {
  return shiftMonth(courseMonth, 1);
}

export function monthRangeInShanghai(month: string): MonthRange {
  assertMonth(month);
  return {
    month,
    startInclusive: `${month}-01T00:00:00+08:00`,
    endExclusive: `${shiftMonth(month, 1)}-01T00:00:00+08:00`,
  };
}

const SHANGHAI_MONTH = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
});

/** 某个时间点落在上海时区的哪个月份。答卷按提交时间归属收集月份。 */
export function monthOfShanghai(isoDateTime: string): string {
  const time = new Date(isoDateTime);
  if (Number.isNaN(time.getTime())) throw new Error(`时间格式无效：${isoDateTime}`);
  return SHANGHAI_MONTH.format(time).slice(0, 7);
}

export function isWithinMonthInShanghai(isoDateTime: string, month: string): boolean {
  const range = monthRangeInShanghai(month);
  const time = new Date(isoDateTime).getTime();
  return time >= new Date(range.startInclusive).getTime() && time < new Date(range.endExclusive).getTime();
}
