import type { ICloneProgress } from "@/models/progress";
import type { OperationEventEnvelope, OperationRecord } from "@/models/operation";
import {
  getActiveOperationForCloneDestination,
  listenToOperationEvents,
  requestOperationCancellation,
} from "@/lib/operations/operation-ipc";
import { clone as cloneRepository } from "@/features/remotes/api/remote-ipc";
import { describeRemoteError } from "@/features/remotes/remote-error";
import { describeError } from "@/utils/format-error";

export type CloneState = {
  readonly operation: "clone" | null;
  readonly progress: ICloneProgress | null;
  readonly nativeOperation: OperationRecord | null;
  readonly error: string | null;
};

type CloneStoreDependencies = {
  readonly clone: typeof cloneRepository;
  readonly getActive: typeof getActiveOperationForCloneDestination;
  readonly listen: (callback: (event: OperationEventEnvelope) => void) => Promise<() => void>;
  readonly cancel: typeof requestOperationCancellation;
};

const EmptyState: CloneState = {
  operation: null,
  progress: null,
  nativeOperation: null,
  error: null,
};

/**
 * Owns one generic clone operation.
 *
 * URL/path form state remains in the view. This store owns validation, serialization, native
 * progress and stale-callback rejection; repository persistence starts only after it returns the
 * successfully cloned destination.
 */
export class CloneStore {
  private currentState = EmptyState;
  private operationID = 0;
  private readonly dependencies: CloneStoreDependencies;
  private readonly listeners = new Set<(state: CloneState) => void>();

  public constructor(dependencies: Partial<CloneStoreDependencies> = {}) {
    this.dependencies = {
      clone: cloneRepository,
      getActive: getActiveOperationForCloneDestination,
      listen: listenToOperationEvents,
      cancel: requestOperationCancellation,
      ...dependencies,
    };
  }

  public get state(): CloneState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: CloneState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async clone(requestedURL: string, requestedPath: string): Promise<string | null> {
    if (this.currentState.operation !== null) {
      return null;
    }

    const url = requestedURL.trim();
    const path = requestedPath.trim();
    if (url.length === 0) {
      this.update({ ...this.currentState, error: "Enter a repository URL." });
      return null;
    }
    if (path.length === 0) {
      this.update({
        ...this.currentState,
        error: "Choose a destination path.",
      });
      return null;
    }

    const operationID = ++this.operationID;
    this.update({
      operation: "clone",
      progress: {
        kind: "clone",
        title: `Cloning into ${path}`,
        value: 0,
      },
      nativeOperation: null,
      error: null,
    });

    let trackedNativeOperationID: string | undefined;
    let unlisten: (() => void) | undefined;
    try {
      try {
        unlisten = await this.dependencies.listen((event) => {
          if (operationID === this.operationID && trackedNativeOperationID === event.record.id) {
            this.update({ ...this.currentState, nativeOperation: event.record });
          }
        });
      } catch {
        // Native lifecycle tracking enriches presentation but must not prevent cloning.
      }
      const clone = this.dependencies.clone(
        url,
        path,
        null,
        {},
        (progress) => {
          if (operationID === this.operationID) {
            this.update({
              ...this.currentState,
              progress,
            });
          }
        },
        false,
      );
      try {
        const active = await this.dependencies.getActive(path);
        if (
          operationID === this.operationID &&
          active?.operation === "clone" &&
          active.scope.kind === "cloneDestination"
        ) {
          trackedNativeOperationID = active.id;
          this.update({ ...this.currentState, nativeOperation: active });
        }
      } catch {
        // Keep the existing clone progress model when lifecycle hydration is unavailable.
      }
      await clone;
      if (operationID !== this.operationID) {
        return null;
      }
      this.update(EmptyState);
      return path;
    } catch (error) {
      if (operationID === this.operationID) {
        this.update({
          operation: null,
          progress: null,
          nativeOperation: null,
          error: describeRemoteError(error),
        });
      }
      return null;
    } finally {
      unlisten?.();
    }
  }

  public reset(): void {
    this.operationID++;
    this.update(EmptyState);
  }

  public async requestCancellation(): Promise<void> {
    const operation = this.currentState.nativeOperation;
    if (operation === null || operation.cancellation.kind !== "available") {
      return;
    }
    try {
      const updated = await this.dependencies.cancel(operation.id);
      if (this.currentState.nativeOperation?.id === operation.id) {
        this.update({ ...this.currentState, nativeOperation: updated });
      }
    } catch (error) {
      if (this.currentState.nativeOperation?.id === operation.id) {
        this.update({ ...this.currentState, error: describeError(error) });
      }
    }
  }

  private update(state: CloneState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
