import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * The single themed progress bar in rdc.
 *
 * Vendored shadcn/Radix primitive, promoted by the progress-presentation decision
 * (`COMPONENT_MIGRATION_PROCESS.md`): one small element serves every category — inside the
 * dedicated operation-progress dialog the value drives it; in the toolbar and sidebar it is the
 * embedded background bar. The track and fill use the primary tokens, so light and dark are
 * respected without hand-written CSS (Convention 3).
 *
 * `value` is a percentage 0–100, Radix's convention. Callers with a 0–1 fraction (every git
 * progress event) multiply first.
 */
function Progress({
  className,
  value = 0,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary h-full w-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value ?? 0))}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
