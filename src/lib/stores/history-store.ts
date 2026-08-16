import type { Commit } from "@/models/commit";
import type { IDiff } from "@/models/diff";
import type { IChangesetData } from "@/lib/log-ipc";
import { getCommitDiff } from "@/lib/diff-ipc";
import { getChangedFiles, getCommits } from "@/lib/log-ipc";
import { describeError, reportErrorMessage } from "@/lib/format-error";

const CommitBatchSize = 100;

export type HistoryState = {
  readonly repositoryPath: string | null;
  readonly commits: ReadonlyArray<Commit>;
  readonly selectedCommitSHA: string | null;
  readonly changeset: IChangesetData | null;
  readonly selectedFileID: string | null;
  readonly loading: boolean;
  /**
   * Whether the last history read failed.
   *
   * A boolean, not the message: the message goes to the shared message store. The flag stays
   * because the list *branches* on it — with no commits and no signal it would say "No commits
   * yet." over a history it could not read.
   */
  readonly loadFailed: boolean;
  readonly detailsLoading: boolean;
  readonly diff: IDiff | null;
  readonly diffLoading: boolean;
  /**
   * Whether the last commit-diff read failed.
   *
   * Needed for the same reason as `loadFailed`, and *not* needed for commit details: a failed
   * details read already falls through to an honest "Commit details are unavailable.", because the
   * store clears `changeset` too. A failed diff would instead invite the user to select a file that
   * is already selected.
   */
  readonly diffFailed: boolean;
};

type HistoryStoreDependencies = {
  readonly getCommits: typeof getCommits;
  readonly getChangedFiles: typeof getChangedFiles;
  readonly getCommitDiff: typeof getCommitDiff;
};

const defaultDependencies: HistoryStoreDependencies = {
  getCommits,
  getChangedFiles,
  getCommitDiff,
};

const EmptyState: HistoryState = {
  repositoryPath: null,
  commits: [],
  selectedCommitSHA: null,
  changeset: null,
  selectedFileID: null,
  loading: false,
  loadFailed: false,
  detailsLoading: false,
  diff: null,
  diffLoading: false,
  diffFailed: false,
};

/**
 * Own the first Phase 7c history batch for the selected repository.
 *
 * Upstream stores commits in a SHA lookup beside an ordered SHA list because
 * its advanced history surfaces share them. The MVP list has one consumer, so
 * retaining the hydrated commits in order is the same information without
 * introducing a cache architecture before another consumer needs it.
 */
export class HistoryStore {
  private currentState = EmptyState;
  private requestID = 0;
  private detailsRequestID = 0;
  private diffRequestID = 0;
  private readonly dependencies: HistoryStoreDependencies;
  private readonly listeners = new Set<(state: HistoryState) => void>();

