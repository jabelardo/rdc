import { describe, expect, it, vi } from "vitest";
import { DiffSelection, DiffSelectionType } from "@/models/diff/diff-selection";
import { GitResetMode } from "@/models/git-reset-mode";
import { IndexStatus } from "@/models/index-status";
import { AppFileStatusKind, WorkingDirectoryFileChange } from "@/models/status";
import { discardChanges, TrashDiscardError } from "./discard-changes";
import type { PathFailure } from "@/platform/files";

function file(
  path: string,
  status: WorkingDirectoryFileChange["status"],
): WorkingDirectoryFileChange {
  return new WorkingDirectoryFileChange(
    path,
    status,
    DiffSelection.fromInitialSelection(DiffSelectionType.All),
  );
}

function dependencies() {
  return {
    moveRepositoryPathsToTrash: vi.fn(async (): Promise<ReadonlyArray<PathFailure>> => []),
    permanentlyDeleteRepositoryPaths: vi.fn(async (): Promise<ReadonlyArray<PathFailure>> => []),
    getIndexChanges: vi.fn(async () => [
      ["new-name.ts", IndexStatus.Added] as const,
      ["old-name.ts", IndexStatus.Deleted] as const,
      ["module", IndexStatus.Modified] as const,
    ]),
    listSubmodules: vi.fn(async () => [{ path: "module", sha: "a".repeat(40), describe: null }]),
    resetSubmodulePaths: vi.fn(async () => undefined),
    resetPaths: vi.fn(async () => undefined),
    checkoutIndex: vi.fn(async () => undefined),
  };
}

describe("discardChanges", () => {
  it("trashes recoverable files and restores Git and submodule paths", async () => {
    const deps = dependencies();
    const files = [
      file("modified.ts", { kind: AppFileStatusKind.Modified }),
      file("deleted.ts", { kind: AppFileStatusKind.Deleted }),
      file("untracked.ts", { kind: AppFileStatusKind.Untracked }),
      file("new-name.ts", {
        kind: AppFileStatusKind.Renamed,
        oldPath: "old-name.ts",
        renameIncludesModifications: false,
      }),
      file("module", {
        kind: AppFileStatusKind.Modified,
        submoduleStatus: {
          commitChanged: true,
          modifiedChanges: true,
          untrackedChanges: false,
        },
      }),
    ];

    await discardChanges("/repo", files, {}, deps);

    // One batched call, not one round-trip per file.
    expect(deps.moveRepositoryPathsToTrash).toHaveBeenCalledOnce();
    expect(deps.moveRepositoryPathsToTrash).toHaveBeenCalledWith("/repo", [
      "modified.ts",
      "untracked.ts",
      "new-name.ts",
    ]);
    expect(deps.resetSubmodulePaths).toHaveBeenCalledWith("/repo", ["module"]);
    expect(deps.resetPaths).toHaveBeenCalledWith("/repo", GitResetMode.Mixed, "HEAD", [
      "new-name.ts",
      "old-name.ts",
      "module",
    ]);
    expect(deps.checkoutIndex).toHaveBeenCalledWith("/repo", [
      "modified.ts",
      "deleted.ts",
      "untracked.ts",
      "old-name.ts",
      "module",
    ]);
  });

  it("does not make an unrecoverable fallback when trash fails", async () => {
    const deps = dependencies();
    deps.moveRepositoryPathsToTrash.mockResolvedValue([
      { path: "untracked.ts", message: "trash unavailable" },
    ]);

    await expect(
      discardChanges(
        "/repo",
        [
          file("untracked.ts", {
            kind: AppFileStatusKind.Untracked,
          }),
        ],
        {},
        deps,
      ),
    ).rejects.toBeInstanceOf(TrashDiscardError);

    expect(deps.permanentlyDeleteRepositoryPaths).not.toHaveBeenCalled();
    // Nothing survived the removal, so there is no git work to do at all.
    expect(deps.resetPaths).not.toHaveBeenCalled();
    expect(deps.checkoutIndex).not.toHaveBeenCalled();
  });

  it("finishes the git half for the files that were removed when only some fail", async () => {
    // The old per-file loop threw on the first failure, leaving every file it had already trashed
    // gone from the working tree with the index and HEAD untouched — a state git could not explain.
    const deps = dependencies();
    deps.getIndexChanges.mockResolvedValue([]);
    deps.listSubmodules.mockResolvedValue([]);
    deps.moveRepositoryPathsToTrash.mockResolvedValue([
      { path: "locked.ts", message: "permission denied" },
    ]);

    await expect(
      discardChanges(
        "/repo",
        [
          file("fine.ts", { kind: AppFileStatusKind.Modified }),
          file("locked.ts", { kind: AppFileStatusKind.Modified }),
          file("also-fine.ts", { kind: AppFileStatusKind.Modified }),
        ],
        {},
        deps,
      ),
    ).rejects.toBeInstanceOf(TrashDiscardError);

    // The failed path is excluded; the rest are restored so the tree is consistent.
    expect(deps.checkoutIndex).toHaveBeenCalledWith("/repo", ["fine.ts", "also-fine.ts"]);
  });

  it("reports how many paths failed, naming the first", async () => {
    const deps = dependencies();
    deps.listSubmodules.mockResolvedValue([]);
    deps.moveRepositoryPathsToTrash.mockResolvedValue([
      { path: "one.ts", message: "permission denied" },
      { path: "two.ts", message: "permission denied" },
    ]);

    const failure = await discardChanges(
      "/repo",
      [
        file("one.ts", { kind: AppFileStatusKind.Modified }),
        file("two.ts", { kind: AppFileStatusKind.Modified }),
      ],
      {},
      deps,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TrashDiscardError);
    expect((failure as TrashDiscardError).failureCount).toBe(2);
    expect((failure as TrashDiscardError).message).toContain("2 files");
    expect((failure as TrashDiscardError).message).toContain("one.ts");
  });

  it("permanently removes only untracked files after explicit confirmation", async () => {
    const deps = dependencies();
    deps.getIndexChanges.mockResolvedValue([]);

    await discardChanges(
      "/repo",
      [
        file("modified.ts", { kind: AppFileStatusKind.Modified }),
        file("untracked.ts", { kind: AppFileStatusKind.Untracked }),
        file("deleted.ts", { kind: AppFileStatusKind.Deleted }),
      ],
      { permanentlyDelete: true },
      deps,
    );

    expect(deps.moveRepositoryPathsToTrash).not.toHaveBeenCalled();
    expect(deps.permanentlyDeleteRepositoryPaths).toHaveBeenCalledOnce();
    expect(deps.permanentlyDeleteRepositoryPaths).toHaveBeenCalledWith("/repo", ["untracked.ts"]);
    expect(deps.checkoutIndex).toHaveBeenCalledWith("/repo", [
      "modified.ts",
      "untracked.ts",
      "deleted.ts",
    ]);
  });
});
