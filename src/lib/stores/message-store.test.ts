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
      { id: expect.any(String), severity: "error", text: "Could not rename branch" },
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

    expect(store.state.messages).toEqual([{ id: keep, severity: "error", text: "keep" }]);
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
