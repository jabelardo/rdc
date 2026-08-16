import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitIdentity } from "@/models/commit-identity";
import type { IRevertProgress } from "@/models/progress";
import type { MergeTreeResult } from "@/models/merge";
import type { RepositoryType } from "@/models/repository-type";
import type { ITrailer } from "@/models/trailer";
import snapshot from "@/lib/__generated__/wire-snapshot.json";

/**
 * Checks the boundary for the smaller operations.
 *
 * Three things here need more than field-matching: tags and checkouts arrive as **pairs** and become
 * `Map`s (a name is an arbitrary string, so a plain object would collide with `Object.prototype`
 * members), checkout times cross as epoch seconds and become `Date`s, and revert progress always reports
 * zero.
 */
const invoke = vi.hoisted(() => vi.fn());
const channelInstances = vi.hoisted(() => [] as Array<{ handler?: unknown }>);

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    public handler?: unknown;
    public constructor(handler?: unknown) {
      this.handler = handler;
      channelInstances.push(this);
    }
  },
}));

const {
  createTag,
  deleteTag,
  getAllTags,
  revertCommit,
  abortRevert,
  getRecentBranches,
  getBranchCheckouts,
  getDescription,
  writeDescription,
  getAuthorIdentity,
  cleanUntrackedFiles,
  addSafeDirectory,
  getGlobalConfigPath,
  getConfigValue,
  appendIgnoreRules,
  appendIgnoreFiles,
  installGlobalLFSFilters,
  determineMergeability,
  getRepositoryType,
  getRebaseInternalState,
  mergeTrailers,
} = await import("./misc-ipc");

const REPO = "/tmp/repo";

describe("the revert progress shape", () => {
  const revertProgress = snapshot.revertProgress as IRevertProgress;

  it("always reports zero, which is faithful rather than broken", () => {
    // Upstream's parser had a single step with an empty title and zero weight, so it could never match a
    // line or compute a percentage. A revert has only text to report.
    expect(revertProgress.kind).toBe("revert");
    expect(revertProgress.value).toBe(0);
    expect(revertProgress.title).toBe("");
    expect(revertProgress.description).toBe("Auto-merging a.txt");
  });
});

