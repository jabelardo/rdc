import { beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "../__generated__/wire-snapshot.json";
import { Shell, type FoundShell } from "../../models/shell";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { findShellOrDefault, getAvailableShells, launchCustomShell, launchShell } =
  await import("./shells");

describe("getAvailableShells", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("uses native discovery and preserves the domain model", async () => {
    const shells: ReadonlyArray<FoundShell> = [
      {
        shell: Shell.Terminal,
        path: "/Applications/Utilities/Terminal.app",
        bundleID: "com.apple.Terminal",
      },
    ];
    invoke.mockResolvedValue(shells);

    await expect(getAvailableShells()).resolves.toBe(shells);
    expect(invoke).toHaveBeenCalledWith("get_available_shells");
  });

  it("matches the Rust serializer shape", () => {
    const foundShell: FoundShell = {
      shell: Shell.Gnome,
      path: "/usr/bin/gnome-terminal",
    };

    expect(snapshot.foundShell).toEqual(foundShell);
  });
});

describe("shell selection and launch", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("finds the selected shell or falls back to the first available default", async () => {
    const shells: ReadonlyArray<FoundShell> = [
      { shell: Shell.Gnome, path: "/usr/bin/gnome-terminal" },
      { shell: Shell.Konsole, path: "/usr/bin/konsole" },
    ];
    invoke.mockResolvedValue(shells);

    await expect(findShellOrDefault(Shell.Konsole)).resolves.toBe(shells[1]);
    await expect(findShellOrDefault(Shell.Terminal)).resolves.toBe(shells[0]);
  });

  it("passes normal and custom shells through typed commands", async () => {
    const shell: FoundShell = {
      shell: Shell.Konsole,
      path: "/usr/bin/konsole",
    };
    const customShell = {
      path: "/usr/bin/custom-terminal",
      arguments: '--working-directory "%TARGET_PATH%"',
    };
    invoke.mockResolvedValue(undefined);

    await launchShell(shell, "/repos/project");
    await launchCustomShell(customShell, "/repos/project");

    expect(invoke).toHaveBeenNthCalledWith(1, "launch_shell", {
      shell,
      path: "/repos/project",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "launch_custom_shell", {
      customShell,
      path: "/repos/project",
    });
  });
});
