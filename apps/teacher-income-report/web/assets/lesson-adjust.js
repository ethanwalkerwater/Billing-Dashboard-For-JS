// 老师收入页「改课程单价后重算金额」：比例全部来自 billing-core 的 chargeRate / parse*Rate，这里不另写比例表。
import { NORMAL_STATUS, cleanText, parseCancellationRate, parseDiscountRate, parseNumber } from "./report-core.js";
import { lessonAmountFromUnitPrice } from "./income-calculations.js";

const round = (value) => lessonAmountFromUnitPrice(value, 1);

export const UNKNOWN_RATE_NOTE = "含未知优惠/取消标记，按原比例重算";

// 收费比例已知 → 新单价 × 时长 × 比例；未知（null）→ 不能当 0：按原金额占「原单价 × 时长」的比例重算，算不出就保留原金额
function amountAtUnitPrice(unitPrice, duration, chargeRate, originalUnitPrice, originalAmount) {
  if (chargeRate != null) return lessonAmountFromUnitPrice(unitPrice, duration, chargeRate);
  const base = (originalUnitPrice || 0) * (duration || 0);
  return base > 0 ? lessonAmountFromUnitPrice(unitPrice, duration, (originalAmount || 0) / base) : round(originalAmount || 0);
}

export function lessonAdjustmentKey(month, teacher, group) {
  // 没有优惠时 statusLabel === cancellationStatus，旧 key 不变
  return JSON.stringify([month, teacher, group.counterparty, group.courseType, group.teachingType, group.statusLabel ?? group.cancellationStatus]);
}

export function groupHasUnknownRate(records) {
  return records.some((record) => record.chargeRate == null);
}

export function defaultGroupUnitPrice(group, records) {
  if (group.unitPrices?.length === 1) return String(group.unitPrices[0]);
  if (groupHasUnknownRate(records)) return "";
  const weightedDuration = records.reduce((total, record) => total + (record.duration || 0) * record.chargeRate, 0);
  // 全是 0 元优惠课时加权时长为 0，留空而不是显示 0 / NaN
  return weightedDuration ? String(round((group.amount || 0) / weightedDuration)) : "";
}

// 单价没改（等于默认单价）→ 保留原金额，不重算：原金额以飞书为准，可能和规则算出来的不一样
export function adjustedGroupAmount(group, records, unitPrice) {
  const numericUnitPrice = parseNumber(unitPrice);
  if (numericUnitPrice == null || numericUnitPrice === parseNumber(defaultGroupUnitPrice(group, records))) return round(group.amount || 0);
  if (!records.length) return round(numericUnitPrice * (group.duration || 0));
  return round(records.reduce((total, record) => (
    total + amountAtUnitPrice(numericUnitPrice, record.duration, record.chargeRate, record.unitPrice, record.amount)
  ), 0));
}

// 上传「课时收费报表」导出 CSV 的逐行路径：比例 = 「取消/上课状态」× 「价格优惠」× 手填「折扣（%）」（旧 CSV 没有的列按 1）
export function lessonRowChargeRate(entry) {
  const cancellation = cleanText(entry.source?.["取消/上课状态"]);
  const discount = cleanText(entry.source?.["价格优惠"]);
  const manual = cleanText(entry.source?.["折扣（%）"]);
  const cancelRate = !cancellation || cancellation === NORMAL_STATUS ? 1 : parseCancellationRate(cancellation);
  const discountRate = discount ? parseDiscountRate(discount) : 1;
  const manualPercent = manual ? parseNumber(manual) : 100;
  return cancelRate == null || discountRate == null || manualPercent == null ? null : cancelRate * discountRate * manualPercent / 100;
}

export function lessonRowHasUnknownRate(entry) {
  return lessonRowChargeRate(entry) == null;
}

function sourceUnitPrice(entry) {
  const source = entry.source || {};
  return parseNumber(source["课程单价"] ?? source["单价"] ?? source["课程单价（¥）"]);
}

export function defaultLessonRowUnitPrice(entry) {
  const sourcePrice = sourceUnitPrice(entry);
  if (sourcePrice != null) return String(sourcePrice);
  const rate = lessonRowChargeRate(entry);
  const weightedDuration = (entry.duration || 0) * (rate ?? 1);
  return weightedDuration ? String(round((entry.amount || 0) / weightedDuration)) : "";
}

export function adjustedLessonRowAmount(entry, unitPrice) {
  const numericUnitPrice = parseNumber(unitPrice);
  if (numericUnitPrice == null || numericUnitPrice === parseNumber(defaultLessonRowUnitPrice(entry))) return round(entry.amount || 0);
  return amountAtUnitPrice(numericUnitPrice, entry.duration, lessonRowChargeRate(entry), sourceUnitPrice(entry), entry.amount);
}