describe("the smaller commands", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    channelInstances.length = 0;
  });

  // --- tags ---

  it("createTag and deleteTag send what they need", async () => {
    await createTag(REPO, "v1.0", "abc123");
    expect(invoke).toHaveBeenLastCalledWith("create_tag", {
      repositoryPath: REPO,
      name: "v1.0",
      targetCommit: "abc123",
    });

    await deleteTag(REPO, "v1.0");
    expect(invoke).toHaveBeenLastCalledWith("delete_tag", {
      repositoryPath: REPO,
      name: "v1.0",
    });
  });

  it("getAllTags turns pairs into a Map", async () => {
    invoke.mockResolvedValue([
      ["v1.0", "aaa"],
      ["v2.0", "bbb"],
    ]);

    const tags = await getAllTags(REPO);

    expect(tags).toBeInstanceOf(Map);
    expect(tags.get("v1.0")).toBe("aaa");
    expect(tags.get("v2.0")).toBe("bbb");
    expect(tags.size).toBe(2);
  });

  it("getAllTags handles a tag name that would collide with Object.prototype", async () => {
    // Why pairs and a Map rather than an object: `constructor` and `__proto__` are legal tag names.
    invoke.mockResolvedValue([
      ["constructor", "aaa"],
      ["__proto__", "bbb"],
    ]);

    const tags = await getAllTags(REPO);

    expect(tags.get("constructor")).toBe("aaa");
    expect(tags.get("__proto__")).toBe("bbb");
    expect(tags.size).toBe(2);
  });

  it("getAllTags resolves to an empty Map when there are no tags", async () => {
    invoke.mockResolvedValue([]);
    await expect(getAllTags(REPO)).resolves.toEqual(new Map());
  });

  // --- revert ---

  it("revertCommit sends the parent count and a Channel", async () => {
    // The parent count is what lets a merge commit be reverted at all.
    await revertCommit(REPO, "abc123", 2);

    expect(invoke).toHaveBeenCalledWith("revert_commit", {
      repositoryPath: REPO,
      commit: "abc123",
      parentCount: 2,
      onProgress: expect.anything(),
    });
    expect(channelInstances).toHaveLength(1);
  });

  it("abortRevert sends the repository path", async () => {
    await abortRevert(REPO);

    expect(invoke).toHaveBeenCalledWith("abort_revert", { repositoryPath: REPO });
  });

  // --- reflog ---

  it("getRecentBranches sends the limit", async () => {
    invoke.mockResolvedValue(["feature", "main"]);

    await expect(getRecentBranches(REPO, 5)).resolves.toEqual(["feature", "main"]);
    expect(invoke).toHaveBeenCalledWith("get_recent_branches", {
      repositoryPath: REPO,
      limit: 5,
    });
  });

  it("getBranchCheckouts converts the date to epoch seconds", async () => {
    invoke.mockResolvedValue([]);
    const after = new Date("2024-01-01T00:00:00.000Z");

    await getBranchCheckouts(REPO, after);

    expect(invoke).toHaveBeenCalledWith("get_branch_checkouts", {
      repositoryPath: REPO,
      after: Math.floor(after.getTime() / 1000),
    });
  });

  it("getBranchCheckouts turns pairs into a Map of Dates", async () => {
    invoke.mockResolvedValue([
      ["feature", 1690000100],
      ["main", 1690000000],
    ]);

    const checkouts = await getBranchCheckouts(REPO, new Date(0));

    expect(checkouts.get("feature")).toBeInstanceOf(Date);
    expect(checkouts.get("feature")?.getTime()).toBe(1690000100 * 1000);
    expect(checkouts.get("main")?.getTime()).toBe(1690000000 * 1000);
  });

  // --- description ---

  it("getDescription and writeDescription send what they need", async () => {
    invoke.mockResolvedValue("my project\n");
    await expect(getDescription(REPO)).resolves.toBe("my project\n");

    invoke.mockResolvedValue(undefined);
    await writeDescription(REPO, "renamed\n");
    expect(invoke).toHaveBeenLastCalledWith("write_description", {
      repositoryPath: REPO,
      description: "renamed\n",
    });
  });

  // --- identity ---

  it("getAuthorIdentity hydrates the identity into a Date-carrying class", async () => {
    invoke.mockResolvedValue({
      name: "Someone",
      email: "someone@example.com",
      date: 1475670580,
      tzOffset: 120,
    });

    const identity = await getAuthorIdentity(REPO);

    expect(identity).toBeInstanceOf(CommitIdentity);
    expect(identity?.date).toBeInstanceOf(Date);
    expect(identity?.name).toBe("Someone");
  });

  it("getAuthorIdentity resolves to null when git would refuse to invent one", async () => {
    // Meaningful rather than merely absent: a commit will fail the same way, so the caller should prompt.
    invoke.mockResolvedValue(null);
    await expect(getAuthorIdentity(REPO)).resolves.toBeNull();
  });

  // --- clean ---

  // --- safe.directory ---

  it("addSafeDirectory sends a path, not a repository", async () => {
    // git won't read a repository's own config until it trusts the path, so the remedy is global and
    // takes the path on its own.
    await addSafeDirectory("/repos/borrowed");

    expect(invoke).toHaveBeenCalledWith("add_safe_directory", {
      path: "/repos/borrowed",
    });
  });

  it("addSafeDirectory can be called twice without the caller checking", async () => {
    await addSafeDirectory("/repos/borrowed");
    await addSafeDirectory("/repos/borrowed");

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("add_safe_directory", {
      path: "/repos/borrowed",
    });
  });

  it("cleanUntrackedFiles needs only the path", async () => {
    await cleanUntrackedFiles(REPO);
    expect(invoke).toHaveBeenCalledWith("clean_untracked_files", {
      repositoryPath: REPO,
    });
    expect(channelInstances).toHaveLength(0);
  });
});

