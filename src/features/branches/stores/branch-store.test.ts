import { beforeEach, describe, expect, it, vi } from "vitest";
import { Branch, BranchType } from "@/models/branch";
import { ComputedAction } from "@/models/computed-action";
import type { MergeTreeResult } from "@/models/merge";
import { MergeResult, rebaseBranch as rebaseBranchCommand, RebaseResult } from "@/lib/ipc/git-ipc";
import { BranchStore } from "./branch-store";
import { getDefaultMessageStore } from "@/features/messages/stores/default-message-store";

/** Sidebar-originated branch failures report to the shared store — MESSAGE_SYSTEM_PLAN.md Slice 4. */
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

function branch(name: string, type = BranchType.Local, upstream: string | null = null): Branch {
  return new Branch(
    name,
    upstream,
    {
      sha: name.padEnd(40, "a").slice(0, 40),
      author: { date: new Date("2026-07-30T12:00:00Z") },
    },
    type,
    type === BranchType.Local ? `refs/heads/${name}` : `refs/remotes/${name}`,
    false,
  );
}

describe("BranchStore", () => {
  it("loads all branches and the current branch together", async () => {
    const branches = [
      branch("main", BranchType.Local, "origin/main"),
      branch("topic"),
      branch("origin/main", BranchType.Remote),
    ];
    const getBranches = vi.fn(async () => branches);
    const getStatus = vi.fn(async () => ({
      currentBranch: "main",
      mergeHeadFound: false,
      squashMsgFound: false,
      isCherryPickingHeadFound: false,
      files: [],
      doConflictedFilesExist: false,
    }));
    const getRecentBranches = vi.fn(async () => ["topic", "main"]);
    const getRemotes = vi.fn(async () => [
      { name: "origin", url: "https://example.invalid/repository.git" },
    ]);
    const getRemoteHEAD = vi.fn(async () => "main");
    const store = new BranchStore({
      getBranches,
      getStatus,
      getRecentBranches,
      getRemotes,
      getRemoteHEAD,
    });

    await store.load("/repo");

    expect(getBranches).toHaveBeenCalledWith("/repo");
    expect(getStatus).toHaveBeenCalledWith("/repo", true);
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      branches,
      currentBranch: "main",
      defaultBranch: "main",
      recentBranches: ["topic", "main"],
      loading: false,
      loadFailed: false,
    });
    expect(getRecentBranches).toHaveBeenCalledWith("/repo", 6);
    expect(getRemoteHEAD).toHaveBeenCalledWith("/repo", "origin");
  });

  it("creates from HEAD, checks out, and refreshes branch facts", async () => {
    const main = branch("main");
    const feature = branch("feature");
    const getBranches = vi
      .fn()
      .mockResolvedValueOnce([main])
      .mockResolvedValueOnce([feature, main]);
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ currentBranch: "main" })
      .mockResolvedValueOnce({ currentBranch: "feature" });
    const createBranch = vi.fn(async () => undefined);
    let reportProgress:
      | ((progress: {
          kind: "checkout";
          target: string;
          value: number;
          description: string;
        }) => void)
      | undefined;
    const checkoutBranch = vi.fn(
      async (_repositoryPath: string, _name: string, callback?: typeof reportProgress) => {
        reportProgress = callback;
        callback?.({
          kind: "checkout",
          target: "feature",
          value: 0.5,
          description: "Updating files",
        });
      },
    );
    const store = new BranchStore({
      getBranches,
      getStatus,
      createBranch,
      checkoutBranch,
    });
    await store.load("/repo");

    const created = await store.createAndCheckout(" feature ");

    expect(created).toBe(true);
    expect(createBranch).toHaveBeenCalledWith("/repo", "feature", undefined, false);
    expect(checkoutBranch).toHaveBeenCalledWith("/repo", "feature", expect.any(Function));
    expect(reportProgress).toBeDefined();
    expect(store.state).toMatchObject({
      branches: [feature, main],
      currentBranch: "feature",
      operation: null,
      progress: null,
      dialogError: null,
    });
  });

  it("checks out a loaded local branch but not the current or a remote branch", async () => {
    const main = branch("main");
    const topic = branch("topic");
    const remote = branch("origin/topic", BranchType.Remote);
    const checkoutBranch = vi.fn(async () => undefined);
    const getBranches = vi.fn(async () => [main, topic, remote]);
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ currentBranch: "main" })
      .mockResolvedValue({ currentBranch: "topic" });
    const store = new BranchStore({
      getBranches,
      getStatus,
      checkoutBranch,
    });
    await store.load("/repo");

    expect(await store.checkout("main")).toBe(false);
    expect(await store.checkout("origin/topic")).toBe(false);
    expect(await store.checkout("topic")).toBe(true);
    expect(checkoutBranch).toHaveBeenCalledOnce();
    expect(checkoutBranch).toHaveBeenCalledWith("/repo", "topic", expect.any(Function));
  });

  it("rejects an empty branch name before invoking git", async () => {
    const createBranch = vi.fn(async () => undefined);
    const store = new BranchStore({ createBranch });

    expect(await store.createAndCheckout("   ")).toBe(false);
    expect(createBranch).not.toHaveBeenCalled();
    expect(lastReportedMessage()).toBe("Enter a branch name.");
  });

  it("publishes operation failures and keeps the loaded branch list", async () => {
    const main = branch("main");
    const store = new BranchStore({
      getBranches: vi.fn(async () => [main]),
      getStatus: vi.fn(async () => ({ currentBranch: "main" })),
      createBranch: vi.fn(async () => {
        throw new Error("branch exists");
      }),
    });
    await store.load("/repo");

    expect(await store.createAndCheckout("main")).toBe(false);
    expect(store.state.branches).toEqual([main]);
    // describeError unwraps the rejection where the store used to String() it.
    expect(lastReportedMessage()).toBe("branch exists");
    expect(store.state.operation).toBeNull();
  });

  it("ignores a slow load after the repository changes", async () => {
    let resolveOld: ((branches: ReadonlyArray<Branch>) => void) | undefined;
    const oldBranches = new Promise<ReadonlyArray<Branch>>((resolve) => {
      resolveOld = resolve;
    });
    const current = branch("current");
    const getBranches = vi.fn().mockReturnValueOnce(oldBranches).mockResolvedValueOnce([current]);
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ currentBranch: "old" })
      .mockResolvedValueOnce({ currentBranch: "current" });
    const store = new BranchStore({ getBranches, getStatus });

    const oldLoad = store.load("/old");
    await store.load("/current");
    resolveOld?.([branch("stale")]);
    await oldLoad;

    expect(store.state.repositoryPath).toBe("/current");
    expect(store.state.branches).toEqual([current]);
    expect(store.state.currentBranch).toBe("current");
  });

  function loadTopology(currentBranch: string | undefined, branches: Branch[]) {
    const getBranches = vi.fn(async () => branches);
    const getStatus = vi.fn(async () => ({
      currentBranch,
      mergeHeadFound: false,
      squashMsgFound: false,
      isCherryPickingHeadFound: false,
      files: [],
      doConflictedFilesExist: false,
    }));
    const getRemoteHEAD = vi.fn(async () => "main");
    const getRemotes = vi.fn(async () => [
      { name: "origin", url: "https://example.invalid/repository.git" },
    ]);
    const renameBranch = vi.fn(async () => undefined);
    const deleteLocalBranch = vi.fn(async () => undefined);
    const deleteRef = vi.fn(async () => undefined);
    const determineMergeability = vi.fn(
      async (): Promise<MergeTreeResult> => ({ kind: ComputedAction.Clean }),
    );
    const mergeBranch = vi.fn(async () => MergeResult.Success);
    const rebaseBranch = vi.fn<typeof rebaseBranchCommand>(
      async () => RebaseResult.CompletedWithoutError,
    );
    const store = new BranchStore({
      getBranches,
      getStatus,
      getRecentBranches: vi.fn(async () => []),
      getRemotes,
      getRemoteHEAD,
      renameBranch,
      deleteLocalBranch,
      deleteRef,
      determineMergeability,
      mergeBranch,
      rebaseBranch,
    });
    return {
      store,
      getBranches,
      renameBranch,
      deleteLocalBranch,
      deleteRef,
      determineMergeability,
      mergeBranch,
      rebaseBranch,
    };
  }

  it("renames a branch and refreshes branch facts", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const other = branch("other");
    const { store, getBranches, renameBranch } = loadTopology("topic", [main, topic, other]);
    await store.load("/repo");

    await expect(store.renameBranch("other", "renamed")).resolves.toBe(true);

    expect(renameBranch).toHaveBeenCalledWith("/repo", "other", "renamed", undefined);
    expect(store.state.dialogError).toBeNull();
    expect(getBranches).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid branch name without calling git", async () => {
    const topic = branch("topic");
    const { store, renameBranch } = loadTopology("topic", [topic]);
    await store.load("/repo");

    await expect(store.renameBranch("topic", "bad~name")).resolves.toBe(false);

    expect(renameBranch).not.toHaveBeenCalled();
    expect(store.state.dialogError).toContain("not a valid branch name");
  });

  it("requires a non-empty branch name to rename", async () => {
    const topic = branch("topic");
    const { store, renameBranch } = loadTopology("topic", [topic]);
    await store.load("/repo");

    await expect(store.renameBranch("topic", "   ")).resolves.toBe(false);

    expect(renameBranch).not.toHaveBeenCalled();
    expect(store.state.dialogError).toBe("Enter a branch name.");
  });

  it("rejects a rename that collides with an existing branch", async () => {
    const main = branch("main");
    const topic = branch("topic");
    const { store, renameBranch } = loadTopology("topic", [main, topic]);
    await store.load("/repo");

    await expect(store.renameBranch("topic", "main")).resolves.toBe(false);

    expect(renameBranch).not.toHaveBeenCalled();
    expect(store.state.dialogError).toContain("already exists");
  });

  it("deletes a non-current, non-default local branch", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const other = branch("other");
    const { store, deleteLocalBranch, deleteRef } = loadTopology("topic", [main, topic, other]);
    await store.load("/repo");
    expect(store.state.defaultBranch).toBe("main");

    await expect(store.deleteBranch("other")).resolves.toBe(true);

    expect(deleteLocalBranch).toHaveBeenCalledWith("/repo", "other");
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it("refuses to delete the current branch", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, deleteLocalBranch } = loadTopology("topic", [main, topic]);
    await store.load("/repo");

    await expect(store.deleteBranch("topic")).resolves.toBe(false);

    expect(deleteLocalBranch).not.toHaveBeenCalled();
    expect(store.state.dialogError).toContain("current branch");
  });

  it("refuses to delete the default branch", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, deleteLocalBranch } = loadTopology("topic", [main, topic]);
    await store.load("/repo");
    expect(store.state.defaultBranch).toBe("main");

    await expect(store.deleteBranch("main")).resolves.toBe(false);

    expect(deleteLocalBranch).not.toHaveBeenCalled();
    expect(store.state.dialogError).toContain("default branch");
  });

  it("refuses to delete a branch on an unborn or detached HEAD", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const other = branch("other");
    const { store, deleteLocalBranch } = loadTopology(undefined, [main, other]);
    await store.load("/repo");

    await expect(store.deleteBranch("other")).resolves.toBe(false);

    expect(deleteLocalBranch).not.toHaveBeenCalled();
    expect(store.state.dialogError).toContain("unborn or detached");
  });

  it("prunes the tracking ref only when opted in", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature", BranchType.Local, "origin/feature");
    const { store, deleteLocalBranch, deleteRef } = loadTopology("topic", [main, topic, feature]);
    await store.load("/repo");

    await expect(store.deleteBranch("feature", { pruneTrackingRef: true })).resolves.toBe(true);

    expect(deleteLocalBranch).toHaveBeenCalledWith("/repo", "feature");
    expect(deleteRef).toHaveBeenCalledWith("/repo", "refs/remotes/origin/feature");
  });

  it("does not touch the remote-tracking ref by default", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature", BranchType.Local, "origin/feature");
    const { store, deleteLocalBranch, deleteRef } = loadTopology("topic", [main, topic, feature]);
    await store.load("/repo");

    await expect(store.deleteBranch("feature")).resolves.toBe(true);

    expect(deleteLocalBranch).toHaveBeenCalledWith("/repo", "feature");
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it("merges a clean local branch and reports merged", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, mergeBranch, determineMergeability } = loadTopology("topic", [
      main,
      topic,
      feature,
    ]);
    await store.load("/repo");

    await expect(store.initiateMerge("feature", { workingTreeDirty: false })).resolves.toBe(
      "merged",
    );

    expect(determineMergeability).toHaveBeenCalledWith("/repo", "topic", "feature");
    expect(mergeBranch).toHaveBeenCalledWith("/repo", "feature", { squash: false });
  });

  it("passes the squash option through as one operation", async () => {
    // Not a second code path: git-ops' merge() runs `git merge --squash` and then
    // `git commit --no-edit` under the commit hooks, so the result shape is identical.
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, mergeBranch } = loadTopology("topic", [main, topic, feature]);
    await store.load("/repo");

    await expect(
      store.initiateMerge("feature", { workingTreeDirty: false, squash: true }),
    ).resolves.toBe("merged");

    expect(mergeBranch).toHaveBeenCalledWith("/repo", "feature", { squash: true });
  });

  it("reports an already-up-to-date merge", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, mergeBranch } = loadTopology("topic", [main, topic, feature]);
    mergeBranch.mockResolvedValueOnce(MergeResult.AlreadyUpToDate);
    await store.load("/repo");

    await expect(store.initiateMerge("feature", { workingTreeDirty: false })).resolves.toBe(
      "up-to-date",
    );
  });

  it("reports a merge that produces conflicts", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, mergeBranch } = loadTopology("topic", [main, topic, feature]);
    mergeBranch.mockResolvedValueOnce(MergeResult.Failed);
    await store.load("/repo");

    await expect(store.initiateMerge("feature", { workingTreeDirty: false })).resolves.toBe(
      "conflict",
    );
  });

  it("publishes blocking progress while a merge is running", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, mergeBranch } = loadTopology("topic", [main, topic, feature]);
    let finish: (() => void) | undefined;
    mergeBranch.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return MergeResult.Success;
    });
    await store.load("/repo");

    const merging = store.initiateMerge("feature", { workingTreeDirty: false });
    await vi.waitFor(() =>
      expect(store.state.progress).toEqual({
        kind: "generic",
        value: 0,
        title: "Merging changes",
      }),
    );
    expect(store.state.operation).toBe("merging");
    finish?.();
    await expect(merging).resolves.toBe("merged");
  });

  it("refuses to merge branches with unrelated histories", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, determineMergeability, mergeBranch } = loadTopology("topic", [
      main,
      topic,
      feature,
    ]);
    determineMergeability.mockResolvedValueOnce({
      kind: ComputedAction.Invalid,
    });
    await store.load("/repo");

    await expect(store.initiateMerge("feature", { workingTreeDirty: false })).resolves.toBe(
      "invalid",
    );

    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("refuses to merge over a dirty working tree", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const feature = branch("feature");
    const { store, determineMergeability, mergeBranch } = loadTopology("topic", [
      main,
      topic,
      feature,
    ]);
    await store.load("/repo");

    await expect(store.initiateMerge("feature", { workingTreeDirty: true })).resolves.toBe("dirty");

    expect(determineMergeability).not.toHaveBeenCalled();
    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("refuses to merge a branch into itself", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, mergeBranch } = loadTopology("topic", [main, topic]);
    await store.load("/repo");

    await expect(store.initiateMerge("topic", { workingTreeDirty: false })).resolves.toBe("failed");

    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("rebases the current branch onto a chosen base", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const base = branch("main");
    const { store, rebaseBranch } = loadTopology("topic", [main, topic, base]);
    await store.load("/repo");

    await expect(store.rebaseBranch("main", { workingTreeDirty: false })).resolves.toBe(
      "completed",
    );

    // target is the current branch; the picked branch is the base.
    expect(rebaseBranch).toHaveBeenCalledWith("/repo", "main", "topic", expect.any(Function));
  });

  it("publishes rebase progress while the operation is running", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const base = branch("main");
    const { store, rebaseBranch } = loadTopology("topic", [main, topic, base]);
    let finish: (() => void) | undefined;
    rebaseBranch.mockImplementation(async (...args: Parameters<typeof rebaseBranchCommand>) => {
      const onProgress = args[3];
      onProgress?.({
        kind: "multiCommitOperation",
        value: 0.5,
        title: "Rebasing",
        description: "Applying commit 1 of 2",
        position: 1,
        totalCommitCount: 2,
        currentCommitSummary: "First commit",
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return RebaseResult.CompletedWithoutError;
    });
    await store.load("/repo");

    const rebasing = store.rebaseBranch("main", { workingTreeDirty: false });
    await vi.waitFor(() =>
      expect(store.state.progress).toMatchObject({
        kind: "multiCommitOperation",
        value: 0.5,
        position: 1,
      }),
    );
    expect(store.state.operation).toBe("rebasing");
    finish?.();
    await expect(rebasing).resolves.toBe("completed");
  });

  it("reports a rebase that leaves conflicts", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, rebaseBranch } = loadTopology("topic", [main, topic]);
    rebaseBranch.mockResolvedValueOnce(RebaseResult.ConflictsEncountered);
    await store.load("/repo");

    await expect(store.rebaseBranch("main", { workingTreeDirty: false })).resolves.toBe("conflict");
  });

  it("reports a rebase that was already up to date", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, rebaseBranch } = loadTopology("topic", [main, topic]);
    rebaseBranch.mockResolvedValueOnce(RebaseResult.AlreadyUpToDate);
    await store.load("/repo");

    await expect(store.rebaseBranch("main", { workingTreeDirty: false })).resolves.toBe(
      "up-to-date",
    );
  });

  it("refuses to rebase over a dirty working tree", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, rebaseBranch } = loadTopology("topic", [main, topic]);
    await store.load("/repo");

    await expect(store.rebaseBranch("main", { workingTreeDirty: true })).resolves.toBe("dirty");

    expect(rebaseBranch).not.toHaveBeenCalled();
  });

  it("reports a git failure as a failed rebase", async () => {
    const main = branch("main", BranchType.Local, "origin/main");
    const topic = branch("topic");
    const { store, rebaseBranch } = loadTopology("topic", [main, topic]);
    rebaseBranch.mockRejectedValue(new Error("boom"));
    await store.load("/repo");

    await expect(store.rebaseBranch("main", { workingTreeDirty: false })).resolves.toBe("failed");
  });
});
