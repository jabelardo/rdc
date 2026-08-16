import { beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "@/lib/__generated__/wire-snapshot.json";
import type { ICustomIntegrationPathValidation } from "@/models/custom-integration";
import type { FoundEditor } from "@/models/editor";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const {
  getAvailableEditors,
  isValidCustomIntegration,
  launchCustomExternalEditor,
  launchExternalEditor,
  validateCustomIntegrationPath,
} = await import("./editors");

describe("getAvailableEditors", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("uses the native discovery command and preserves its typed result", async () => {
    const editors: ReadonlyArray<FoundEditor> = [
      { editor: "Visual Studio Code", path: "/usr/bin/code" },
    ];
    invoke.mockResolvedValue(editors);

    await expect(getAvailableEditors()).resolves.toBe(editors);
    expect(invoke).toHaveBeenCalledWith("get_available_editors");
  });

  it("matches the Rust serializer shape", () => {
    const foundEditor: FoundEditor = {
      editor: "Visual Studio Code",
      path: "/usr/bin/code",
    };

    expect(snapshot.foundEditor).toEqual(foundEditor);
  });
});

describe("editor launching", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("sends a discovered editor using the domain model", async () => {
    const editor: FoundEditor = {
      editor: "Visual Studio Code",
      path: "/usr/bin/code",
    };

    await launchExternalEditor("/repos/project", editor);

    expect(invoke).toHaveBeenCalledWith("launch_external_editor", {
      fullPath: "/repos/project",
      editor,
    });
  });

  it("preserves custom arguments and the macOS bundle identifier", async () => {
    const customEditor = {
      path: "/Applications/Custom.app",
      arguments: '--wait "%TARGET_PATH%"',
      bundleID: "example.Custom",
    };

    await launchCustomExternalEditor("/repos/a project", customEditor);

    expect(invoke).toHaveBeenCalledWith("launch_custom_external_editor", {
      fullPath: "/repos/a project",
      customEditor,
    });
  });
});

describe("custom integration validation", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("validates a path and preserves macOS bundle metadata", async () => {
    const validation: ICustomIntegrationPathValidation = {
      isValid: true,
      bundleID: "com.example.Custom",
    };
    invoke.mockResolvedValue(validation);

    await expect(validateCustomIntegrationPath("/Applications/Custom.app")).resolves.toBe(
      validation,
    );
    expect(invoke).toHaveBeenCalledWith("validate_custom_integration_path", {
      path: "/Applications/Custom.app",
    });
  });

  it("matches the Rust serializer shape", () => {
    const validation: ICustomIntegrationPathValidation = {
      isValid: true,
      bundleID: "com.example.Editor",
    };

    expect(snapshot.customIntegrationPathValidation).toEqual(validation);
  });

  it("validates the complete domain model", async () => {
    const customIntegration = {
      path: "/usr/bin/code",
      arguments: '--wait "%TARGET_PATH%"',
    };
    invoke.mockResolvedValue(true);

    await expect(isValidCustomIntegration(customIntegration)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("is_valid_custom_integration", {
      customIntegration,
    });
  });
});
