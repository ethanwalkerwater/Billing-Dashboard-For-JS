import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn Tabs 的外观，受控用法（value + onValueChange）。
 * 页面只用到"切换视图"这一种场景，不引 @radix-ui/react-tabs，少一个依赖。
 */
const TabsContext = React.createContext<{ value: string; onValueChange: (value: string) => void } | null>(null);

function Tabs({
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & { value: string; onValueChange: (value: string) => void }) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />
    </TabsContext.Provider>
  );
}

function TabsList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      className={cn("bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]", className)}
      {...props}
    />
  );
}

function TabsTrigger({ value, className, disabled, ...props }: React.ComponentProps<"button"> & { value: string }) {
  const context = React.useContext(TabsContext);
  const active = context?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-state={active ? "active" : "inactive"}
      disabled={disabled}
      onClick={() => context?.onValueChange(value)}
      className={cn(
        "text-foreground/70 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger };
