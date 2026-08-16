import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "./message-store";

describe("MessageStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts with no messages", () => {
    const store = new MessageStore();

    expect(store.state.messages).toEqual([]);
  });

  it("pushes a message with the given severity and text", () => {
    const store = new MessageStore();

    store.push("error", "Could not rename branch");

    expect(store.state.messages).toEqual([
      { id: expect.any(String), severity: "error", text: "Could not rename branch", count: 1 },
    ]);
  });

  it("assigns each pushed message a distinct id", () => {
    const store = new MessageStore();

    const first = store.push("error", "first");
    const second = store.push("error", "second");

    expect(first).not.toEqual(second);
    expect(store.state.messages.map((message) => message.id)).toEqual([first, second]);
  });

  it("keeps multiple simultaneous messages, oldest first", () => {
    const store = new MessageStore();

    store.push("error", "first");
    store.push("warning", "second");
    store.push("info", "third");

    expect(store.state.messages.map((message) => message.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("dismisses a message by id, leaving the others", () => {
    const store = new MessageStore();
    const keep = store.push("error", "keep");
    const remove = store.push("error", "remove");

    store.dismiss(remove);

    expect(store.state.messages).toEqual([{ id: keep, severity: "error", text: "keep", count: 1 }]);
  });

  it("does nothing when dismissing an id that is not present", () => {
    const store = new MessageStore();
    store.push("error", "kept");

    expect(() => store.dismiss("not-a-real-id")).not.toThrow();
    expect(store.state.messages).toHaveLength(1);
  });

  it("notifies subscribers on push and on dismiss", () => {
    const store = new MessageStore();
    const states: unknown[] = [];
    store.onDidUpdate((state) => states.push(state));

    const id = store.push("error", "hello");
    store.dismiss(id);

    expect(states).toHaveLength(2);
    expect((states[0] as { messages: unknown[] }).messages).toHaveLength(1);
    expect((states[1] as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("stops notifying a listener once unsubscribed", () => {
    const store = new MessageStore();
    const listener = vi.fn();
    const unsubscribe = store.onDidUpdate(listener);

    unsubscribe();
    store.push("error", "hello");

    expect(listener).not.toHaveBeenCalled();
  });

  it("auto-dismisses an info message after 5 seconds", () => {
    const store = new MessageStore();

    store.push("info", "Branch renamed");
    expect(store.state.messages).toHaveLength(1);

    vi.advanceTimersByTime(5_000);

    expect(store.state.messages).toHaveLength(0);
  });

  it("does not auto-dismiss an error or a warning", () => {
    const store = new MessageStore();

    store.push("error", "error stays");
    store.push("warning", "warning stays");
    vi.advanceTimersByTime(60_000);

    expect(store.state.messages).toHaveLength(2);
  });

  // Coalescing — the reason this exists is in MESSAGE_SYSTEM_PLAN.md: one deleted repository
  // directory makes three stores fail and report the same sentence at the same moment.
  it("collapses an identical message instead of stacking a second copy", () => {
    const store = new MessageStore();

    const first = store.push("error", "failed to run git for 'getStatus'");
    const second = store.push("error", "failed to run git for 'getStatus'");

    expect(second).toEqual(first);
    expect(store.state.messages).toEqual([
      {
        id: first,
        severity: "error",
        text: "failed to run git for 'getStatus'",
        count: 2,
      },
    ]);
  });

  it("keeps counting past two", () => {
    const store = new MessageStore();

    store.push("error", "same");
    store.push("error", "same");
    store.push("error", "same");

    expect(store.state.messages).toHaveLength(1);
    expect(store.state.messages[0]?.count).toEqual(3);
  });

  it("does not collapse the same text reported at a different severity", () => {
    const store = new MessageStore();

    store.push("warning", "disk is nearly full");
    store.push("error", "disk is nearly full");

    expect(store.state.messages.map((message) => message.severity)).toEqual(["warning", "error"]);
    expect(store.state.messages.every((message) => message.count === 1)).toEqual(true);
  });

  it("does not collapse onto a message that has already been dismissed", () => {
    const store = new MessageStore();
    const first = store.push("error", "transient");

    store.dismiss(first);
    const second = store.push("error", "transient");

    expect(second).not.toEqual(first);
    expect(store.state.messages).toEqual([
      { id: second, severity: "error", text: "transient", count: 1 },
    ]);
  });

  it("collapses in place rather than moving the message to the end", () => {
    const store = new MessageStore();
    store.push("error", "first");
    store.push("error", "second");

    store.push("error", "first");

    expect(store.state.messages.map((message) => message.text)).toEqual(["first", "second"]);
  });

  it("dismissing a collapsed message removes it once, however many times it repeated", () => {
    const store = new MessageStore();
    const id = store.push("error", "repeated");
    store.push("error", "repeated");
    store.push("error", "repeated");

    store.dismiss(id);

    expect(store.state.messages).toEqual([]);
  });

  it("restarts an info message's auto-dismiss timer when it repeats", () => {
    const store = new MessageStore();

    store.push("info", "Fetched origin");
    vi.advanceTimersByTime(4_000);
    store.push("info", "Fetched origin");

    // The original deadline passes; the message survives because the repeat reset it.
    vi.advanceTimersByTime(2_000);
    expect(store.state.messages).toHaveLength(1);

    vi.advanceTimersByTime(3_000);
    expect(store.state.messages).toHaveLength(0);
  });

  it("clears an info message's pending timer when dismissed early, so it cannot double-fire", () => {
    const store = new MessageStore();
    const id = store.push("info", "Pushed to origin");

    store.dismiss(id);
    // A second info message reusing no particular id; advancing time must not throw or affect it.
    store.push("info", "unrelated");
    vi.advanceTimersByTime(5_000);

    expect(store.state.messages).toHaveLength(0);
  });
});