describe("mergeability, repository state and trailers", () => {
  const clean = snapshot.mergeTreeClean as MergeTreeResult;
  const conflicts = snapshot.mergeTreeConflicts as MergeTreeResult;
  const regular = snapshot.repositoryTypeRegular as RepositoryType;
  const unsafe = snapshot.repositoryTypeUnsafe as RepositoryType;
  const trailer = snapshot.trailer as ITrailer;

  it("mergeability narrows on a lowercase kind", () => {
    // The union's discriminants are the original's spellings, so ported code comparing against them works.
    expect(clean.kind).toBe("clean");
    if (conflicts.kind !== "conflicts") {
      throw new Error("narrowing failed");
    }
    expect(conflicts.conflictedFiles).toBe(3);
  });

  it("repository type carries the working directory and the git dir separately", () => {
    // Both, because a linked worktree's `.git` is a file elsewhere — one cannot be derived from the other.
    if (regular.kind !== "regular") {
      throw new Error("narrowing failed");
    }
    expect(regular.topLevelWorkingDirectory).toBe("/repos/thing");
    expect(regular.gitDir).toBe("/repos/thing/.git");
  });

  it("an unsafe repository says which path git refused", () => {
    // What addSafeDirectory needs — and the reason it takes a path rather than a repository.
    if (unsafe.kind !== "unsafe") {
      throw new Error("narrowing failed");
    }
    expect(unsafe.path).toBe("/repos/borrowed");
  });

  it("a trailer is a token and a value, nothing more", () => {
    expect(trailer.token).toBe("Co-Authored-By");
    expect(trailer.value).toContain("@");
  });
});

describe("the expose-only commands", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("getConfigValue defaults to the full cascade", async () => {
    invoke.mockResolvedValue("input");

    await expect(getConfigValue(REPO, "core.autocrlf")).resolves.toBe("input");
    expect(invoke).toHaveBeenCalledWith("get_config_value", {
      repositoryPath: REPO,
      name: "core.autocrlf",
      onlyLocal: false,
    });
  });

  it("getGlobalConfigPath has no renderer-supplied filesystem input", async () => {
    invoke.mockResolvedValue("/home/me/.gitconfig");

    await expect(getGlobalConfigPath()).resolves.toBe("/home/me/.gitconfig");
    expect(invoke).toHaveBeenCalledWith("get_global_config_path");
  });

  it("getConfigValue passes null through for an unset key", async () => {
    invoke.mockResolvedValue(null);
    await expect(getConfigValue(REPO, "nothing.here")).resolves.toBeNull();
  });

  it("appendIgnoreRules and appendIgnoreFiles are different commands", async () => {
    // Patterns are sent as written; file names get their glob characters escaped on the Rust side.
    await appendIgnoreRules(REPO, ["*.log"]);
    expect(invoke).toHaveBeenLastCalledWith("append_ignore_rules", {
      repositoryPath: REPO,
      patterns: ["*.log"],
    });

    await appendIgnoreFiles(REPO, ["weird[1].txt"]);
    expect(invoke).toHaveBeenLastCalledWith("append_ignore_files", {
      repositoryPath: REPO,
      paths: ["weird[1].txt"],
    });
  });

  it("installGlobalLFSFilters takes no repository", async () => {
    // The operation isn't about one, so asking for a path would invite a caller to think it was.
    await installGlobalLFSFilters();

    expect(invoke).toHaveBeenCalledWith("install_global_lfs_filters", {
      force: false,
    });
  });

  it("determineMergeability names both sides", async () => {
    invoke.mockResolvedValue({ kind: "clean" });

    await determineMergeability(REPO, "main", "topic");

    expect(invoke).toHaveBeenCalledWith("determine_mergeability", {
      repositoryPath: REPO,
      ours: "main",
      theirs: "topic",
    });
  });

  it("getRepositoryType takes a path, since it may not be a repository at all", async () => {
    invoke.mockResolvedValue({ kind: "missing" });

    await expect(getRepositoryType("/not/a/repo")).resolves.toEqual({
      kind: "missing",
    });
    expect(invoke).toHaveBeenCalledWith("get_repository_type", {
      path: "/not/a/repo",
    });
  });

  it("getRebaseInternalState resolves to null when no rebase is in progress", async () => {
    invoke.mockResolvedValue(null);
    await expect(getRebaseInternalState(REPO)).resolves.toBeNull();
  });

  it("mergeTrailers sends the trailers and the unfold flag", async () => {
    invoke.mockResolvedValue("message\n\nCo-Authored-By: Someone\n");

    await mergeTrailers(REPO, "message", [{ token: "Co-Authored-By", value: "Someone" }]);

    expect(invoke).toHaveBeenCalledWith("merge_trailers", {
      repositoryPath: REPO,
      commitMessage: "message",
      trailers: [{ token: "Co-Authored-By", value: "Someone" }],
      unfold: false,
    });
  });
});
