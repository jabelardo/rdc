import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-log", () => pluginLogger);

const { installLogger } = await import("./install-logger");

describe("ambient logger", () => {
  beforeEach(() => {
    for (const method of Object.values(pluginLogger)) {
      method.mockReset();
      method.mockResolvedValue(undefined);
    }
  });

  it.each(["debug", "info", "warn"] as const)(
    "forwards %s records to the Rust log plugin",
    (level) => {
      installLogger();

      log[level]("message");

      expect(pluginLogger[level]).toHaveBeenCalledWith("message");
    },
  );

  it("includes an error stack in the same record", () => {
    installLogger();
    const error = new Error("broken");

    log.error("operation failed", error);

    expect(pluginLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("operation failed\nError: broken"),
    );
  });
});
