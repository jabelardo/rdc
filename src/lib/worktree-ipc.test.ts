import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeEntry } from "../models/worktree";
import { getWorktreeDescription, getWorktreeDisplayName } from "../models/worktree";
import snapshot from "./__generated__/wire-snapshot.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const {
  listWorktrees,
  listWorktreesFromGitDir,
  listWorktreesFromGitDirFallback,
  addWorktree,
  removeWorktree,
  moveWorktree,
} = await import("./worktree-ipc");

// Annotated, not cast: assignability to the ported model is the check.
const worktree: WorktreeEntry = snapshot.worktreeEntry as WorktreeEntry;

const REPO = "/tmp/repo";

describe("the worktree wire shape", () => {
  it("needs no hydration — every field is plain data", () => {
    expect(worktree.path).toBe("/repos/thing");
    expect(worktree.head).toHaveLength(40);
    expect(worktree.type).toBe("main");
    expect(worktree.isDetached).toBe(false);
  });

  it("feeds the display helpers the model already has", () => {
    // The proof the shape is usable rather than merely well-typed: these are what the UI renders.
    expect(getWorktreeDisplayName(worktree)).toBe("thing");
    expect(getWorktreeDescription(worktree)).toBe("main");
  });

  it("sends a full ref name, so a detached HEAD is distinguishable", () => {
    // `branch` is `string | null`, and the description falls back to a short SHA when it is null.
    expect(worktree.branch).toBe("refs/heads/main");
    expect(getWorktreeDescription({ ...worktree, branch: null, isDetached: true })).toHaveLength(7);
  });
});

describe("the worktree commands", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue([]);
  });

  it("lists by repository, by git directory, and by reading the files directly", async () => {
    // Three entry points because a linked worktree's `.git` is a file elsewhere: there are states where only
    // the git directory is left, and states git itself can no longer enumerate.
    await listWorktrees(REPO);
    expect(invoke).toHaveBeenLastCalledWith("list_worktrees", {
      repositoryPath: REPO,
    });

    await listWorktreesFromGitDir("/repos/thing/.git");
    expect(invoke).toHaveBeenLastCalledWith("list_worktrees_from_git_dir", {
      gitDir: "/repos/thing/.git",
    });

    await listWorktreesFromGitDirFallback("/repos/thing/.git");
    expect(invoke).toHaveBeenLastCalledWith("list_worktrees_from_git_dir_fallback", {
      gitDir: "/repos/thing/.git",
    });
  });

  it("addWorktree distinguishes a new branch from an existing revision", async () => {
    await addWorktree(REPO, "/tmp/wt", { createBranch: "topic" });
    expect(invoke).toHaveBeenLastCalledWith("add_worktree", {
      repositoryPath: REPO,
      path: "/tmp/wt",
      createBranch: "topic",
      commitish: undefined,
    });

    await addWorktree(REPO, "/tmp/wt", { commitish: "main" });
    expect(invoke).toHaveBeenLastCalledWith(
      "add_worktree",
      expect.objectContaining({ createBranch: undefined, commitish: "main" }),
    );
  });

  it("removeWorktree defaults to refusing one with changes", async () => {
    // git's own default, and the one to keep unless the user has been asked.
    await removeWorktree(REPO, "/tmp/wt");

    expect(invoke).toHaveBeenCalledWith("remove_worktree", {
      repositoryPath: REPO,
      worktree: "/tmp/wt",
      force: false,
    });
  });

  it("moveWorktree sends both paths", async () => {
    await moveWorktree(REPO, "/tmp/old", "/tmp/new");

    expect(invoke).toHaveBeenCalledWith("move_worktree", {
      repositoryPath: REPO,
      oldPath: "/tmp/old",
      newPath: "/tmp/new",
    });
  });
});
