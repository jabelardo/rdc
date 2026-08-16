import type { OperationEventEnvelope, OperationScope } from "@/models/operation";

/** The native lock identity used to route an operation event. */
export function operationScopeKey(scope: OperationScope): string {
  return scope.lockKey;
}

/** Whether an event belongs to the repository scope currently observed by a window. */
export function isOperationEventForScope(
  event: OperationEventEnvelope,
  scope: OperationScope,
): boolean {
  return operationScopeKey(event.record.scope) === operationScopeKey(scope);
}

/** Returns a stable predicate for a window that has hydrated an operation snapshot. */
export function createOperationEventFilter(
  scope: OperationScope,
): (event: OperationEventEnvelope) => boolean {
  return (event) => isOperationEventForScope(event, scope);
}

/** Routes the shared native stream for one window as its selected repository changes. */
export class OperationEventRouter {
  private filter: ((event: OperationEventEnvelope) => boolean) | null = null;

  public constructor(private readonly onEvent: (event: OperationEventEnvelope) => void) {}

  public selectScope(scope: OperationScope | null): void {
    this.filter = scope === null ? null : createOperationEventFilter(scope);
  }

  public receive(event: OperationEventEnvelope): void {
    if (this.filter?.(event) === true) {
      this.onEvent(event);
    }
  }

  public clear(): void {
    this.filter = null;
  }
}
