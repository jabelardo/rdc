export type MessageSeverity = "error" | "warning" | "info";

export type Message = {
  readonly id: string;
  readonly severity: MessageSeverity;
  readonly text: string;
  /** 1 for a first occurrence, incremented each time an identical message is pushed again. */
  readonly count: number;
};

export type MessageState = {
  readonly messages: ReadonlyArray<Message>;
};

const EmptyState: MessageState = { messages: [] };

/** How long an `info` message stays before dismissing itself. */
const AutoDismissDelayMs = 5_000;

/**
 * The one place errors, warnings and confirmations become visible — see MESSAGE_SYSTEM_PLAN.md.
 *
 * Point-in-time events only, not ongoing state: a fetch/push/pull/clone's own progress stays on
 * its owning store's `progress` field and is never routed through here. Errors and warnings are
 * dismissed only by the user (an explicit decision was reported; it should not vanish
 * unacknowledged); info auto-dismisses after a short delay, since it is a confirmation, not
 * something that needs acting on.
 */
export class MessageStore {
  private currentState = EmptyState;
  private nextID = 0;
  private readonly listeners = new Set<(state: MessageState) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  public get state(): MessageState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: MessageState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Adds a message, or collapses onto an identical one that is already showing.
   *
   * Coalescing exists because a single root cause reaches this store more than once: when a
   * repository's directory disappears, the working-tree, conflict and remote stores each refresh,
   * each fail, and each report it. Without collapsing, one event becomes three stacked toasts the
   * user has to dismiss individually — the defect MESSAGE_SYSTEM_PLAN.md was written to remove,
   * relocated rather than fixed.
   *
   * "Identical" is exact equality of severity and text, deliberately: it is the only rule that
   * needs no classification the frontend does not already have, and fuzzy matching would collapse
   * genuinely different failures. Two distinct problems that happen to read the same do merge —
   * accepted, and the reason the count is shown rather than silently swallowed.
   *
   * A collapsed message keeps its position, so a repeat updates the toast in place instead of
   * making it jump to the front of the stack.
   */
  public push(severity: MessageSeverity, text: string): string {
    const existing = this.currentState.messages.find(
      (message) => message.severity === severity && message.text === text,
    );

    if (existing !== undefined) {
      this.update({
        messages: this.currentState.messages.map((message) =>
          message.id === existing.id ? { ...message, count: message.count + 1 } : message,
        ),
      });
      this.scheduleAutoDismiss(existing.id, severity);
      return existing.id;
    }

    const id = String(this.nextID++);
    this.update({
      messages: [...this.currentState.messages, { id, severity, text, count: 1 }],
    });
    this.scheduleAutoDismiss(id, severity);
    return id;
  }

  public dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    if (!this.currentState.messages.some((message) => message.id === id)) {
      return;
    }
    this.update({
      messages: this.currentState.messages.filter((message) => message.id !== id),
    });
  }

  /**
   * (Re)starts the auto-dismiss timer for an `info` message, and is a no-op for the severities
   * that never auto-dismiss.
   *
   * Restarting on a repeat is the point: a background event that is still recurring should stay on
   * screen, not disappear on the first occurrence's original deadline.
   */
  private scheduleAutoDismiss(id: string, severity: MessageSeverity): void {
    const pending = this.timers.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.timers.delete(id);
    }
    if (severity !== "info") {
      return;
    }
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), AutoDismissDelayMs),
    );
  }

  private update(state: MessageState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
