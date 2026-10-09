/** 生日祝福的全部流程。飞书 IO 通过 deps 注入，便于测试；云函数入口只负责组装 deps。 */
import { blessingMessages, chooseBlessing } from "../domain/blessing";
import { askCard, celebrateCard, wishFormUrl } from "../domain/cards";
import type { FeishuCard } from "../domain/cards";
import { dueActions, nextBirthday, shanghaiYmd, tenure } from "../domain/dates";
import type { DueAction, TeacherRow, Ymd } from "../domain/dates";
import type { PageData } from "../domain/page-data";
import { TEACHER_FIELDS as T, parseTeacher, parseWish } from "../domain/records";
import type { Wish } from "../domain/records";
import { scheduleStats } from "../domain/stats";
import { signPageToken, verifyPageToken } from "./token";

type RawRecord = { record_id: string; fields: Record<string, unknown> };

export interface BirthdayFeishu {
  listTeachers(): Promise<RawRecord[]>;
  getTeacher(recordId: string): Promise<RawRecord | null>;
  updateTeacher(recordId: string, fields: Record<string, unknown>): Promise<void>;
  listWishes(teacherName: string, year: number): Promise<RawRecord[]>;
  listLessons(scheduleName: string, todayMs: number): Promise<Array<{ fields: Record<string, unknown> }>>;
  tmpUrls(fileTokens: string[]): Promise<Map<string, string>>;
  /** to = "open_id:ou_…" 或 "chat_id:oc_…" */
  send(to: string, card: FeishuCard): Promise<void>;
}

export interface BirthdayConfig {
  teacherAppToken: string;
  teacherTableId: string;
  wishTableId: string;
  wishFormUrl: string;
  scheduleAppToken: string;
  scheduleTableId: string;
  academicOpenIds: string[];
  groupChatId: string;
  pageBaseUrl: string;
  pepper: string;
}

export interface BirthdayDeps {
  feishu: BirthdayFeishu;
  config: BirthdayConfig;
  now(): number;
  generate(messages: ReturnType<typeof blessingMessages>): Promise<string>;
}

const wishesOf = async (deps: BirthdayDeps, name: string, year: number): Promise<Wish[]> =>
  (await deps.feishu.listWishes(name, year)).map((r) => parseWish(r.fields)).filter((w): w is Wish => w !== null);

export function pageUrl(deps: BirthdayDeps, recordId: string, year: number): string {
  return `${deps.config.pageBaseUrl}?t=${encodeURIComponent(signPageToken(recordId, year, deps.config.pepper))}`;
}

async function sendAsk(deps: BirthdayDeps, teacher: TeacherRow, date: Ymd, daysLeft: number): Promise<string> {
  const formUrl = wishFormUrl(deps.config.wishFormUrl, teacher.name, date.y);
  const wishCount = (await wishesOf(deps, teacher.name, date.y)).length;
  for (const openId of deps.config.academicOpenIds) {
    await deps.feishu.send(`open_id:${openId}`, askCard({ teacherName: teacher.name, date, daysLeft, formUrl, wishCount }));
  }
  return formUrl;
}

/** 统计 + 寄语写回老师表（AI 失败只记日志，用模板兜底），然后发群卡片。 */
async function sendCelebrate(deps: BirthdayDeps, teacher: TeacherRow, year: number): Promise<string> {
  const todayMs = deps.now();
  const wishes = await wishesOf(deps, teacher.name, year);
  const stats = scheduleStats(await deps.feishu.listLessons(teacher.scheduleName, todayMs), todayMs);
  const fields: Record<string, unknown> = { [T.lessons]: stats.lessons, [T.students]: stats.students, [T.hours]: stats.hours };
  if (!teacher.handwritten) {
    try {
      const text = (
        await deps.generate(
          blessingMessages({
            name: teacher.name, subject: teacher.subject, teaching: teacher.teaching, intro: teacher.intro, stats,
            days: tenure(teacher.joinMs, todayMs)?.days ?? null, wishes: wishes.map((w) => w.text),
          }),
        )
      ).trim();
      if (text) fields[T.ai] = text;
    } catch (error) {
      console.error(`AI 寄语失败，使用模板：${teacher.name}`, error);
    }
  }
  await deps.feishu.updateTeacher(teacher.recordId, fields);
  const url = pageUrl(deps, teacher.recordId, year);
  await deps.feishu.send(`chat_id:${deps.config.groupChatId}`, celebrateCard({ teacherName: teacher.name, openId: teacher.openId, pageUrl: url, wishCount: wishes.length }));
  return url;
}

