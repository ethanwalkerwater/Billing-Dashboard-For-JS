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

function card(title: string, template: string, lines: string[], scheduleUrl?: string): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: title } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.filter(Boolean).join("\n") } },
      ...(scheduleUrl ? [{
        tag: "action",
        actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: "查看本节课课表" }, url: scheduleUrl }],
      }] : []),
    ],
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
  const teacher = lesson.teacherName || "老师未填写";
  return card(`${teacher} · ${context.studentName} 的课程已取消`, "orange", [
    `**授课老师**：**${teacher}**`,
    `**学生**：${context.studentName}`,
    "**本节课已取消，无需按原安排上课。**",
    `**课程**：${lesson.courseName}`,
    `**时间**：${formatLessonTime(lesson)}`,
    `**收费**：${context.tier}（${context.tierText}）`,
    `**原因**：${REASON_TEXT[request.reason]}${request.note ? `，${request.note}` : ""}`,
    `**提交时间**：${formatDateTime(request.submittedMs)}`,
    "课表「临时取消」已自动填写，日历标题会同步显示请假。",
  ], lesson.scheduleUrl);
}

export function groupCancellationCard(context: CancellationContext & { teacherNotified: boolean }): FeishuCard {
  const { lesson, request } = context;
  const sick = request.reason === "sick";
  const teacher = lesson.teacherName || "老师未填写";
  return card(`${teacher} · ${context.studentName} 的课程已取消`, sick ? "yellow" : "blue", [
    `**授课老师**：**${teacher}**${lesson.teacherOpenId ? ` <at id=${lesson.teacherOpenId}></at>` : ""}`,
    `**学生**：${context.studentName}`,
    "**本节课已取消，无需按原安排上课。**",
    `**课程**：${lesson.courseName}`,
    `**时间**：${formatLessonTime(lesson)}`,
    `**收费**：${context.tier}（${context.tierText}）`,
    `**原因**：${REASON_TEXT[request.reason]}${request.note ? `，${request.note}` : ""}`,
    sick ? `**病假证明**：${request.hasSickProof ? "已上传，请到「取消申请」表核实" : "未上传，请跟进"}` : "",
    context.teacherNotified
      ? `${teacher} 已收到私聊通知。`
      : `⚠️ 没能私聊通知老师（${lesson.teacherOpenId ? "私聊发送失败" : "课表「老师-日历」没有对应飞书账号"}），请教务手动告知：${teacher}。`,
  ], lesson.scheduleUrl);
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
