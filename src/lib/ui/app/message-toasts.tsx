import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { useTheme } from "@/components/theme-provider";
import type { Message, MessageSeverity } from "@/lib/stores/message-store";

type MessageToastsProps = {
  readonly messages: ReadonlyArray<Message>;
  readonly onDismiss: (id: string) => void;
};

function show(severity: MessageSeverity, text: string, id: string, onDismiss: () => void): void {
  const options = { id, duration: Infinity, onDismiss };
  switch (severity) {
    case "error":
      toast.error(text, options);
      return;
    case "warning":
      toast.warning(text, options);
      return;
    case "info":
      toast.info(text, options);
      return;
  }
}

/**
 * The text a repeated message shows.
 *
 * The count is part of the toast's own text rather than a separate badge so that it reaches screen
 * readers: sonner re-announces a toast when its content changes, and a silent visual-only counter
 * would leave a non-sighted user unable to tell one failure from five.
 */
export function messageText({ text, count }: Pick<Message, "text" | "count">): string {
  return count > 1 ? `${text} (${count}×)` : text;
}

/**
 * Bridges MessageStore's reactive state into sonner's imperative toast API.
 *
 * `MessageStore` owns dismissal timing (its own timer for `info`, an explicit call for
 * error/warning) so there is one source of truth for "is this message still active" — this
 * component only ever reacts to that state, both when a message appears (call the matching
 * `toast.*`) and when it disappears from the store before the user closed it in the UI (call
 * `toast.dismiss`). `duration: Infinity` on every toast disables sonner's own auto-dismiss timer,
 * so nothing races the store's.
 *
 * Portalled to `document.body`, same as `src/lib/ui/tooltip.tsx`: sonner's own container sets
 * `position: fixed` on itself via a runtime-injected stylesheet, not by returning a portal, so
 * mounted in place it is still a real (if usually invisible) child of `.application-shell`'s CSS
 * grid — an unstyled grid item that silently steals a track and pushes every other pane over.
 * Portalling is what actually takes it out of that layout, not the `fixed` positioning alone.
 *
 * Reads `resolvedTheme` (not `theme`) from `useTheme()`, so sonner's colors always match what
 * Tauri's own OS-level theme detection already decided for the rest of the app, rather than
 * trusting sonner's independent browser `matchMedia` check to agree with it.
 */
export function MessageToasts({ messages, onDismiss }: MessageToastsProps) {
  const { resolvedTheme } = useTheme();
  // Keyed by message id, valued by the count last rendered — a Set of ids would show the first
  // occurrence and then never update the toast when the same message repeats.
  const shown = useRef(new Map<string, number>());

  useEffect(() => {
    const currentIDs = new Set(messages.map((message) => message.id));

    for (const message of messages) {
      if (shown.current.get(message.id) === message.count) {
        continue;
      }
      shown.current.set(message.id, message.count);
      // Calling `toast.*` again with the same id updates that toast in place rather than stacking
      // a second one, which is what makes a repeat a re-announcement instead of a new message.
      show(message.severity, messageText(message), message.id, () => onDismiss(message.id));
    }

    for (const id of shown.current.keys()) {
      if (!currentIDs.has(id)) {
        shown.current.delete(id);
        toast.dismiss(id);
      }
    }
  }, [messages, onDismiss]);

  return createPortal(<Toaster theme={resolvedTheme} />, document.body);
}
