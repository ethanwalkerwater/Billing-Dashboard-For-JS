import type { PostgrestLike, PostgrestResult } from "../shared/rdb";

export type Status = "pending" | "done";
export interface ThanksRecord {
  task_id: string;
  course_month: string;
  student_name: string;
  teacher_name: string;
  gift_label: string;
  gift_value: number;
  note: string;
  status: Status;
  created_at: string;
}
export interface Gift {
  id: string;
  label: string;
  description: string;
  value: number;
  photo: string | null;
  enabled: boolean;
  sort_order: number;
}

const recordTable = "feedback_thanks_records";
const giftTable = "feedback_thanks_gifts";
const giftColumns = "id,label,description,value,photo,enabled,sort_order";
const recordColumns = "task_id,course_month,student_name,teacher_name,gift_label,gift_value,note,status,created_at";

function rows<T>(result: PostgrestResult<T>): T[] {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export async function loadRecords(db: PostgrestLike, month: string) {
  const records: ThanksRecord[] = [];
  const pageSize = 500;
  for (;;) {
    let query = db.from(recordTable).select<ThanksRecord>(recordColumns)
      .eq("course_month", month).order("task_id", { ascending: false }).limit(pageSize);
    if (records.length) query = query.lt("task_id", records[records.length - 1].task_id);
    const page = rows(await query);
    records.push(...page);
    if (page.length < pageSize) break;
  }
  return records.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export async function loadGifts(db: PostgrestLike) {
  return rows(await db.from(giftTable).select<Gift>(giftColumns).order("sort_order"));
}

// 浏览器 PostgREST 支持 PATCH 后 select；实际返回的行才能证明 RLS 放行了修改。
function returning<T>(update: PromiseLike<PostgrestResult<unknown>>, columns: string) {
  return (update as unknown as { select(columns: string): PromiseLike<PostgrestResult<T>> }).select(columns);
}

export async function updateStatuses(db: PostgrestLike, month: string, ids: string[], status: Status) {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const update = db.from(recordTable).update({ status }).eq("course_month", month).in("task_id", chunk);
    const saved = rows(await returning<{ task_id: string }>(update, "task_id"));
    if (saved.length !== chunk.length) throw new Error("部分记录已变更，或当前账号没有处理权限。");
  }
}

export async function saveGift(db: PostgrestLike, id: string, changes: Partial<Omit<Gift, "id" | "sort_order">>) {
  const update = db.from(giftTable).update(changes).eq("id", id);
  const [gift] = rows(await returning<Gift>(update, giftColumns));
  if (!gift) throw new Error("礼物已变更，或当前账号没有设置权限。");
  return gift;
}

export const money = (value: number) => "¥" + new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
export const countValue = (records: ThanksRecord[]) => records.reduce((sum, row) => sum + Math.round(Number(row.gift_value) * 100), 0) / 100;
export const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试。";
export const giftPhoto = (gift: Pick<Gift, "id" | "photo">) => gift.photo || "/feedback/thanks/" + encodeURIComponent(gift.id) + ".webp";

export async function resizePhoto(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error("请选择 5 MB 以内的 JPG、PNG 或 WebP 图片。");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error("图片无法读取，请重新选择。"); });
    const scale = Math.min(1, 384 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器无法处理图片。");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const photo = canvas.toDataURL("image/webp", quality);
      if (photo.startsWith("data:image/webp;base64,") && photo.length <= 160_000) return photo;
    }
    throw new Error("图片压缩失败，请更换较小的图片或浏览器。");
  } finally {
    URL.revokeObjectURL(url);
  }
}
