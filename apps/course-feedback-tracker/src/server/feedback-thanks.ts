import type { createServiceDb } from "../../functions/feedback-api/service-db";

export interface ThanksRequest {
  taskId?: unknown;
  giftId?: unknown;
  note?: unknown;
  expectedValue?: unknown;
  expectedLabel?: unknown;
}
type ThanksDb = Pick<ReturnType<typeof createServiceDb>, "rpc">;
interface Gift {
  id: string;
  label: string;
  description: string;
  value: number;
  photo: string | null;
  enabled: boolean;
}

export async function thanksOptions(db: ThanksDb, taskId: string) {
  const result = await db.rpc<Gift>("feedback_thanks_options", { p_task_id: taskId });
  if (result.error) throw new Error("读取感谢礼失败");
  return { gifts: result.data ?? [] };
}

export async function submitThanks(db: ThanksDb, scope: { courseMonth: string; studentId: string }, input: ThanksRequest) {
  const { taskId, giftId, note, expectedLabel, expectedValue } = input;
  if (typeof taskId !== "string" || !taskId || taskId.length > 1024 ||
      typeof giftId !== "string" || !giftId || giftId.length > 80 ||
      typeof note !== "string" || !note.trim() || [...note.trim()].length > 200 ||
      typeof expectedLabel !== "string" || !expectedLabel || expectedLabel.length > 80 ||
      typeof expectedValue !== "number" || !Number.isFinite(expectedValue) || expectedValue < 0 || expectedValue > 9999) {
    return { status: 400, body: { error: "请选择礼物，并填写 200 字以内的感谢语。" } };
  }
  const result = await db.rpc<{ done: boolean }>("submit_feedback_thanks", {
    p_month: scope.courseMonth, p_student_id: scope.studentId, p_task_id: taskId,
    p_gift_id: giftId, p_note: note.trim(), p_expected_label: expectedLabel, p_expected_value: expectedValue,
  });
  if (!result.error && result.data?.[0]?.done) return { status: 200, body: { ok: true } };
  switch (result.error?.message) {
    case "THANKS_NOT_ELIGIBLE": return { status: 409, body: { error: "这条评价暂时不能送出感谢礼，请确认反馈进度。" } };
    case "THANKS_GIFT_CHANGED": return { status: 409, body: {
      error: "礼物设置已更新，请重新选择。", thanks: await thanksOptions(db, taskId),
    } };
    case "THANKS_INVALID": return { status: 400, body: { error: "请检查所选礼物和感谢语。" } };
    default: throw new Error("登记感谢礼失败");
  }
}
