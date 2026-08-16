import { getDefaultMessageStore } from "@/lib/stores/default-message-store";
import { isCommandError } from "./git-ipc";

/**
 * The one place a caught value becomes a string, so every catch block gets the same answer.
 *
 * Tauri's `invoke()` rejects with the raw deserialized `CommandError` object
 * (`{message, kind, isAuthFailure}`), not a JS `Error` — `String()` on that plain object yields
 * `"[object Object]"`, not its message. Checking `isCommandError` first, before the generic
 * `Error` case, is what fixes that.
 */
export function describeError(error: unknown): string {
  if (isCommandError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Formats `error` and reports it as an error-severity message. The drop-in replacement for
 * `catch (error) { setError(String(error)) }`. */
export function reportError(error: unknown): void {
  getDefaultMessageStore().push("error", describeError(error));
}

/**
 * Reports an already-formatted message, for callers that own domain-specific classification.
 *
 * `remote-store.ts` is the case this exists for: `describeRemoteError` turns a `GitErrorKind` into
 * product-reviewed recovery prose (non-fast-forward, merge conflicts, auth failure, the PAC/proxy
 * fallback) that the generic `describeError` cannot produce and the controller has no business
 * knowing. Classification stays with the store; only the reporting is shared.
 */
export function reportErrorMessage(text: string): void {
  getDefaultMessageStore().push("error", text);
}
