import { monthlyTaskKey, uniqueStudentMonths } from "../domain/monthly-feedback";
import type { StoredFeedbackTask } from "../server/tasks/types";
import { callFeedbackApi } from "./cloudbase";

export type StudentMonth = Pick<StoredFeedbackTask, "courseMonth" | "studentName" | "studentRecordId">;
export type MonthlyLinks = Record<string, string>;

const issued = new Map<string, Promise<string>>();
const siteOrigin = import.meta.env.DEV ? window.location.origin : "https://app.jsjy.asia";

export async function loadMonthlyLinks(tasks: readonly StudentMonth[]): Promise<MonthlyLinks> {
  const unique = uniqueStudentMonths(tasks);
  if (unique.length === 0) return {};
  const missingByMonth = new Map<string, StudentMonth[]>();
  for (const task of unique) {
    if (issued.has(monthlyTaskKey(task))) continue;
    const list = missingByMonth.get(task.courseMonth) ?? [];
    list.push(task);
    missingByMonth.set(task.courseMonth, list);
  }
  for (const [courseMonth, missing] of missingByMonth) {
    for (let start = 0; start < missing.length; start += 100) {
      const batch = missing.slice(start, start + 100);
      const request = callFeedbackApi<{ tokens: Record<string, string> }>({
        action: "monthly-feedback-links", courseMonth, studentIds: batch.map((task) => task.studentRecordId),
      });
      for (const task of batch) {
        const key = monthlyTaskKey(task);
        issued.set(key, request.then(({ tokens }) => {
          if (!tokens[key]) throw new Error("未取得学生月度链接");
          // 线上用短地址 /m/（同一个学生页），手机上链接短、二维码也更好扫
          const url = new URL(import.meta.env.DEV ? `${import.meta.env.BASE_URL}student.html` : "/m/", siteOrigin);
          url.hash = tokens[key];
          return url.href;
        }).catch((error) => {
          issued.delete(key);
          throw error;
        }));
      }
    }
  }
  return Object.fromEntries(await Promise.all(unique.map(async (task) => {
    const key = monthlyTaskKey(task);
    return [key, await issued.get(key)!];
  })));
}

export function monthlyUrl(links: MonthlyLinks, task: StudentMonth): string {
  const url = links[monthlyTaskKey(task)];
  if (!url) throw new Error("未取得学生月度链接");
  return url;
}
