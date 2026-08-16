import { describe, expect, it, vi } from "vitest";
import { TerminalOutputBuffer } from "./terminal-output-buffer";

describe("TerminalOutputBuffer", () => {
  it("streams live output and replays the bounded snapshot to late subscribers", () => {
    const buffer = new TerminalOutputBuffer(10);
    const live = vi.fn();
    buffer.subscribe(live);

    buffer.push("123456");
    buffer.push("789012");

    expect(live).toHaveBeenLastCalledWith("3456789012");
    const late = vi.fn();
    buffer.subscribe(late);
    expect(late).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledWith("3456789012");
  });

  it("preserves new chunks for live listeners even when the snapshot trims them", () => {
    const buffer = new TerminalOutputBuffer(3);
    const listener = vi.fn();
    buffer.subscribe(listener);

    buffer.push("long output");

    expect(listener).toHaveBeenLastCalledWith("put");
    expect(buffer.value).toBe("put");
  });

  it("clears output, notifies subscribers, and supports unsubscribe", () => {
    const buffer = new TerminalOutputBuffer();
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);
    buffer.push("hook output");

    buffer.clear();
    expect(listener).toHaveBeenLastCalledWith("");

    unsubscribe();
    buffer.push("ignored");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
