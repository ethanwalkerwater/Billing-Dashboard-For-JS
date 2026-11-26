import { createHmac, timingSafeEqual } from "node:crypto";

import { isMonth, monthOfShanghai, shiftMonth } from "../domain/month";
import { PARENT_IDENTITY, STUDENT_IDENTITY } from "../domain/monthly-feedback";
import type { MonthlyFeedback } from "../domain/monthly-feedback";
import { buildPrefilledFormUrl } from "../domain/form-url";
import { parseFeedbackResponse } from "./feishu/parsers";
import type { FeishuRecord } from "./feishu/types";
import type { FeedbackTaskRow } from "../shared/rows";

const studentIdPattern = /^[A-Za-z0-9_-]{1,80}$/;

export function isMonthlyStudentId(value: unknown): value is string {
  return typeof value === "string" && studentIdPattern.test(value);
}

function monthlySignature(courseMonth: string, studentId: string, secret: string): string {
  return createHmac("sha256", secret).update("monthly-feedback:" + courseMonth + "." + studentId).digest("base64url");
}

/** 短链接用：2611.recXXXX.<16 位签名>（96 位，够防猜）。手机上链接短一些，二维码也更好扫。 */
export function monthlyLinkToken(courseMonth: string, studentId: string, secret: string): string {
  return courseMonth.slice(2, 4) + courseMonth.slice(5) + "." + studentId + "." + monthlySignature(courseMonth, studentId, secret).slice(0, 16);
}

/** 同时认新短格式和已经发出去的旧格式（2026-11.recXXXX.<43 位签名>）。 */
export function monthlyLinkScope(token: unknown, secret: string) {
  if (typeof token !== "string" || token.length > 132) return null;
  const [month, studentId, signature, extra] = token.split(".");
  const short = /^\d{4}$/.test(month ?? "");
  const courseMonth = short ? `20${month.slice(0, 2)}-${month.slice(2)}` : month;
  if (extra !== undefined || !isMonth(courseMonth) || !isMonthlyStudentId(studentId)
    || !(short ? /^[A-Za-z0-9_-]{16}$/ : /^[A-Za-z0-9_-]{43}$/).test(signature ?? "")) return null;
  const expected = monthlySignature(courseMonth, studentId, secret).slice(0, signature.length);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? { courseMonth, studentId } : null;
}

export type MonthlyTaskRow = Pick<FeedbackTaskRow, "task_id" | "student_name" | "teacher_canonical_name" | "course_names" |
  "course_month" | "collection_month" | "student_response_id" | "parent_response_id"> & { closed: boolean };

export function monthlyFeedback(rows: MonthlyTaskRow[], now = new Date(), formUrl?: string): MonthlyFeedback {
  const first = rows[0];
  return {
    courseMonth: first.course_month,
    studentName: first.student_name,
    closed: first.closed || monthOfShanghai(now.toISOString()) >= shiftMonth(first.course_month, 2),
    teachers: rows.map((row) => ({
      id: row.task_id,
      name: row.teacher_canonical_name,
      courses: row.course_names,
      studentDone: Boolean(row.student_response_id),
      parentDone: Boolean(row.parent_response_id),
      formUrl: formUrl ? buildPrefilledFormUrl({
        baseUrl: formUrl, hideNames: true, studentName: row.student_name,
        teacherName: row.teacher_canonical_name, courseMonth: row.course_month,
      }) : undefined,
    })),
  };
}

export function readMonthlyFeishuAnswer(task: MonthlyTaskRow, record: FeishuRecord) {
  try {
    const answer = parseFeedbackResponse(record);
    const [identity] = answer.identity;
    if (answer.studentNames[0] !== task.student_name || answer.teacherNames[0] !== task.teacher_canonical_name
      || answer.courseMonth !== task.course_month || answer.identity.length !== 1
      || (identity !== STUDENT_IDENTITY && identity !== PARENT_IDENTITY)) return null;
    return { ...answer, identity };
  } catch {
    return null;
  }
}
