import type {
  OperationEventEnvelope,
  OperationPresentationRole,
  OperationProgress,
  OperationRecord,
} from "@/models/operation";
import {
  getActiveOperationForRepository,
  getOperationScopeForRepository,
  listenToOperationEvents,
  requestOperationCancellation,
  type OperationEventEnvelope as OperationEventEnvelopeFromIPC,
} from "@/lib/operation-ipc";
import { OperationEventRouter } from "@/lib/operation-events";
import { operationPresentationRole } from "@/lib/operation-presentation";
import { describeError } from "@/lib/format-error";

export type OperationStoreState = {
  readonly repositoryPath: string | null;
  readonly operation: OperationRecord | null;
  readonly progress: OperationProgress | null;
  readonly role: OperationPresentationRole | null;
  readonly takingLonger: boolean;
  readonly cancellationRequested: boolean;
  readonly recovering: boolean;
  readonly outcome: OperationRecord["outcome"];
  readonly error: OperationRecord["error"];
  readonly refresh: OperationRecord["refresh"];
};

type Listen = (callback: (event: OperationEventEnvelope) => void) => Promise<() => void>;

type OperationStoreDependencies = {
  readonly getScope: typeof getOperationScopeForRepository;
  readonly getActive: typeof getActiveOperationForRepository;
  readonly listen: Listen;
  readonly cancel: typeof requestOperationCancellation;
};

const emptyState: OperationStoreState = {
  repositoryPath: null,
  operation: null,
  progress: null,
  role: null,
  takingLonger: false,
  cancellationRequested: false,
  recovering: false,
  outcome: null,
  error: null,
  refresh: undefined,
};

const defaultDependencies: OperationStoreDependencies = {
  getScope: getOperationScopeForRepository,
  getActive: getActiveOperationForRepository,
  listen: listenToOperationEvents,
  cancel: requestOperationCancellation,
};

function isTerminal(record: OperationRecord): boolean {
  return ["completed", "cancelled", "timedOut", "failed"].includes(record.state);
}

export class OperationStore {
  private currentState = emptyState;
  private readonly listeners = new Set<(state: OperationStoreState) => void>();
  private readonly dependencies: OperationStoreDependencies;
  private windowLabel: string;
  private requestID = 0;
  private unlisten: (() => void) | undefined;

  public constructor(windowLabel: string, dependencies: Partial<OperationStoreDependencies> = {}) {
    this.windowLabel = windowLabel;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public get state(): OperationStoreState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: OperationStoreState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setWindowLabel(windowLabel: string): void {
    if (this.windowLabel === windowLabel) {
      return;
    }
    this.windowLabel = windowLabel;
    if (this.state.operation !== null) {
      this.applyRecord(this.state.operation);
    }
  }

  public async selectRepository(repositoryPath: string | null): Promise<void> {
    const requestID = ++this.requestID;
    this.unlisten?.();
    this.unlisten = undefined;
    this.update({ ...emptyState, repositoryPath });
    if (repositoryPath === null) {
      return;
    }

    const scope = await this.dependencies.getScope(repositoryPath);
    if (requestID !== this.requestID) {
      return;
    }

    let receivedEvent = false;
    const router = new OperationEventRouter((event) => {
      receivedEvent = true;
      this.receive(event, requestID);
    });
    router.selectScope(scope);
    const cleanup = await this.dependencies.listen((event) => router.receive(event));
    if (requestID !== this.requestID) {
      cleanup();
      return;
    }
    this.unlisten = () => {
      router.clear();
      cleanup();
    };

    // Subscribe before reading the snapshot so an operation that starts while a new window is
    // hydrating cannot fall into the gap between those two native calls. If the stream already
    // delivered a record, it is newer than the snapshot and must win.
    const active = await this.dependencies.getActive(repositoryPath);
    if (requestID === this.requestID && !receivedEvent) {
      this.applyRecord(active);
    }
  }

  public async requestCancellation(confirmObserver = false): Promise<void> {
    const operation = this.state.operation;
    if (operation === null) {
      return;
    }
    try {
      this.applyRecord(await this.dependencies.cancel(operation.id, confirmObserver));
    } catch (error) {
      this.update({
        ...this.state,
        error: { kind: "failed", message: describeError(error), recoverable: true },
      });
    }
  }

  /** Remove a terminal record from this window after its outcome has been presented. */
  public dismissTerminalOperation(): void {
    if (this.state.operation === null || !isTerminal(this.state.operation)) {
      return;
    }
    this.update({ ...emptyState, repositoryPath: this.state.repositoryPath });
  }

  /** Reconcile a window that may have missed native events while opening or unfocused. */
  public async refreshActiveOperation(): Promise<void> {
    const repositoryPath = this.state.repositoryPath;
    const requestID = this.requestID;
    const operationID = this.state.operation?.id;
    if (repositoryPath === null) {
      return;
    }
    const active = await this.dependencies.getActive(repositoryPath);
    if (requestID !== this.requestID) {
      return;
    }
    if (active !== null) {
      this.applyRecord(active);
    } else if (
      operationID !== undefined &&
      this.state.operation?.id === operationID &&
      !isTerminal(this.state.operation)
    ) {
      this.update({ ...emptyState, repositoryPath });
    }
  }

  public dispose(): void {
    this.requestID++;
    this.unlisten?.();
    this.unlisten = undefined;
    this.listeners.clear();
  }

  private receive(event: OperationEventEnvelopeFromIPC, requestID: number): void {
    if (requestID !== this.requestID) {
      return;
    }
    const current = this.state.operation;
    if (current !== null && current.id !== event.record.id && !isTerminal(current)) {
      return;
    }
    this.applyRecord(event.record);
  }

  private applyRecord(record: OperationRecord | null): void {
    if (record === null) {
      return;
    }
    this.update({
      repositoryPath: this.state.repositoryPath,
      operation: record,
      progress: record.progress,
      role: operationPresentationRole(record, this.windowLabel),
      takingLonger: record.state === "takingLongerThanExpected",
      cancellationRequested:
        record.state === "cancelling" || record.cancellation.kind === "requested",
      recovering: record.state === "recovering",
      outcome: record.outcome,
      error: record.error,
      refresh: record.refresh,
    });
  }

  private update(state: OperationStoreState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
