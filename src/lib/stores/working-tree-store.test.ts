import { describe, expect, it, vi } from "vitest";
import {
  DiffHunk,
  DiffHunkExpansionType,
  DiffHunkHeader,
  DiffLine,
  DiffLineType,
  DiffSelectionType,
  DiffType,
  type IDiff,
} from "../../models/diff";
import { AppFileStatusKind } from "../../models/status";
import type { createCommit as createCommitCommand, IStatusResult } from "../git-ipc";
import { TrashDiscardError } from "../discard-changes";
import { WorkingTreeStore } from "./working-tree-store";

function status(files: IStatusResult["files"]): IStatusResult {
  return {
    mergeHeadFound: false,
    squashMsgFound: false,
    isCherryPickingHeadFound: false,
    files,
    doConflictedFilesExist: false,
  };
}

const binaryDiff: IDiff = { kind: DiffType.Binary };
const selectableDiff: IDiff = {
  kind: DiffType.Text,
  text: "@@ -0,0 +1,2 @@\n+first\n+second",
  hunks: [
    new DiffHunk(
      new DiffHunkHeader(0, 0, 1, 2),
      [
        new DiffLine("@@ -0,0 +1,2 @@", DiffLineType.Hunk, 0, null, null),
        new DiffLine("+first", DiffLineType.Add, 1, null, 1),
        new DiffLine("+second", DiffLineType.Add, 2, null, 2),
      ],
      0,
      2,
      DiffHunkExpansionType.None,
    ),
  ],
  maxLineNumber: 2,
  hasHiddenBidiChars: false,
};

function createStore(
  getStatus: () => Promise<IStatusResult | null>,
  getWorkingDirectoryDiff = vi.fn(async () => binaryDiff),
) {
  return new WorkingTreeStore({
    getStatus,
    getWorkingDirectoryDiff,
  });
}

