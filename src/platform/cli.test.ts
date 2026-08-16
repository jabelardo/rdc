import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { InstalledCLIPath, installCLI } = await import("./cli");

describe("macOS CLI installer", () => {
  it("uses an rdc-owned installed name and delegates installation to Rust", async () => {
    invoke.mockResolvedValue(undefined);

    expect(InstalledCLIPath).toBe("/usr/local/bin/rdc");
    await expect(installCLI()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("install_darwin_cli");
  });
});
