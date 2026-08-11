import type {
  OperationEventEnvelope,
  OperationPresentationRole,
  OperationProgress,
  OperationRecord,
  OperationScope,
} from "../../models/operation";
import {
  getActiveOperationForRepository,
  getOperationScopeForRepository,
  listenToOperationEvents,
  requestOperationCancellation,
  type OperationEventEnvelope as OperationEventEnvelopeFromIPC,
} from "../operation-ipc";
import { OperationEventRouter } from "../operation-events";
import { operationPresentationRole } from "../operation-presentation";

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

  public constructor(
    windowLabel: string,
    dependencies: Partial<OperationStoreDependencies> = {},
  ) {
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
    if (this.windowLabel === windowLabel || this.state.operation === null) {
      return;
    }
    this.windowLabel = windowLabel;
    this.applyRecord(this.state.operation);
  }

  public async selectRepository(repositoryPath: string | null): Promise<void> {
    const requestID = ++this.requestID;
    this.unlisten?.();
    this.unlisten = undefined;
    this.update({ ...emptyState, repositoryPath });
    if (repositoryPath === null) {
      return;
    }

    const [scope, active] = await Promise.all([
      this.dependencies.getScope(repositoryPath),
      this.dependencies.getActive(repositoryPath),
    ]);
    if (requestID !== this.requestID) {
      return;
    }

    const router = new OperationEventRouter((event) => this.receive(event, requestID));
    router.selectScope(scope);
    this.applyRecord(active);
    const cleanup = await this.dependencies.listen((event) => router.receive(event));
    if (requestID !== this.requestID) {
      cleanup();
    } else {
      this.unlisten = () => {
        router.clear();
        cleanup();
      };
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
      this.update({ ...this.state, error: { kind: "failed", message: String(error), recoverable: true } });
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
      cancellationRequested: record.state === "cancelling" || record.cancellation.kind === "requested",
      recovering: record.state === "recovering",
      outcome: record.outcome,
      error: record.error,
    });
  }

  private update(state: OperationStoreState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
