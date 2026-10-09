/** 飞书多维表格记录 → 领域对象。字段名是和教务的约定，不要改名。 */
import type { TeacherRow } from "./dates";

export const TEACHER_FIELDS = {
  name: "姓名", scheduleName: "课表名", gender: "性别", birth: "生日", join: "入职时间", phone: "手机", wechat: "微信",
  feishu: "飞书账号", subject: "主学科", education: "学历信息", intro: "个人介绍", teaching: "教学特点",
  courses: "可授课课程", photo: "照片", active: "在职", handwritten: "手写寄语", ai: "AI 寄语",
  lessons: "今年课节", students: "今年学生", hours: "今年课时", asked: "问卷已发年份", celebrated: "祝福已发年份",
} as const;

export const WISH_FIELDS = {
  teacher: "老师", year: "年份", name: "你的名字", role: "身份", text: "最想对 ta 说的话", files: "图片 / 表情包", hidden: "隐藏",
} as const;

export interface Wish { name: string; role: string; text: string; files: Array<{ token: string; name: string; mime: string }> }

/** 文本字段可能是字符串，也可能是 [{type:"text", text}] 段落数组 */
export function readText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : String(part))).join("").trim();
  return "";
}

const readNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const readFiles = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is { file_token: string; name?: string; type?: string } => Boolean(item && typeof item === "object" && "file_token" in item))
        .map((item) => ({ token: item.file_token, name: item.name ?? "", mime: item.type ?? "" }))
    : [];

export function parseTeacher(record: { record_id: string; fields: Record<string, unknown> }): TeacherRow {
  const f = record.fields;
  const F = TEACHER_FIELDS;
  const name = readText(f[F.name]);
  const person = Array.isArray(f[F.feishu]) ? (f[F.feishu] as Array<{ id?: string }>)[0] : undefined;
  const lessons = readNumber(f[F.lessons]);
  return {
    recordId: record.record_id,
    name,
    scheduleName: readText(f[F.scheduleName]) || name,
    subject: readText(f[F.subject]),
    birthMs: readNumber(f[F.birth]),
    joinMs: readNumber(f[F.join]),
    active: f[F.active] === true,
    openId: person?.id ?? null,
    askedYear: readNumber(f[F.asked]),
    celebratedYear: readNumber(f[F.celebrated]),
    handwritten: readText(f[F.handwritten]),
    aiBlessing: readText(f[F.ai]),
    teaching: readText(f[F.teaching]),
    intro: readText(f[F.intro]),
    photoToken: readFiles(f[F.photo])[0]?.token ?? null,
    stats: lessons === null ? null : { lessons, students: readNumber(f[F.students]) ?? 0, hours: readNumber(f[F.hours]) ?? 0 },
  };
}

export function parseWish(fields: Record<string, unknown>): Wish | null {
  const W = WISH_FIELDS;
  const text = readText(fields[W.text]);
  if (fields[W.hidden] === true || !text) return null;
  return { name: readText(fields[W.name]) || "匿名", role: readText(fields[W.role]), text, files: readFiles(fields[W.files]) };
}