describe("WorkingTreeStore", () => {
  it("converts raw status facts into sorted frontend selection state", async () => {
    const getStatus = vi.fn(async () =>
      status([
        {
          path: "zeta.ts",
          status: { kind: AppFileStatusKind.Modified },
          startsUnselected: true,
        },
        {
          path: "Alpha.ts",
          status: { kind: AppFileStatusKind.Untracked },
          startsUnselected: false,
        },
      ]),
    );
    const getWorkingDirectoryDiff = vi.fn(async () => binaryDiff);
    const store = createStore(getStatus, getWorkingDirectoryDiff);

    await store.load("/repo");

    expect(getStatus).toHaveBeenCalledWith("/repo", true);
    expect(getWorkingDirectoryDiff).toHaveBeenCalledWith(
      "/repo",
      "Alpha.ts",
      { kind: AppFileStatusKind.Untracked },
      false,
    );
    expect(
      store.state.workingDirectory?.files.map((file) => ({
        path: file.path,
        selection: file.selection.getSelectionType(),
      })),
    ).toEqual([
      { path: "Alpha.ts", selection: DiffSelectionType.All },
      { path: "zeta.ts", selection: DiffSelectionType.None },
    ]);
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      selectedFileID: "Untracked+Alpha.ts",
      diff: binaryDiff,
      loading: false,
      error: null,
    });
  });

  it("reports a path that is no longer a repository as an empty tree", async () => {
    const store = createStore(vi.fn(async () => null));

    await store.load("/missing");

    expect(store.state.workingDirectory?.files).toEqual([]);
    expect(store.state.error).toBeNull();
  });

  it("publishes command failures without discarding the selected path", async () => {
    const listener = vi.fn();
    const store = createStore(
      vi.fn(async () => {
        throw new Error("status failed");
      }),
    );
    store.onDidUpdate(listener);

    await store.load("/repo");

    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      workingDirectory: null,
      loading: false,
      error: "Error: status failed",
    });
    expect(listener).toHaveBeenCalled();
  });

  it("ignores a slow response after another repository is selected", async () => {
    let resolveFirst: ((result: IStatusResult | null) => void) | undefined;
    const first = new Promise<IStatusResult | null>((resolve) => {
      resolveFirst = resolve;
    });
    const getStatus = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        status([
          {
            path: "current.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      );
    const store = createStore(getStatus);

    const staleLoad = store.load("/old");
    await store.load("/current");
    resolveFirst?.(
      status([
        {
          path: "stale.ts",
          status: { kind: AppFileStatusKind.Modified },
          startsUnselected: false,
        },
      ]),
    );
    await staleLoad;

    expect(store.state.repositoryPath).toBe("/current");
    expect(store.state.workingDirectory?.files.map((file) => file.path)).toEqual(["current.ts"]);
  });

  it("clears repository-specific state", async () => {
    const store = createStore(vi.fn(async () => status([])));
    await store.load("/repo");

    store.clear();

    expect(store.state).toEqual({
      repositoryPath: null,
      workingDirectory: null,
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      commitLoading: false,
      commitError: null,
      hookFailure: null,
      runningHook: null,
      loading: false,
      error: null,
      mergeHeadFound: false,
    });
  });

  it("loads a selected file and ignores a diff that returns after selection changes", async () => {
    let resolveFirstDiff: ((diff: IDiff) => void) | undefined;
    const firstDiff = new Promise<IDiff>((resolve) => {
      resolveFirstDiff = resolve;
    });
    const textDiff: IDiff = {
      kind: DiffType.Text,
      text: "+current",
      hunks: [],
      maxLineNumber: 1,
      hasHiddenBidiChars: false,
    };
    const getWorkingDirectoryDiff = vi
      .fn()
      .mockReturnValueOnce(firstDiff)
      .mockResolvedValueOnce(textDiff);
    const store = createStore(
      vi.fn(async () =>
        status([
          {
            path: "first.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
          {
            path: "second.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      ),
      getWorkingDirectoryDiff,
    );

    const initialLoad = store.load("/repo");
    await vi.waitFor(() => expect(store.state.diffLoading).toBe(true));
    const secondID = "Modified+second.ts";
    await store.selectFile(secondID);
    resolveFirstDiff?.(binaryDiff);
    await initialLoad;

    expect(store.state).toMatchObject({
      selectedFileID: secondID,
      diff: textDiff,
      diffLoading: false,
      diffError: null,
    });
  });

  it("preserves whole-file inclusion across a status refresh", async () => {
    const file = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Modified } as const,
      startsUnselected: false,
    };
    const store = createStore(vi.fn(async () => status([file])));

    await store.load("/repo");
    store.setFileIncluded("Modified+file.ts", false);
    await store.load("/repo");

    expect(store.state.workingDirectory?.files[0].selection.getSelectionType()).toBe(
      DiffSelectionType.None,
    );
    expect(store.state.workingDirectory?.includeAll).toBe(false);
  });

  it("includes or excludes every file from the Changes summary control", async () => {
    const store = createStore(
      vi.fn(async () =>
        status([
          {
            path: "first.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
          {
            path: "second.ts",
            status: { kind: AppFileStatusKind.Untracked },
            startsUnselected: true,
          },
        ]),
      ),
    );
    await store.load("/repo");

    store.setAllFilesIncluded(false);
    expect(
      store.state.workingDirectory?.files.map((file) => file.selection.getSelectionType()),
    ).toEqual([DiffSelectionType.None, DiffSelectionType.None]);

    store.setAllFilesIncluded(true);
    expect(
      store.state.workingDirectory?.files.map((file) => file.selection.getSelectionType()),
    ).toEqual([DiffSelectionType.All, DiffSelectionType.All]);
  });

  it("tracks only includeable diff lines in frontend selection state", async () => {
    const store = createStore(
      vi.fn(async () =>
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Untracked },
            startsUnselected: false,
          },
        ]),
      ),
      vi.fn(async () => selectableDiff),
    );

    await store.load("/repo");
    store.setLineIncluded(2, false);

    const file = store.state.workingDirectory?.files[0];
    expect(file?.selection.getSelectionType()).toBe(DiffSelectionType.Partial);
    expect(file?.selection.getSelectedLines()).toEqual([1]);

    store.setLineIncluded(0, false);
    expect(store.state.workingDirectory?.files[0].selection.getSelectedLines()).toEqual([1]);
  });

  it("sends partial line selection through the existing commit command", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Untracked },
            startsUnselected: false,
          },
        ]),
      )
      .mockResolvedValueOnce(status([]));
    const createCommit = vi.fn(async () => "a".repeat(40));
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => selectableDiff),
      createCommit,
    });
    await store.load("/repo");
    store.setLineIncluded(2, false);

    await store.commit("partial");

    expect(createCommit).toHaveBeenCalledWith(
      "/repo",
      "partial",
      [
        {
          path: "file.ts",
          partial: {
            status: { kind: AppFileStatusKind.Untracked },
            selectedLines: [1],
          },
        },
      ],
      undefined,
      expect.objectContaining({
        interceptHooks: true,
        onHookFailure: expect.any(Function),
      }),
      expect.any(Function),
    );
  });

  it("commits only included files with rename and deletion facts", async () => {
    const initialStatus = status([
      {
        path: "after.ts",
        status: {
          kind: AppFileStatusKind.Renamed,
          oldPath: "before.ts",
          renameIncludesModifications: false,
        },
        startsUnselected: false,
      },
      {
        path: "deleted.ts",
        status: { kind: AppFileStatusKind.Deleted },
        startsUnselected: false,
      },
      {
        path: "excluded.ts",
        status: { kind: AppFileStatusKind.Modified },
        startsUnselected: false,
      },
    ]);
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValueOnce(status([]));
    const createCommit = vi.fn(async () => "a".repeat(40));
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      createCommit,
    });
    await store.load("/repo");
    store.setFileIncluded("Modified+excluded.ts", false);

    await expect(store.commit("  selected files  ")).resolves.toBe("a".repeat(40));

    expect(createCommit).toHaveBeenCalledWith(
      "/repo",
      "selected files",
      [
        { path: "after.ts", oldPath: "before.ts" },
        { path: "deleted.ts", deleted: true },
      ],
      undefined,
      expect.objectContaining({
        interceptHooks: true,
        onHookFailure: expect.any(Function),
      }),
      expect.any(Function),
    );
    expect(store.state.workingDirectory?.files).toEqual([]);
    expect(store.state.commitError).toBeNull();
  });

  it("requires a message and at least one included file", async () => {
    const createCommit = vi.fn(async () => "a".repeat(40));
    const store = new WorkingTreeStore({
      getStatus: vi.fn(async () =>
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      ),
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      createCommit,
    });
    await store.load("/repo");

    await expect(store.commit("   ")).resolves.toBeNull();
    expect(store.state.commitError).toBe("Enter a commit message.");

    store.setFileIncluded("Modified+file.ts", false);
    await expect(store.commit("message")).resolves.toBeNull();
    expect(store.state.commitError).toBe("Include at least one file.");
    expect(createCommit).not.toHaveBeenCalled();
  });

  it("waits for and applies the failed-hook decision", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      )
      .mockResolvedValueOnce(status([]));
    const createCommit = vi.fn((...args: Parameters<typeof createCommitCommand>) => {
      const failure = args[4]?.onHookFailure;
      if (failure === undefined) {
        throw new Error("hook interception was not enabled");
      }
      return failure("pre-commit", "lint failed\n").then((resolution) => {
        if (resolution === "abort") {
          throw new Error("commit aborted by hook");
        }
        return "a".repeat(40);
      });
    });
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      createCommit,
    });
    await store.load("/repo");

    const committing = store.commit("message");
    await vi.waitFor(() =>
      expect(store.state.hookFailure).toEqual({
        hook: "pre-commit",
        terminalOutput: "lint failed\n",
      }),
    );
    expect(store.state.commitLoading).toBe(true);

    store.resolveHookFailure("ignore");

    await expect(committing).resolves.toBe("a".repeat(40));
    expect(store.state.hookFailure).toBeNull();
    expect(createCommit).toHaveBeenCalledWith(
      "/repo",
      "message",
      [{ path: "file.ts" }],
      undefined,
      expect.objectContaining({
        interceptHooks: true,
        onHookFailure: expect.any(Function),
      }),
      expect.any(Function),
    );
  });

  it("tracks a running hook and keeps the failure handoff after it stops", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      )
      .mockResolvedValueOnce(status([]));
    const createCommit = vi.fn((...args: Parameters<typeof createCommitCommand>) => {
      const hooks = args[4];
      if (
        hooks === undefined ||
        hooks.onHookProgress === undefined ||
        hooks.onHookFailure === undefined
      ) {
        throw new Error("hook interception was not enabled");
      }
      hooks.onHookProgress({ id: 12, hook: "pre-commit", status: "started" });
      hooks.onHookProgress({ id: 12, hook: "pre-commit", status: "failed" });
      return hooks.onHookFailure("pre-commit", "stopped by user\n").then((resolution) => {
        if (resolution === "abort") {
          throw new Error("commit aborted by hook");
        }
        return "a".repeat(40);
      });
    });
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      createCommit,
    });
    await store.load("/repo");

    const committing = store.commit("message");
    await vi.waitFor(() =>
      expect(store.state.hookFailure).toEqual({
        hook: "pre-commit",
        terminalOutput: "stopped by user\n",
      }),
    );
    expect(store.state.runningHook).toBeNull();

    store.resolveHookFailure("ignore");
    await expect(committing).resolves.toBe("a".repeat(40));
  });

  it("bypasses hooks with noVerify instead of changing their environment", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      )
      .mockResolvedValueOnce(status([]));
    const createCommit = vi.fn(async () => "a".repeat(40));
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      createCommit,
    });
    await store.load("/repo");

    await store.commit("message", true);

    expect(createCommit).toHaveBeenCalledWith(
      "/repo",
      "message",
      [{ path: "file.ts" }],
      { noVerify: true },
      undefined,
      expect.any(Function),
    );
  });

  it("discards one current file and refreshes the working tree", async () => {
    const changed = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Modified } as const,
      startsUnselected: false,
    };
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(status([changed]))
      .mockResolvedValueOnce(status([]));
    const discardChanges = vi.fn(async () => undefined);
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges,
    });
    await store.load("/repo");
    const selectedFile = store.state.workingDirectory?.files[0];

    await expect(store.discardFile("Modified+file.ts")).resolves.toBe("discarded");

    expect(discardChanges).toHaveBeenCalledWith("/repo", [selectedFile], {
      permanentlyDelete: false,
    });
    expect(store.state.workingDirectory?.files).toEqual([]);
  });

  it("keeps a failed discard visible and does not refresh status", async () => {
    const getStatus = vi.fn(async () =>
      status([
        {
          path: "file.ts",
          status: { kind: AppFileStatusKind.Modified },
          startsUnselected: false,
        },
      ]),
    );
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges: vi.fn(async () => {
        throw new Error("trash unavailable");
      }),
    });
    await store.load("/repo");

    await expect(store.discardFile("Modified+file.ts")).resolves.toBe("failed");

    expect(getStatus).toHaveBeenCalledOnce();
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      error: "Error: trash unavailable",
    });
  });

  it("distinguishes a trash failure so the UI can request permanent deletion", async () => {
    const getStatus = vi.fn(async () =>
      status([
        {
          path: "file.ts",
          status: { kind: AppFileStatusKind.Untracked },
          startsUnselected: false,
        },
      ]),
    );
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges: vi.fn(async (_repositoryPath, files) => {
        throw new TrashDiscardError(files[0], new Error("unavailable"));
      }),
    });
    await store.load("/repo");

    await expect(store.discardFile("Untracked+file.ts")).resolves.toBe("trash-failed");

    expect(store.state.error).toBeNull();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("discards the whole working tree, ignoring inclusion state", async () => {
    const changed = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Modified } as const,
      startsUnselected: false,
    };
    const untracked = {
      path: "new.ts",
      status: { kind: AppFileStatusKind.Untracked } as const,
      startsUnselected: false,
    };
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(status([changed, untracked]))
      .mockResolvedValueOnce(status([]));
    const discardChanges = vi.fn(async () => undefined);
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges,
    });
    await store.load("/repo");
    // Excluding one file must not stop "discard all" from discarding it.
    store.setFileIncluded("Modified+file.ts", false);
    const files = store.state.workingDirectory?.files ?? [];

    await expect(store.discardAllChanges()).resolves.toBe("discarded");

    expect(discardChanges).toHaveBeenCalledWith("/repo", files, {
      permanentlyDelete: false,
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("discards the whole working tree with permanent deletion", async () => {
    const changed = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Modified } as const,
      startsUnselected: false,
    };
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(status([changed]))
      .mockResolvedValueOnce(status([]));
    const discardChanges = vi.fn(async () => undefined);
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges,
    });
    await store.load("/repo");
    const files = store.state.workingDirectory?.files ?? [];

    await expect(store.discardAllChanges(true)).resolves.toBe("discarded");

    expect(discardChanges).toHaveBeenCalledWith("/repo", files, {
      permanentlyDelete: true,
    });
  });

  it("is a no-op on a clean working tree", async () => {
    const getStatus = vi.fn(async () => status([]));
    const discardChanges = vi.fn(async () => undefined);
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges,
    });
    await store.load("/repo");

    await expect(store.discardAllChanges()).resolves.toBe("discarded");

    expect(discardChanges).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("refuses whole-tree discard while a merge is in progress", async () => {
    const changed = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Modified } as const,
      startsUnselected: false,
    };
    const getStatus = vi.fn(async () => ({
      ...status([changed]),
      mergeHeadFound: true,
    }));
    const discardChanges = vi.fn(async () => undefined);
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges,
    });
    await store.load("/repo");
    expect(store.state.mergeHeadFound).toBe(true);

    await expect(store.discardAllChanges()).resolves.toBe("merge-in-progress");

    expect(discardChanges).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("keeps whole-tree discard failures visible and the status unrefreshed", async () => {
    const changed = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Modified } as const,
      startsUnselected: false,
    };
    const getStatus = vi.fn(async () => status([changed]));
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges: vi.fn(async () => {
        throw new Error("trash unavailable");
      }),
    });
    await store.load("/repo");

    await expect(store.discardAllChanges()).resolves.toBe("failed");

    expect(getStatus).toHaveBeenCalledOnce();
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      error: "Error: trash unavailable",
    });
  });

  it("distinguishes a whole-tree trash failure for the permanent fallback", async () => {
    const changed = {
      path: "file.ts",
      status: { kind: AppFileStatusKind.Untracked } as const,
      startsUnselected: false,
    };
    const getStatus = vi.fn(async () => status([changed]));
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      discardChanges: vi.fn(async (_repositoryPath, files) => {
        throw new TrashDiscardError(files[0], new Error("unavailable"));
      }),
    });
    await store.load("/repo");

    await expect(store.discardAllChanges()).resolves.toBe("trash-failed");

    expect(store.state.error).toBeNull();
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("discards selected lines against the exact displayed diff", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      )
      .mockResolvedValueOnce(status([]));
    const discardChangesFromSelection = vi.fn(async () => undefined);
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => selectableDiff),
      discardChangesFromSelection,
    });
    await store.load("/repo");
    store.setLineIncluded(2, false);
    const discard = store.getSelectedLinesDiscard();
    store.setLineIncluded(1, false);

    await expect(store.discardSelectedLines(discard)).resolves.toBe(true);

    expect(discardChangesFromSelection).toHaveBeenCalledWith(
      "/repo",
      "file.ts",
      selectableDiff,
      [1],
    );
    expect(store.state.workingDirectory?.files).toEqual([]);
  });

  it("streams, replays and clears commit terminal output", async () => {
    let finishCommit: ((sha: string) => void) | undefined;
    const createCommit = vi.fn(
      async (_repositoryPath, _message, _files, _options, _hooks, onTerminalOutput) => {
        onTerminalOutput?.("pre-commit output");
        return new Promise<string>((resolve) => {
          finishCommit = resolve;
        });
      },
    );
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(
        status([
          {
            path: "file.ts",
            status: { kind: AppFileStatusKind.Modified },
            startsUnselected: false,
          },
        ]),
      )
      .mockResolvedValueOnce(status([]));
    const store = new WorkingTreeStore({
      getStatus,
      getWorkingDirectoryDiff: vi.fn(async () => binaryDiff),
      createCommit,
    });
    await store.load("/repo");
    const live = vi.fn();
    store.onCommitTerminalOutput(live);

    const committing = store.commit("message");
    await vi.waitFor(() => expect(live).toHaveBeenLastCalledWith("pre-commit output"));
    const late = vi.fn();
    store.onCommitTerminalOutput(late);
    expect(late).toHaveBeenCalledWith("pre-commit output");

    finishCommit?.("a".repeat(40));
    await committing;

    expect(live).toHaveBeenLastCalledWith("");
    expect(late).toHaveBeenLastCalledWith("");
  });
});
