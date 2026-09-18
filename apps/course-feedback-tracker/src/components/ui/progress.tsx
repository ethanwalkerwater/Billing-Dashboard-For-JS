import * as React from "react";

import { cn } from "@/lib/utils";

/** 简单进度条。只有一个用处（二维码批量生成），不值得为它再加一个 Radix 依赖。 */
function Progress({ value, className, ...props }: React.ComponentProps<"div"> & { value: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      data-slot="progress"
      className={cn("bg-primary/15 relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className="bg-primary h-full transition-[width] duration-150 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export { Progress };
