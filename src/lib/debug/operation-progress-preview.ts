import type { OperationRecord } from "../../models/operation";

/**
 * The lifecycle states `OperationProgressDialog` can render, as previewable cases.
 *
 * These are the states `OPERATION_PROGRESS_PLAN.md` Slice 16 enumerates, and the same ones the
 * Phase 8b rows ask a human to look at. Several are unreachable by hand in any reasonable time —
 * a hard timeout takes two minutes of inactivity, a recovery failure needs Git to fail *while*
 * recovering — which is exactly why they need a preview rather than a reproduction recipe.
 */
export const OperationPreviewStates = [
  "running",
  "takingLongerThanExpected",
  "cancelling",
  "recovering",
  "completed",
  "completedBeforeCancellation",
  "cancelled",
  "timedOut",
  "failed",
  "outcomeUnknown",
  "stoppedWaiting",
  "recoveryRequired",
] as const;

export type OperationPreviewState = (typeof OperationPreviewStates)[number];

/** How each case reads in the launcher, so the list is scannable rather than camel-cased. */
export const OperationPreviewLabel: Record<OperationPreviewState, string> = {
  running: "Running",
  takingLongerThanExpected: "Taking longer than expected",
  cancelling: "Cancelling…",
  recovering: "Recovering repository…",
  completed: "Completed",
  completedBeforeCancellation: "Completed before cancellation",
  cancelled: "Cancelled",
  timedOut: "Timed out",
  failed: "Failed",
  outcomeUnknown: "Outcome unknown",
  stoppedWaiting: "Stopped waiting (Push)",
  recoveryRequired: "Recovery required",
};

const scope = {
  kind: "repository",
  lockKey: "/tmp/mock-repo/.git",
  repositoryPath: "/tmp/mock-repo",
} as const;

/**
 * Builds the operation record that produces a given preview state.
 *
 * A record rather than a view model on purpose: the dialog under test must render from exactly the
 * shape the native registry sends it, through the same `operationProgressViewModel` the app uses.
 * Anything else would be previewing a different component than the one that ships.
 */
export function operationPreviewRecord(
  state: OperationPreviewState,
  operation: OperationRecord["operation"] = "fetch",
  ownerWindow: string | null = "main",
): OperationRecord {
  const base = {
    id: "debug-operation",
    scope,
    ownerWindow,
    operation,
    lastActivityAt: 0,
    refresh: undefined,
  } satisfies Partial<OperationRecord> & Record<string, unknown>;

  const progress = { value: 0.45, description: "Receiving objects: 45% (92/204)" };
  const cancellable = { kind: "available", label: `Cancel ${operation}` } as const;

  switch (state) {
    case "running":
      return {
        ...base,
        state: "running",
        cancellation: cancellable,
        progress,
        outcome: null,
        error: null,
      };
    case "takingLongerThanExpected":
      return {
        ...base,
        state: "takingLongerThanExpected",
        cancellation: cancellable,
        progress,
        outcome: null,
        error: null,
      };
    case "cancelling":
      return {
        ...base,
        state: "cancelling",
        cancellation: { kind: "requested" },
        progress,
        outcome: null,
        error: null,
      };
    // Not `requested`: a cancellation request outranks the lifecycle state in the view model, so
    // that combination reads "Cancelling…" and this case would preview the wrong copy. Recovery is
    // also entered from a conflict, not only from a cancellation, and it is never itself cancellable.
    case "recovering":
      return {
        ...base,
        state: "recovering",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: null,
        error: null,
      };
    case "completed":
      return {
        ...base,
        state: "completed",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "completed",
        error: null,
      };
    // The race the plan calls out: cancellation was asked for, and the operation finished first.
    case "completedBeforeCancellation":
      return {
        ...base,
        state: "cancelled",
        cancellation: { kind: "requested" },
        progress: null,
        outcome: "completed",
        error: null,
      };
    case "cancelled":
      return {
        ...base,
        state: "cancelled",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "unchanged",
        error: {
          kind: "cancelled",
          message: `${operation} cancelled before it changed the repository`,
          recoverable: true,
        },
      };
    case "timedOut":
      return {
        ...base,
        state: "timedOut",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "unchanged",
        error: {
          kind: "timedOut",
          message: `${operation} timed out with no activity for two minutes`,
          recoverable: true,
        },
      };
    // `unchanged` rather than `unknown`: the view model reads a failed+unknown pair as "Outcome
    // unknown" and never reaches the error message, which is a different case — see below.
    case "failed":
      return {
        ...base,
        state: "failed",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "unchanged",
        error: {
          kind: "failed",
          message: "fatal: could not read from remote repository",
          recoverable: true,
        },
      };
    // A failure that could not determine what it left behind. The failed+unknown pair is what
    // produces the literal "Outcome unknown" status.
    case "outcomeUnknown":
      return {
        ...base,
        state: "failed",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "unknown",
        error: {
          kind: "failed",
          message: "Could not determine whether the operation completed",
          recoverable: true,
        },
      };
    // Push's honest answer when the remote may or may not have accepted the update. Distinct from
    // the case above: a *cancelled* unknown outcome renders its message rather than the generic
    // status, which is the wording Slice 19 asked for.
    case "stoppedWaiting":
      return {
        ...base,
        state: "cancelled",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "unknown",
        error: {
          kind: "cancelled",
          message: "Stopped waiting; the remote may have accepted the update",
          recoverable: true,
        },
      };
    // The one state that must not offer a way out: the repository is still locked.
    case "recoveryRequired":
      return {
        ...base,
        state: "failed",
        cancellation: { kind: "unavailable" },
        progress: null,
        outcome: "unknown",
        error: {
          kind: "recoveryFailed",
          message: "Could not restore the repository after cancelling",
          recoverable: false,
        },
      };
  }
}
