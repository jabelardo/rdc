import type { ReactNode } from "react";
import { cn } from "../../utils";

export type DialogMessageTone = "error" | "warning" | "info";

type DialogMessageProps = {
  readonly tone?: DialogMessageTone;
  readonly children?: ReactNode;
  readonly className?: string;
  /** Target for a field's `aria-describedby`, so a message is announced against that field. */
  readonly id?: string;
};

const toneClassName: Record<DialogMessageTone, string> = {
  error: "text-[var(--error-text)]",
  warning: "text-[var(--warning-text)]",
  info: "text-muted-foreground",
};

/**
 * The one place a dialog says something between its fields and its buttons.
 *
 * **The slot always occupies its space**, whether or not there is anything to say. A message that
 * appears and disappears as the user types would otherwise move the buttons under their cursor,
 * which is the worst possible moment for a confirm button to shift. `min-h` reserves two lines,
 * enough for the longest message these dialogs produce at the narrowest dialog width.
 *
 * One slot, so a dialog needs a priority order rather than a stack of stacked notices: report the
 * most urgent thing. `role="alert"` is set only for an error, because a warning that is present from
 * the moment the dialog opens is context, not an interruption — the same distinction as Convention
 * 10.
 */
export function DialogMessage({ tone = "info", children, className, id }: DialogMessageProps) {
  const hasMessage = children !== undefined && children !== null && children !== false;

  return (
    <p
      id={id}
      className={cn("min-h-[2.6em] text-sm", toneClassName[tone], className)}
      role={tone === "error" && hasMessage ? "alert" : undefined}
    >
      {children}
    </p>
  );
}
