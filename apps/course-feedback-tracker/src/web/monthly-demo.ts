import { PARENT_IDENTITY, STUDENT_IDENTITY } from "../domain/monthly-feedback";
import type { MonthlyFeedback } from "../domain/monthly-feedback";
import { answerFields } from "../server/monthly-answer";
import type { ThanksGift } from "./FeedbackThanksDialog";

/** 教务体验版（app.jsjy.asia/m/#demo）：同一个学生页，答案只存在这台设备上，不写飞书、不进感谢礼后台。 */
export const DEMO_TOKEN = "demo";
const KEY = "feedback.demo.state";

const gifts: ThanksGift[] = [
  { id: "coffee", label: "请老师喝一杯", description: "辛苦了，放松一下", value: 35 },
  { id: "flowers", label: "送老师一束花", description: "感谢您的用心", value: 45 },
  { id: "cake", label: "给老师一点甜", description: "谢谢您的耐心陪伴", value: 40 },
  { id: "pennant", label: "为老师送上荣誉", description: "感谢您的专业指导", value: 50 },
].map((gift) => ({ ...gift, enabled: true, photo: null }));

type DemoState = { feedback: MonthlyFeedback; thanked: string[] };

function fresh(): DemoState {
  const courseMonth = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  return { thanked: [], feedback: { courseMonth, studentName: "小禾", closed: false, teachers: [
    { id: "demo-chen", name: "陈老师", courses: ["小学数学", "奥数思维"], studentDone: false, parentDone: false },
    { id: "demo-xu", name: "许老师", courses: ["英语阅读"], studentDone: false, parentDone: false },
    { id: "demo-zhou", name: "周老师", courses: ["语文"], studentDone: false, parentDone: true },
  ] } };
}

function load(): DemoState {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") ?? fresh(); } catch { return fresh(); }
}
function save(state: DemoState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Private mode: the demo still works for this visit. */ }
}

export function resetDemo() {
  try { Object.keys(localStorage).filter((key) => key.startsWith("feedback.demo.")).forEach((key) => localStorage.removeItem(key)); } catch { /* ignore */ }
}

export async function demoRequest(body: Record<string, unknown>): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const state = load();
  const { feedback } = state;
  if (body.taskId === undefined) { save(state); return feedback; }
  const teacher = feedback.teachers.find((entry) => entry.id === body.taskId);
  if (!teacher) throw new Error("老师名单已更新，请重新打开链接。");
  if (body.action === "thanks") {
    state.thanked.push(teacher.id);
    save(state);
    return { ok: true };
  }
  const built = answerFields({ student_name: feedback.studentName, teacher_canonical_name: teacher.name, course_month: feedback.courseMonth },
    body.identity, body.answers);
  if ("error" in built) throw new Error(built.error);
  if (body.identity === STUDENT_IDENTITY) teacher.studentDone = true;
  if (body.identity === PARENT_IDENTITY) teacher.parentDone = true;
  save(state);
  return { ...feedback, thanks: { gifts: state.thanked.includes(teacher.id) ? [] : gifts } };
}
