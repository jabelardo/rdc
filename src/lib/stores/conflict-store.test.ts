import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppFileStatusKind, GitStatusEntry, UnmergedEntrySummary } from "../../models/status";
import type { IStatusResult } from "../git-ipc";
import { ConflictStore } from "./conflict-store";
import { getDefaultMessageStore } from "./default-message-store";
import { RemoteStore } from "./remote-store";
import { WorkingTreeStore } from "./working-tree-store";

/**
 * Conflict failures and the staging precondition are reported to the shared message store rather
 * than held on the conflict store — see MESSAGE_SYSTEM_PLAN.md Slice 6.
 */
function lastReportedMessage(): string {
  const messages = getDefaultMessageStore().state.messages;
  return messages[messages.length - 1]?.text ?? "";
}

beforeEach(() => {
  const store = getDefaultMessageStore();
  for (const message of store.state.messages) {
    store.dismiss(message.id);
  }
});

function status(conflictMarkerCount: number, mergeHeadFound = true): IStatusResult {
  return {
    currentBranch: "main",
    mergeHeadFound,
    rebaseInternalState: undefined,
    squashMsgFound: false,
    isCherryPickingHeadFound: false,
    isRevertingHeadFound: false,
    doConflictedFilesExist: true,
    files: [
      {
        path: "conflicted.txt",
        startsUnselected: false,
        status: {
          kind: AppFileStatusKind.Conflicted,
          entry: {
            kind: "conflicted",
            action: UnmergedEntrySummary.BothModified,
            us: GitStatusEntry.UpdatedButUnmerged,
            them: GitStatusEntry.UpdatedButUnmerged,
          },
          conflictMarkerCount,
        },
      },
      {
        path: "ordinary.txt",
        startsUnselected: false,
        status: { kind: AppFileStatusKind.Modified },
      },
    ],
  };
}

