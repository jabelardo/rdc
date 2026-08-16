import { beforeEach, describe, expect, it, vi } from "vitest";
import { Commit } from "@/models/commit";
import { CommitIdentity } from "@/models/commit-identity";
import { DiffType, type IDiff } from "@/models/diff/diff-data";
import { AppFileStatusKind, CommittedFileChange } from "@/models/status";
import { HistoryStore } from "./history-store";
import { getDefaultMessageStore } from "@/lib/messages/default-message-store";

/** History failures are reported to the shared message store — MESSAGE_SYSTEM_PLAN.md Slice 3. */
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

function commit(sha: string, summary: string): Commit {
  const identity = new CommitIdentity(
    "Mona Lisa",
    "mona@example.com",
    new Date("2026-07-30T12:00:00Z"),
    0,
  );
  return new Commit(sha, sha.slice(0, 7), summary, "", identity, identity, [], [], []);
}

function changedFile(path: string, commitish = "a".repeat(40)): CommittedFileChange {
  return new CommittedFileChange(
    path,
    { kind: AppFileStatusKind.Modified },
    commitish,
    `${commitish}^`,
  );
}

const textDiff: IDiff = {
  kind: DiffType.Text,
  text: "diff",
  hunks: [],
  maxLineNumber: 1,
  hasHiddenBidiChars: false,
};

