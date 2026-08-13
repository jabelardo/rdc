/** The lifecycle state owned by the native operation registry. */
export type OperationState =
  | "running"
  | "takingLongerThanExpected"
  | "cancelling"
  | "recovering"
  | "completed"
  | "cancelled"
  | "timedOut"
  | "failed";

export type OperationOutcome = "unchanged" | "recovered" | "completed" | "unknown";

export type GitOperationKind =
  | "fetch"
  | "push"
  | "pull"
  | "checkout"
  | "clone"
  | "commit"
  | "merge"
  | "rebase"
  | "cherryPick"
  | "revert";

export type OperationScope =
  | { readonly kind: "repository"; readonly lockKey: string; readonly repositoryPath: string }
  | {
      readonly kind: "cloneDestination";
      readonly lockKey: string;
      readonly destinationPath: string;
    };

export type CancellationCapability =
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly label: string }
  | { readonly kind: "requested" };

export type OperationError = {
  readonly kind: "cancelled" | "timedOut" | "recoveryFailed" | "conflict" | "failed";
  readonly message: string;
  readonly recoverable: boolean;
};

export type OperationProgress = {
  readonly value: number;
  readonly title?: string;
  readonly description?: string;
};

export type OperationHook = {
  readonly id: number;
  readonly hook: string;
  readonly status: "started" | "finished" | "failed";
};

export type OperationRecord = {
  readonly id: string;
  readonly scope: OperationScope;
  readonly ownerWindow: string | null;
  readonly operation: GitOperationKind;
  readonly state: OperationState;
  readonly cancellation: CancellationCapability;
  readonly progress: OperationProgress | null;
  readonly hook?: OperationHook;
  /** Unix epoch milliseconds, supplied by native code. */
  readonly lastActivityAt: number;
  readonly outcome: OperationOutcome | null;
  readonly error: OperationError | null;
};

export type OperationEvent =
  | {
      readonly kind: "progress";
      readonly operationId: string;
      readonly progress: OperationProgress;
    }
  | {
      readonly kind: "state";
      readonly operationId: string;
      readonly state: "takingLongerThanExpected" | "cancelling" | "recovering";
    }
  | {
      readonly kind: "finished";
      readonly operationId: string;
      readonly state: "completed" | "cancelled" | "timedOut" | "failed";
      readonly outcome: OperationOutcome;
      readonly error: OperationError | null;
    };

export type OperationEventEnvelope = {
  readonly record: OperationRecord;
  readonly event: OperationEvent;
};

export type OperationPresentationRole = "owner" | "observer" | "unowned";
