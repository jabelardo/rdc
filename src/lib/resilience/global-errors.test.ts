import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalErrorLogging } from "./global-errors";

describe("global renderer error logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records uncaught errors and unhandled promise rejections without suppressing browser diagnostics", () => {
    const loggedError = vi.spyOn(log, "error");
    const cleanup = installGlobalErrorLogging();
    const error = new Error("timer exploded");
    const errorEvent = new ErrorEvent("error", {
      error,
      message: error.message,
      cancelable: true,
    });
    const rejection = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(rejection, "reason", {
      value: "rejected value",
    });

    window.dispatchEvent(errorEvent);
    window.dispatchEvent(rejection);

    expect(loggedError).toHaveBeenCalledWith("Uncaught renderer error", error);
    expect(loggedError).toHaveBeenCalledWith(
      "Unhandled renderer promise rejection",
      expect.objectContaining({ message: "rejected value" }),
    );
    expect(errorEvent.defaultPrevented).toBe(false);
    expect(rejection.defaultPrevented).toBe(false);

    cleanup();
  });
});
