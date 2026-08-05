export type MessageSeverity = "error" | "warning" | "info";

export type Message = {
  readonly id: string;
  readonly severity: MessageSeverity;
  readonly text: string;
};

export type MessageState = {
  readonly messages: ReadonlyArray<Message>;
};

const EmptyState: MessageState = { messages: [] };

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

  public push(severity: MessageSeverity, text: string): string {
    const id = String(this.nextID++);
    this.update({
      messages: [...this.currentState.messages, { id, severity, text }],
    });
    if (severity === "info") {
      const timer = setTimeout(() => this.dismiss(id), 5_000);
      this.timers.set(id, timer);
    }
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

  private update(state: MessageState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
