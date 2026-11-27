/** 分享页的校验、编号和老师筛选。前后端共用，纯函数。 */

/** 数据库一行（PostgREST 原样返回） */
export interface ShareRow {
  code: string;
  title: string;
  intro: string;
  teachers: string[];
  active: boolean;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

/** 官网 /api/share-teachers 返回的一位老师 */
export interface SiteTeacher {
  name: string;
  pool: "名师" | "严选";
  subject: string;
  photo: string | null;
  degree: string;
  hours: string;
  courses: string;
  ielts: number | null;
}

export const LIMITS = { title: 30, intro: 400, teachers: 30, name: 40 } as const;
export const SHARE_CODE = /^[A-Za-z0-9]{8}$/;

export class InputError extends Error {}

export interface ShareInput {
  title: string;
  intro: string;
  teachers: string[];
}

/** 校验教务填的内容；不对就抛 InputError，文案直接给页面显示 */
export function parseShareInput(raw: { title?: unknown; intro?: unknown; teachers?: unknown }): ShareInput {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) throw new InputError("请填写标题");
  if ([...title].length > LIMITS.title) throw new InputError(`标题最多 ${LIMITS.title} 个字`);
  const intro = typeof raw.intro === "string" ? raw.intro.trim() : "";
  if ([...intro].length > LIMITS.intro) throw new InputError(`介绍最多 ${LIMITS.intro} 个字`);
  if (!Array.isArray(raw.teachers)) throw new InputError("请至少选一位老师");
  const teachers = [...new Set(raw.teachers.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean))];
  if (teachers.length === 0) throw new InputError("请至少选一位老师");
  if (teachers.length > LIMITS.teachers) throw new InputError(`一个分享页最多 ${LIMITS.teachers} 位老师`);
  if (teachers.some((t) => t.length > LIMITS.name)) throw new InputError("老师名字不对，请刷新后重选");
  return { title, intro, teachers };
}

const ALPHABET = "ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 8 位随机编号（去掉了 0/O、1/l 这类容易看错的字符）；random 要给 8 个 0–255 的随机字节 */
export function makeCode(random: Uint8Array): string {
  // 256 不是 57 的倍数，前几个字符概率略高一点，对「猜不出」没有影响
  return [...random.slice(0, 8)].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/** 后台筛老师用的课程标签 */
export const COURSE_TAGS = ["雅思", "托福", "IGCSE", "A-Level", "IB", "AP", "SAT", "竞赛"] as const;

/** 课程按「·」「/」「&」和空格拆开再比：AP 不会误中 EAP，「雅思全科」「竞赛物理」能中雅思、竞赛 */
export function hasCourseTag(courses: string, tag: string): boolean {
  const tokens = courses.split(/[\s·/&]+/).filter(Boolean);
  if (/^[\x00-\x7f]+$/.test(tag)) return tokens.some((t) => t.toLowerCase() === tag.toLowerCase());
  return tokens.some((t) => t.includes(tag));
}

export interface TeacherFilter {
  query: string;
  subject: string | null;
  tags: string[];
  pool: "名师" | "严选" | null;
}

/** 名字搜索 + 学科 + 课程标签（都要中）+ 名师/严选 */
export function filterTeachers(teachers: SiteTeacher[], f: TeacherFilter): SiteTeacher[] {
  const q = f.query.trim().toLowerCase();
  return teachers.filter(
    (t) =>
      (!q || t.name.toLowerCase().includes(q) || t.courses.toLowerCase().includes(q) || t.degree.toLowerCase().includes(q)) &&
      (!f.subject || t.subject === f.subject) &&
      (!f.pool || t.pool === f.pool) &&
      f.tags.every((tag) => hasCourseTag(t.courses, tag)),
  );
}

/** 分享页里已经不在官网上的老师（离职或改名）：官网页面上不会显示，后台提醒教务 */
export function missingTeachers(share: Pick<ShareRow, "teachers">, siteNames: ReadonlySet<string>): string[] {
  return share.teachers.filter((name) => !siteNames.has(name));
}

/** 官网要的字段：只给有效的分享页 */
export function toSiteShares(rows: ShareRow[]) {
  return rows.filter((r) => r.active).map(({ code, title, intro, teachers }) => ({ code, title, intro, teachers }));
}