describe("ConflictStore", () => {
  it("loads merge state and only conflicted paths", async () => {
    const getStatus = vi.fn(async () => status(2));
    const store = new ConflictStore({ getStatus });

    await store.load("/repo");

    expect(getStatus).toHaveBeenCalledWith("/repo", true);
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      mergeInProgress: true,
      files: [expect.objectContaining({ path: "conflicted.txt" })],
      loading: false,
      loadFailed: false,
    });
    expect(store.state.files[0].resolvedInWorkingTree).toBe(false);
  });

  it("hydrates Cherry-pick and Revert recovery markers without a live operation", async () => {
    const cherryPickStore = new ConflictStore({
      getStatus: vi.fn(async () => ({ ...status(0, false), isCherryPickingHeadFound: true })),
    });
    await cherryPickStore.load("/repo");
    expect(cherryPickStore.state.recoveryOperation).toBe("cherryPick");

    const revertStore = new ConflictStore({
      getStatus: vi.fn(async () => ({ ...status(0, false), isRevertingHeadFound: true })),
    });
    await revertStore.load("/repo");
    expect(revertStore.state.recoveryOperation).toBe("revert");
  });

  it("retains an interrupted rebase as explicit recovery state", async () => {
    const store = new ConflictStore({
      getStatus: vi.fn(async () => ({
        ...status(0, false),
        rebaseInternalState: {
          targetBranch: "main",
          baseBranchTip: "base",
          originalBranchTip: "original",
        },
      })),
    });
    await store.load("/repo");
    expect(store.state.rebaseInProgress).toBe(true);
  });

  it("stages a marker-free resolution with its exact index entries and refreshes", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(status(0))
      .mockResolvedValueOnce({
        ...status(0),
        doConflictedFilesExist: false,
        files: [],
      });
    const stageResolvedConflictFiles = vi.fn(async () => undefined);
    const store = new ConflictStore({
      getStatus,
      stageResolvedConflictFiles,
    });
    await store.load("/repo");

    const staged = await store.stageResolvedFile("conflicted.txt");

    expect(staged).toBe(true);
    expect(stageResolvedConflictFiles).toHaveBeenCalledWith("/repo", [
      {
        path: "conflicted.txt",
        entries: [GitStatusEntry.UpdatedButUnmerged, GitStatusEntry.UpdatedButUnmerged],
        conflictMarkerCount: 0,
      },
    ]);
    expect(store.state).toMatchObject({
      mergeInProgress: true,
      files: [],
      stagingPath: null,
    });
  });

  it("refuses to stage a path that still has conflict markers", async () => {
    const stageResolvedConflictFiles = vi.fn(async () => undefined);
    const store = new ConflictStore({
      getStatus: vi.fn(async () => status(1)),
      stageResolvedConflictFiles,
    });
    await store.load("/repo");

    expect(await store.stageResolvedFile("conflicted.txt")).toBe(false);
    expect(stageResolvedConflictFiles).not.toHaveBeenCalled();
    expect(lastReportedMessage()).toBe(
      "Resolve all conflict markers before staging conflicted.txt.",
    );
  });

  it("publishes staging failures without losing conflict state", async () => {
    const store = new ConflictStore({
      getStatus: vi.fn(async () => status(0)),
      stageResolvedConflictFiles: vi.fn(async () => {
        throw new Error("stage failed");
      }),
    });
    await store.load("/repo");

    expect(await store.stageResolvedFile("conflicted.txt")).toBe(false);
    expect(store.state.files).toHaveLength(1);
    expect(store.state.stagingPath).toBeNull();
    expect(lastReportedMessage()).toBe("stage failed");
  });

  it("maps a structured command error to its message", async () => {
    const store = new ConflictStore({
      getStatus: vi.fn(async () => {
        throw { message: "status unavailable", isAuthFailure: false };
      }),
    });

    await store.load("/repo");

    expect(lastReportedMessage()).toBe("status unavailable");
    // The flag stays so the banner cannot claim everything is staged over an unreadable repository.
    expect(store.state.loadFailed).toBe(true);
  });

  // The duplication check from MESSAGE_SYSTEM_PLAN.md, complete: all three stores from the Phase 8b
  // screenshot. One root cause must produce one message, not three — this is what makes routing
  // everything through the toast a fix rather than a relocation. In the app the repository-
  // availability gate stops these loads before they start; this pins the behaviour for every other
  // failure they can share.
  it("reports one message when one failure reaches all three stores", async () => {
    const failure = {
      message: "failed to run git for 'getStatus' in /repo: No such file or directory (os error 2)",
      isAuthFailure: false,
    };
    const conflicts = new ConflictStore({
      getStatus: vi.fn(async () => {
        throw failure;
      }),
    });
    const remotes = new RemoteStore({
      getRemotes: vi.fn(async () => {
        throw failure;
      }),
    });
    const workingTree = new WorkingTreeStore({
      getStatus: vi.fn(async () => {
        throw failure;
      }),
    });

    await conflicts.load("/repo");
    await remotes.load("/repo");
    await workingTree.load("/repo");

    expect(getDefaultMessageStore().state.messages).toHaveLength(1);
    const [message] = getDefaultMessageStore().state.messages;
    expect(message?.text).toBe(failure.message);
    expect(message?.count).toBe(3);
  });

  describe("abortMerge", () => {
    it("abandons the merge and refreshes from the resulting status", async () => {
      const abortMerge = vi.fn(async () => undefined);
      const getStatus = vi
        .fn()
        .mockResolvedValueOnce(status(1))
        // What the repository looks like once the merge is abandoned: no merge, no conflicts.
        .mockResolvedValueOnce({
          ...status(0, false),
          files: [],
          doConflictedFilesExist: false,
        });
      const store = new ConflictStore({ getStatus, abortMerge });
      await store.load("/repo");
      expect(store.state.mergeInProgress).toBe(true);

      await expect(store.abortMerge()).resolves.toBeNull();

      expect(abortMerge).toHaveBeenCalledWith("/repo");
      expect(store.state.mergeInProgress).toBe(false);
      expect(store.state.files).toEqual([]);
    });

    // The failure is returned rather than reported: the confirmation dialog owns this action and
    // renders it inline — Convention 17.
    it("returns the failure instead of reporting it, and keeps the conflict state", async () => {
      const store = new ConflictStore({
        getStatus: vi.fn(async () => status(1)),
        abortMerge: vi.fn(async () => {
          throw new Error("merge is not in progress");
        }),
      });
      await store.load("/repo");

      await expect(store.abortMerge()).resolves.toBe("merge is not in progress");

      expect(store.state.mergeInProgress).toBe(true);
      expect(store.state.loading).toBe(false);
      expect(getDefaultMessageStore().state.messages).toEqual([]);
    });

    it("does nothing when there is no merge to abandon", async () => {
      const abortMerge = vi.fn(async () => undefined);
      const store = new ConflictStore({
        getStatus: vi.fn(async () => ({ ...status(0), mergeHeadFound: false })),
        abortMerge,
      });
      await store.load("/repo");

      await expect(store.abortMerge()).resolves.toBeNull();

      expect(abortMerge).not.toHaveBeenCalled();
    });
  });

  it("ignores stale status after switching repositories", async () => {
    let resolveOld: ((status: IStatusResult) => void) | undefined;
    const oldStatus = new Promise<IStatusResult>((resolve) => {
      resolveOld = resolve;
    });
    const getStatus = vi
      .fn()
      .mockReturnValueOnce(oldStatus)
      .mockResolvedValueOnce({
        ...status(0, false),
        doConflictedFilesExist: false,
        files: [],
      });
    const store = new ConflictStore({ getStatus });

    const oldLoad = store.load("/old");
    await store.load("/current");
    resolveOld?.(status(3));
    await oldLoad;

    expect(store.state.repositoryPath).toBe("/current");
    expect(store.state.mergeInProgress).toBe(false);
    expect(store.state.files).toEqual([]);
  });
});
