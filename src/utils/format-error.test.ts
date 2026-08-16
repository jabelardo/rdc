import { afterEach, describe, expect, it } from "vitest";
import { describeError, reportError } from "./format-error";
import { getDefaultMessageStore } from "@/features/messages/stores/default-message-store";

describe("describeError", () => {
  it("reads the message off a CommandError-shaped rejection", () => {
    const error = { message: "branch name already exists", isAuthFailure: false };

    expect(describeError(error)).toBe("branch name already exists");
  });

  it("reads the message off a real Error instance", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("falls back to String() for anything else", () => {
    expect(describeError("already a string")).toBe("already a string");
    expect(describeError(42)).toBe("42");
  });

  it("does not render a CommandError rejection as [object Object]", () => {
    const error = { message: "real message", isAuthFailure: false };

    expect(describeError(error)).not.toBe("[object Object]");
  });
});

describe("reportError", () => {
  afterEach(() => {
    const store = getDefaultMessageStore();
    for (const message of store.state.messages) {
      store.dismiss(message.id);
    }
  });

  it("pushes the described error at error severity", () => {
    reportError(new Error("could not rename branch"));

    const messages = getDefaultMessageStore().state.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      severity: "error",
      text: "could not rename branch",
    });
  });
});
