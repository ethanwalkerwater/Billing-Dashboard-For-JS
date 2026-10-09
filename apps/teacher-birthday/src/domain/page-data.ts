import type { LessonStats } from "./dates";

/** GET /birthday-api/page 的返回体；只放展示用字段。 */
export interface PageData {
  name: string;
  subject: string;
  photoUrl: string | null;
  year: number;
  tenure: { days: number; candles: number } | null;
  stats: LessonStats | null;
  blessing: string;
  wishes: Array<{ name: string; role: string; text: string; media: Array<{ url: string; kind: "image" | "video" }> }>;
}