async function loadTeachers(deps: BirthdayDeps): Promise<TeacherRow[]> {
  return (await deps.feishu.listTeachers()).map(parseTeacher).filter((t) => t.name);
}

/** 每天 09:00。每个动作单独 try，一位老师失败不影响其他人；发送成功后才写已发年份。 */
export async function runDaily(deps: BirthdayDeps, todayMs = deps.now()) {
  const results: Array<{ teacher: string; kind: DueAction["kind"]; ok: boolean; error?: string }> = [];
  for (const action of dueActions(await loadTeachers(deps), todayMs)) {
    try {
      if (action.kind === "ask") {
        await sendAsk(deps, action.teacher, action.date, action.daysLeft);
        await deps.feishu.updateTeacher(action.teacher.recordId, { [T.asked]: action.date.y });
      } else {
        await sendCelebrate(deps, action.teacher, action.date.y);
        await deps.feishu.updateTeacher(action.teacher.recordId, { [T.celebrated]: action.date.y });
      }
      results.push({ teacher: action.teacher.name, kind: action.kind, ok: true });
    } catch (error) {
      console.error(error);
      results.push({ teacher: action.teacher.name, kind: action.kind, ok: false, error: String((error as Error).message ?? error) });
    }
  }
  return results;
}

/** 演练：不看日期、不写已发年份。年份 = 下一次生日所在年（没填生日用今年）。 */
export async function rehearse(deps: BirthdayDeps, teacherName: string, step: "ask" | "celebrate" | "all") {
  const teacher = (await loadTeachers(deps)).find((t) => t.name === teacherName);
  if (!teacher) throw new Error(`找不到老师：${teacherName}`);
  const today = shanghaiYmd(deps.now());
  const next = teacher.birthMs === null ? { date: today, daysLeft: 0 } : nextBirthday(today, shanghaiYmd(teacher.birthMs));
  const result: { formUrl?: string; pageUrl?: string } = {};
  if (step !== "celebrate") result.formUrl = await sendAsk(deps, teacher, next.date, next.daysLeft);
  if (step !== "ask") result.pageUrl = await sendCelebrate(deps, teacher, next.date.y);
  return result;
}

const mediaKind = (mime: string, name: string): "image" | "video" | null =>
  mime.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(name) ? "video" : mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(name) ? "image" : null;

export async function pageData(deps: BirthdayDeps, token: string): Promise<PageData | null> {
  const parsed = verifyPageToken(token, deps.config.pepper);
  if (!parsed) return null;
  const record = await deps.feishu.getTeacher(parsed.recordId);
  if (!record) return null;
  const teacher = parseTeacher(record);
  const wishes = await wishesOf(deps, teacher.name, parsed.year);
  const tokens = [teacher.photoToken, ...wishes.flatMap((w) => w.files.map((f) => f.token))].filter((t): t is string => Boolean(t));
  const urls = tokens.length ? await deps.feishu.tmpUrls(tokens) : new Map<string, string>();
  return {
    name: teacher.name,
    subject: teacher.subject,
    photoUrl: (teacher.photoToken && urls.get(teacher.photoToken)) || null,
    year: parsed.year,
    tenure: tenure(teacher.joinMs, deps.now()),
    stats: teacher.stats,
    blessing: chooseBlessing(teacher),
    wishes: wishes.map((w) => ({
      name: w.name,
      role: w.role,
      text: w.text,
      media: w.files.flatMap((f) => {
        const kind = mediaKind(f.mime, f.name);
        const url = urls.get(f.token);
        return kind && url ? [{ url, kind }] : [];
      }),
    })),
  };
}
