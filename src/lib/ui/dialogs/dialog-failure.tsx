import { cn } from "@/lib/utils";

type DialogFailureProps = {
  /** The failure text, or `null` when the action has not failed. */
  readonly error: string | null;
  readonly className?: string;
};

/**
 * How a dialog shows the failure of the action it confirmed.
 *
 * `COMPONENT_MIGRATION_PROCESS.md` Convention 17: a failure belongs to the surface the user acted
 * on, so a dialog-owned failure stays here rather than becoming a toast. That was settled by
 * measurement — behind a Radix modal a toast is visible but inert, because the modal sets
 * `pointer-events: none` on `<body>` and sonner never re-enables it, so an error toast raised from
 * a dialog cannot be dismissed until the dialog closes.
 *
 * Distinct from {@link DialogMessage}, and the difference is worth keeping: that one is a
 * height-holding slot for whatever a dialog has to *say* — validation, a warning, context — and it
 * reserves its space so the buttons never move under the pointer. This is the *outcome of an
 * attempt*, which only ever appears after the user has committed to something, so it may take space
 * when it arrives. It is boxed rather than coloured text for the same reason: it reports that the
 * thing you just asked for did not happen.
 *
 * A dialog rendering this must also keep an enabled way out — see Convention 17. Showing a failure
 * without one turns a retryable dialog into a trap.
 */
export function DialogFailure({ error, className }: DialogFailureProps) {
  if (error === null) {
    return null;
  }

  return (
    <p
      className={cn(
        // `dialog-failure` carries no layout — it is the hook the forced-colors override in
        // App.css needs, which the old `.application-error` had and which high-contrast users
        // would otherwise have lost in this migration.
        "dialog-failure",
        "rounded-[var(--radius-small)] border border-[var(--error-border)] bg-[var(--error-surface)] px-2.5 py-2 text-[var(--error-text)]",
        className,
      )}
      role="alert"
    >
      {error}
    </p>
  );
}
