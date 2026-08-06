import { type PropsWithChildren, useEffect, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type ModalProps = PropsWithChildren<{
  readonly role?: "dialog" | "alertdialog";
  readonly className?: string;
  readonly onDismiss?: () => void;
  readonly "aria-labelledby": string;
  readonly "aria-describedby"?: string;
}>;

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest("[hidden]") === null,
  );
}

/**
 * Supply the keyboard behavior shared by every renderer-owned modal.
 *
 * Callers omit onDismiss when the user must make an explicit decision.
 */
export function Modal({
  children,
  className,
  onDismiss,
  role = "dialog",
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: ModalProps) {
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = dialog.current;
    if (container === null) {
      return;
    }

    (focusableElements(container)[0] ?? container).focus();
    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <div className="dialog-backdrop fixed inset-0 z-10 grid place-items-center bg-[var(--scrim)]">
      <section
        ref={dialog}
        className={className}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && onDismiss !== undefined) {
            event.preventDefault();
            onDismiss();
            return;
          }
          if (event.key !== "Tab") {
            return;
          }

          const focusable = focusableElements(event.currentTarget);
          if (focusable.length === 0) {
            event.preventDefault();
            event.currentTarget.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        {children}
      </section>
    </div>
  );
}