describe("HistoryStore", () => {
  it("loads upstreams first 100 HEAD commits and selects the newest", async () => {
    const commits = [commit("a".repeat(40), "newest"), commit("b".repeat(40), "older")];
    const getCommits = vi.fn(async () => commits);
    const store = new HistoryStore({ getCommits });

    await store.load("/repo");

    expect(getCommits).toHaveBeenCalledWith("/repo", "HEAD", 100, 0);
    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      commits,
      selectedCommitSHA: commits[0].sha,
      loading: false,
      loadFailed: false,
    });
  });

  it("treats an unborn branch as an empty history", async () => {
    const store = new HistoryStore({
      getCommits: vi.fn(async () => []),
    });

    await store.load("/repo");

    expect(store.state.commits).toEqual([]);
    expect(store.state.selectedCommitSHA).toBeNull();
    expect(store.state.loadFailed).toBe(false);
  });

  it("preserves a selected commit when refreshing the same history", async () => {
    const first = commit("a".repeat(40), "first");
    const selected = commit("b".repeat(40), "selected");
    const newest = commit("c".repeat(40), "newest");
    const getCommits = vi
      .fn()
      .mockResolvedValueOnce([first, selected])
      .mockResolvedValueOnce([newest, first, selected]);
    const store = new HistoryStore({ getCommits });
    await store.load("/repo");
    store.selectCommit(selected.sha);

    await store.load("/repo");

    expect(store.state.selectedCommitSHA).toBe(selected.sha);
  });

  it("ignores a slow response after another repository is selected", async () => {
    let resolveFirst: ((commits: ReadonlyArray<Commit>) => void) | undefined;
    const first = new Promise<ReadonlyArray<Commit>>((resolve) => {
      resolveFirst = resolve;
    });
    const current = commit("c".repeat(40), "current");
    const getCommits = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([current]);
    const store = new HistoryStore({ getCommits });

    const staleLoad = store.load("/old");
    await store.load("/current");
    resolveFirst?.([commit("d".repeat(40), "stale")]);
    await staleLoad;

    expect(store.state.repositoryPath).toBe("/current");
    expect(store.state.commits).toEqual([current]);
  });

  it("publishes failures without losing the repository path", async () => {
    const store = new HistoryStore({
      getCommits: vi.fn(async () => {
        throw new Error("history failed");
      }),
    });

    await store.load("/repo");

    expect(store.state).toMatchObject({
      repositoryPath: "/repo",
      commits: [],
      selectedCommitSHA: null,
      loading: false,
      loadFailed: true,
    });
  });

  it("selects only a commit in the loaded batch and clears repository state", async () => {
    const loaded = commit("a".repeat(40), "loaded");
    const store = new HistoryStore({
      getCommits: vi.fn(async () => [loaded]),
    });
    await store.load("/repo");

    store.selectCommit("missing");
    expect(store.state.selectedCommitSHA).toBe(loaded.sha);
    store.clear();

    expect(store.state).toMatchObject({
      repositoryPath: null,
      commits: [],
      selectedCommitSHA: null,
    });
  });

  it("loads the selected commits changeset and first file diff", async () => {
    const selected = commit("a".repeat(40), "selected");
    const firstFile = changedFile("first.ts", selected.sha);
    const secondFile = changedFile("second.ts", selected.sha);
    const getChangedFiles = vi.fn(async () => ({
      files: [firstFile, secondFile],
      linesAdded: 7,
      linesDeleted: 2,
    }));
    const getCommitDiff = vi.fn(async () => textDiff);
    const store = new HistoryStore({
      getCommits: vi.fn(async () => [selected]),
      getChangedFiles,
      getCommitDiff,
    });

    await store.load("/repo");

    expect(getChangedFiles).toHaveBeenCalledWith("/repo", selected.sha);
    expect(getCommitDiff).toHaveBeenCalledWith(
      "/repo",
      firstFile.path,
      firstFile.status,
      firstFile.commitish,
      false,
    );
    expect(store.state).toMatchObject({
      changeset: {
        files: [firstFile, secondFile],
        linesAdded: 7,
        linesDeleted: 2,
      },
      selectedFileID: firstFile.id,
      detailsLoading: false,
      diff: textDiff,
      diffLoading: false,
      diffFailed: false,
    });
  });

  it("selects another changed file and loads its commit diff", async () => {
    const selected = commit("a".repeat(40), "selected");
    const firstFile = changedFile("first.ts", selected.sha);
    const secondFile = changedFile("second.ts", selected.sha);
    const getCommitDiff = vi.fn(async () => textDiff);
    const store = new HistoryStore({
      getCommits: vi.fn(async () => [selected]),
      getChangedFiles: vi.fn(async () => ({
        files: [firstFile, secondFile],
        linesAdded: 2,
        linesDeleted: 1,
      })),
      getCommitDiff,
    });
    await store.load("/repo");

    await store.selectFile(secondFile.id);

    expect(getCommitDiff).toHaveBeenLastCalledWith(
      "/repo",
      secondFile.path,
      secondFile.status,
      secondFile.commitish,
      false,
    );
    expect(store.state.selectedFileID).toBe(secondFile.id);
  });

  it("ignores stale commit details after a newer commit is selected", async () => {
    const first = commit("a".repeat(40), "first");
    const second = commit("b".repeat(40), "second");
    let resolveFirst:
      | ((changeset: {
          files: ReadonlyArray<CommittedFileChange>;
          linesAdded: number;
          linesDeleted: number;
        }) => void)
      | undefined;
    const firstChangeset = new Promise<{
      files: ReadonlyArray<CommittedFileChange>;
      linesAdded: number;
      linesDeleted: number;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondFile = changedFile("second.ts", second.sha);
    const getChangedFiles = vi
      .fn()
      .mockReturnValueOnce(firstChangeset)
      .mockResolvedValueOnce({
        files: [secondFile],
        linesAdded: 1,
        linesDeleted: 0,
      });
    const store = new HistoryStore({
      getCommits: vi.fn(async () => [first, second]),
      getChangedFiles,
      getCommitDiff: vi.fn(async () => textDiff),
    });

    const initialLoad = store.load("/repo");
    await Promise.resolve();
    await store.selectCommit(second.sha);
    resolveFirst?.({
      files: [changedFile("stale.ts", first.sha)],
      linesAdded: 99,
      linesDeleted: 99,
    });
    await initialLoad;

    expect(store.state.selectedCommitSHA).toBe(second.sha);
    expect(store.state.changeset?.files).toEqual([secondFile]);
  });

  it("keeps commit details visible when its first file diff fails", async () => {
    const selected = commit("a".repeat(40), "selected");
    const file = changedFile("broken.ts", selected.sha);
    const store = new HistoryStore({
      getCommits: vi.fn(async () => [selected]),
      getChangedFiles: vi.fn(async () => ({
        files: [file],
        linesAdded: 1,
        linesDeleted: 1,
      })),
      getCommitDiff: vi.fn(async () => {
        throw new Error("diff failed");
      }),
    });

    await store.load("/repo");

    expect(store.state.changeset?.files).toEqual([file]);
    expect(store.state.diff).toBeNull();
    expect(store.state.diffFailed).toBe(true);
    // describeError now unwraps it, where the store used to String() the rejection.
    expect(lastReportedMessage()).toBe("diff failed");
  });
});
