/** 取消课程的飞书卡片消息（老师私聊 + 教务群）。 */
import type { CancellableLesson, CancellationReason, CancellationTier } from "./rules";

export type FeishuCard = Record<string, unknown>;

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function shanghaiParts(ms: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: `${parts.month}/${parts.day}`, weekday: WEEKDAYS[weekdayIndex], time: `${parts.hour}:${parts.minute}` };
}

/** 例：10/08（周三）19:30-21:30 */
export function formatLessonTime(lesson: Pick<CancellableLesson, "startMs" | "endMs">): string {
  const start = shanghaiParts(lesson.startMs);
  const end = shanghaiParts(lesson.endMs);
  return `${start.date}（${start.weekday}）${start.time}-${end.time}`;
}

export function formatDateTime(ms: number): string {
  const parts = shanghaiParts(ms);
  return `${parts.date} ${parts.time}`;
}

const REASON_TEXT: Record<CancellationReason, string> = { personal: "个人原因", sick: "病假" };

function card(title: string, template: string, lines: string[]): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: title } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: lines.filter(Boolean).join("\n") } }],
  };
}

interface CancellationContext {
  studentName: string;
  lesson: CancellableLesson;
  tier: CancellationTier;
  tierText: string;
  request: { reason: CancellationReason; note: string; submittedMs: number; hasSickProof: boolean };
}

export function teacherCancellationCard(context: CancellationContext): FeishuCard {
  const { lesson, request } = context;
  return card(`${context.studentName} 取消了一节课`, "orange", [
    `**课程**：${lesson.courseName}`,
    `**时间**：${formatLessonTime(lesson)}`,
    `**收费**：${context.tier}（${context.tierText}）`,
    `**原因**：${REASON_TEXT[request.reason]}${request.note ? `，${request.note}` : ""}`,
    `**提交时间**：${formatDateTime(request.submittedMs)}`,
    "课表「临时取消」已自动填写，日历标题会同步显示请假。",
  ]);
}

export function groupCancellationCard(context: CancellationContext & { teacherNotified: boolean }): FeishuCard {
  const { lesson, request } = context;
  const sick = request.reason === "sick";
  return card(`取消课程 · ${context.studentName}`, sick ? "yellow" : "blue", [
    `**课程**：${lesson.courseName} · ${lesson.teacherName}`,
    `**时间**：${formatLessonTime(lesson)}`,
    `**收费**：${context.tier}（${context.tierText}）`,
    `**原因**：${REASON_TEXT[request.reason]}${request.note ? `，${request.note}` : ""}`,
    sick ? `**病假证明**：${request.hasSickProof ? "已上传，请到「取消申请」表核实" : "未上传，请跟进"}` : "",
    context.teacherNotified ? "老师已收到私聊通知。" : "⚠️ 没能私聊通知老师（课表「老师-日历」没有对应飞书账号），请手动告知老师。",
  ]);
}

export function groupAlertCard(input: {
  message: string;
  studentName?: string;
  lesson?: CancellableLesson;
  requestRecordId: string;
}): FeishuCard {
  return card("取消课程异常，需要人工处理", "red", [
    `**问题**：${input.message}`,
    input.studentName ? `**学生**：${input.studentName}` : "",
    input.lesson ? `**课程**：${input.lesson.courseName} · ${input.lesson.teacherName} · ${formatLessonTime(input.lesson)}` : "",
    `**申请记录**：${input.requestRecordId}`,
    "课表没有被修改。",
  ]);
}
