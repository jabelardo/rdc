import { describeError } from "@/utils/format-error";
import { getDefaultMessageStore } from "./default-message-store";

/**
 * Reporting an error is a shared capability, not a feature's job.
 *
 * Split from `describeError` deliberately. Formatting a caught value is pure and belongs with the
 * other pure helpers; *pushing the result somewhere* is I/O against a store, and a module that does
 * it is not a util however small it looks. Keeping them in one file made `utils/` import a store,
 * which is the shared-layer-reaching-into-a-feature direction the structure forbids.
 */

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