  public constructor(dependencies: Partial<HistoryStoreDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public get state(): HistoryState {
    return this.currentState;
  }

  public onDidUpdate(listener: (state: HistoryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async load(repositoryPath: string): Promise<void> {
    const requestID = ++this.requestID;
    const previousSelection =
      this.currentState.repositoryPath === repositoryPath
        ? this.currentState.selectedCommitSHA
        : null;
    this.update({
      repositoryPath,
      commits: [],
      selectedCommitSHA: null,
      changeset: null,
      selectedFileID: null,
      loading: true,
      loadFailed: false,
      detailsLoading: false,
      diff: null,
      diffLoading: false,
      diffFailed: false,
    });

    try {
      const commits = await this.dependencies.getCommits(
        repositoryPath,
        "HEAD",
        CommitBatchSize,
        0,
      );
      if (requestID !== this.requestID) {
        return;
      }
      const selectedCommitSHA =
        commits.find((commit) => commit.sha === previousSelection)?.sha ?? commits[0]?.sha ?? null;
      this.update({
        repositoryPath,
        commits,
        selectedCommitSHA,
        changeset: null,
        selectedFileID: null,
        loading: false,
        loadFailed: false,
        detailsLoading: false,
        diff: null,
        diffLoading: false,
        diffFailed: false,
      });
      if (selectedCommitSHA !== null) {
        await this.loadSelectedCommitDetails(requestID, selectedCommitSHA);
      }
    } catch (error) {
      if (requestID !== this.requestID) {
        return;
      }
      reportErrorMessage(describeError(error));
      this.update({
        repositoryPath,
        commits: [],
        selectedCommitSHA: null,
        changeset: null,
        selectedFileID: null,
        loading: false,
        loadFailed: true,
        detailsLoading: false,
        diff: null,
        diffLoading: false,
        diffFailed: false,
      });
    }
  }

  public async selectCommit(sha: string): Promise<void> {
    if (!this.currentState.commits.some((commit) => commit.sha === sha)) {
      return;
    }
    if (this.currentState.selectedCommitSHA === sha && this.currentState.changeset !== null) {
      return;
    }
    this.update({
      ...this.currentState,
      selectedCommitSHA: sha,
      changeset: null,
      selectedFileID: null,
      diff: null,
      diffLoading: false,
      diffFailed: false,
    });
    await this.loadSelectedCommitDetails(this.requestID, sha);
  }

  public async selectFile(id: string): Promise<void> {
    const state = this.currentState;
    const file = state.changeset?.files.find((file) => file.id === id);
    if (file === undefined || state.repositoryPath === null || state.selectedCommitSHA === null) {
      return;
    }

    this.update({
      ...state,
      selectedFileID: id,
      diff: null,
      diffFailed: false,
    });
    await this.loadSelectedFileDiff(
      this.requestID,
      this.detailsRequestID,
      state.selectedCommitSHA,
      id,
    );
  }

  public clear(): void {
    this.requestID++;
    this.detailsRequestID++;
    this.diffRequestID++;
    this.update(EmptyState);
  }

  private async loadSelectedCommitDetails(requestID: number, sha: string): Promise<void> {
    const repositoryPath = this.currentState.repositoryPath;
    if (repositoryPath === null) {
      return;
    }
    const detailsRequestID = ++this.detailsRequestID;
    this.diffRequestID++;
    this.update({
      ...this.currentState,
      changeset: null,
      selectedFileID: null,
      detailsLoading: true,
      diff: null,
      diffLoading: false,
      diffFailed: false,
    });

    try {
      const changeset = await this.dependencies.getChangedFiles(repositoryPath, sha);
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        this.currentState.selectedCommitSHA !== sha
      ) {
        return;
      }
      const selectedFileID = changeset.files[0]?.id ?? null;
      this.update({
        ...this.currentState,
        changeset,
        selectedFileID,
        detailsLoading: false,
      });
      if (selectedFileID !== null) {
        await this.loadSelectedFileDiff(requestID, detailsRequestID, sha, selectedFileID);
      }
    } catch (error) {
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        this.currentState.selectedCommitSHA !== sha
      ) {
        return;
      }
      reportErrorMessage(describeError(error));
      this.update({
        ...this.currentState,
        changeset: null,
        selectedFileID: null,
        detailsLoading: false,
        diff: null,
        diffLoading: false,
        diffFailed: false,
      });
    }
  }

  private async loadSelectedFileDiff(
    requestID: number,
    detailsRequestID: number,
    sha: string,
    fileID: string,
  ): Promise<void> {
    const state = this.currentState;
    const repositoryPath = state.repositoryPath;
    const file = state.changeset?.files.find((file) => file.id === fileID);
    if (repositoryPath === null || file === undefined) {
      return;
    }
    const diffRequestID = ++this.diffRequestID;
    this.update({
      ...state,
      diff: null,
      diffLoading: true,
      diffFailed: false,
    });

    try {
      const diff = await this.dependencies.getCommitDiff(
        repositoryPath,
        file.path,
        file.status,
        file.commitish,
        false,
      );
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        diffRequestID !== this.diffRequestID ||
        this.currentState.selectedCommitSHA !== sha ||
        this.currentState.selectedFileID !== fileID
      ) {
        return;
      }
      this.update({
        ...this.currentState,
        diff,
        diffLoading: false,
        diffFailed: false,
      });
    } catch (error) {
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        diffRequestID !== this.diffRequestID ||
        this.currentState.selectedCommitSHA !== sha ||
        this.currentState.selectedFileID !== fileID
      ) {
        return;
      }
      reportErrorMessage(describeError(error));
      this.update({
        ...this.currentState,
        diff: null,
        diffLoading: false,
        diffFailed: true,
      });
    }
  }

  private update(state: HistoryState): void {
    this.currentState = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
