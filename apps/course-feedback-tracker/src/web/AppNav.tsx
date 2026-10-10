import { ClipboardList, LogOut, Tags, Trophy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type Page = "tracking" | "scores" | "course-types";

const HASH: Record<Page, string> = { tracking: "#/", scores: "#/scores", "course-types": "#/course-types" };

function pageFromHash(): Page {
  const entry = Object.entries(HASH).find(([, hash]) => hash !== "#/" && window.location.hash === hash);
  return (entry?.[0] as Page | undefined) ?? "tracking";
}

/** 两个页面用 hash 区分：刷新、收藏、发链接都能停在原页面，不需要路由库。 */
export function usePage(): [Page, (page: Page) => void] {
  const [page, setPage] = useState(pageFromHash);
  useEffect(() => {
    const onChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [page, (next) => (window.location.hash = HASH[next])];
}

export function AppNav({ page, onChange }: { page: Page; onChange: (page: Page) => void }) {
  return (
    <Tabs value={page} onValueChange={(value) => onChange(value as Page)}>
      <TabsList>
        <TabsTrigger value="tracking">
          <ClipboardList /> 问卷跟踪
        </TabsTrigger>
        <TabsTrigger value="scores">
          <Trophy /> 老师评分
        </TabsTrigger>
        <TabsTrigger value="course-types">
          <Tags /> 课程类型
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** 两个页面共用的页头：标题 + 页面切换在左，各页自己的操作在右，同步时间在下方。 */
export function PageHeader({
  page,
  onPageChange,
  onSignOut,
  actions,
  status,
}: {
  page: Page;
  onPageChange: (page: Page) => void;
  onSignOut: () => void | Promise<void>;
  actions?: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">月度课程反馈</h1>
          <AppNav page={page} onChange={onPageChange} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Button variant="ghost" size="icon" onClick={() => void onSignOut()} aria-label="退出登录">
            <LogOut />
          </Button>
        </div>
      </div>
      {status}
    </header>
  );
}
