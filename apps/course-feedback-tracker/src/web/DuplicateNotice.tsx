import { CopyCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatMoment } from "./report-types";
import type { DuplicateResponse } from "./useWorkbenchData";

/**
 * 业务方决定：同一学生对同一老师、同一身份重复提交，只算第一份。
 * 后面几份不丢，列在这里提醒教务——如果第二份才是真心话（比如第一份点错了），去飞书删掉第一份再刷新即可。
 */
export function DuplicateNotice({ duplicates }: { duplicates: DuplicateResponse[] }) {
  if (duplicates.length === 0) return null;
  return (
    <Alert>
      <CopyCheck />
      <AlertTitle>
        有 {duplicates.length} 份重复提交的反馈，只算第一份
      </AlertTitle>
      <AlertDescription className="block w-full">
        <details>
          <summary className="cursor-pointer text-xs">
            展开查看。若要改用后面那份，在飞书里删掉第一份，再点「刷新反馈」。
          </summary>
          <ul className="mt-2 divide-y">
            {duplicates.map((item) => (
              <li key={item.responseRecordId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="text-foreground font-medium">
                  {item.studentName} <span className="text-muted-foreground">×</span> {item.teacherName}
                </span>
                <Badge variant="outline">{item.identity === "parent" ? "家长" : "学生"}</Badge>
                <span className="text-muted-foreground font-mono text-xs">
                  重复提交于 {formatMoment(item.submittedAt)}
                  {item.countedAt ? ` · 计入的是 ${formatMoment(item.countedAt)} 那份` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </AlertDescription>
    </Alert>
  );
}
