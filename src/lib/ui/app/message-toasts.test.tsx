import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Message } from "../../stores/message-store";
import { MessageToasts, messageText } from "./message-toasts";

const error = vi.fn();
const warning = vi.fn();
const info = vi.fn();
const dismiss = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => error(...args),
    warning: (...args: unknown[]) => warning(...args),
    info: (...args: unknown[]) => info(...args),
    dismiss: (...args: unknown[]) => dismiss(...args),
  },
}));

vi.mock("../../../components/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("../theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

function message(overrides: Partial<Message> = {}): Message {
  return { id: "1", severity: "error", text: "boom", count: 1, ...overrides };
}

describe("messageText", () => {
  it("shows the text alone on a first occurrence", () => {
    expect(messageText({ text: "boom", count: 1 })).toEqual("boom");
  });

  // The count travels in the toast's own text so screen readers hear it — a visual-only badge
  // would leave a non-sighted user unable to tell one failure from five.
  it("appends the repeat count once a message has recurred", () => {
    expect(messageText({ text: "boom", count: 3 })).toEqual("boom (3×)");
  });
});

describe("MessageToasts", () => {
  beforeEach(() => {
    error.mockClear();
    warning.mockClear();
    info.mockClear();
    dismiss.mockClear();
  });

  it("shows each severity through its matching sonner call", () => {
    render(
      <MessageToasts
        messages={[
          message({ id: "1", severity: "error", text: "failed" }),
          message({ id: "2", severity: "warning", text: "careful" }),
          message({ id: "3", severity: "info", text: "done" }),
        ]}
        onDismiss={vi.fn()}
      />,
    );

    expect(error).toHaveBeenCalledWith("failed", expect.objectContaining({ id: "1" }));
    expect(warning).toHaveBeenCalledWith("careful", expect.objectContaining({ id: "2" }));
    expect(info).toHaveBeenCalledWith("done", expect.objectContaining({ id: "3" }));
  });

  it("does not re-show an unchanged message when the component rerenders", () => {
    const messages = [message()];
    const { rerender } = render(<MessageToasts messages={messages} onDismiss={vi.fn()} />);
    error.mockClear();

    rerender(<MessageToasts messages={[...messages]} onDismiss={vi.fn()} />);

    expect(error).not.toHaveBeenCalled();
  });

  // The regression this guards: tracking shown ids in a Set renders the first occurrence and then
  // never updates the toast, so a repeat is silently swallowed.
  it("updates the same toast in place when a message repeats", () => {
    const { rerender } = render(
      <MessageToasts messages={[message({ count: 1 })]} onDismiss={vi.fn()} />,
    );
    error.mockClear();

    rerender(<MessageToasts messages={[message({ count: 2 })]} onDismiss={vi.fn()} />);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("boom (2×)", expect.objectContaining({ id: "1" }));
  });

  it("dismisses a toast whose message left the store", () => {
    const { rerender } = render(<MessageToasts messages={[message()]} onDismiss={vi.fn()} />);

    rerender(<MessageToasts messages={[]} onDismiss={vi.fn()} />);

    expect(dismiss).toHaveBeenCalledWith("1");
  });
});
