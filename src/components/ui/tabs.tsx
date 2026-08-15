import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn(
        "flex gap-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:flex-row",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The tab strip. Radix supplies roving focus and arrow-key movement from `orientation`, so a
 * vertical list gets up/down and a horizontal one gets left/right without either being wired here.
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "flex shrink-0 gap-0.5",
        "data-[orientation=horizontal]:flex-row data-[orientation=horizontal]:border-b data-[orientation=horizontal]:border-[var(--border)]",
        "data-[orientation=vertical]:w-40 data-[orientation=vertical]:flex-col data-[orientation=vertical]:border-r data-[orientation=vertical]:border-[var(--border)] data-[orientation=vertical]:pr-2",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "flex items-center gap-2 rounded-[var(--radius-small)] px-2.5 py-1.5 text-left text-sm whitespace-nowrap",
        "text-muted-foreground transition-colors outline-none",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        "data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:font-medium",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-w-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
