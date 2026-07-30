import type { Commit } from '../../models/commit'
import type { IDiff } from '../../models/diff'
import type { IChangesetData } from '../log-ipc'
import { getCommitDiff } from '../diff-ipc'
import { getChangedFiles, getCommits } from '../log-ipc'

const CommitBatchSize = 100

export type HistoryState = {
  readonly repositoryPath: string | null
  readonly commits: ReadonlyArray<Commit>
  readonly selectedCommitSHA: string | null
  readonly changeset: IChangesetData | null
  readonly selectedFileID: string | null
  readonly loading: boolean
  readonly error: string | null
  readonly detailsLoading: boolean
  readonly detailsError: string | null
  readonly diff: IDiff | null
  readonly diffLoading: boolean
  readonly diffError: string | null
}

type HistoryStoreDependencies = {
  readonly getCommits: typeof getCommits
  readonly getChangedFiles: typeof getChangedFiles
  readonly getCommitDiff: typeof getCommitDiff
}

const defaultDependencies: HistoryStoreDependencies = {
  getCommits,
  getChangedFiles,
  getCommitDiff,
}

const EmptyState: HistoryState = {
  repositoryPath: null,
  commits: [],
  selectedCommitSHA: null,
  changeset: null,
  selectedFileID: null,
  loading: false,
  error: null,
  detailsLoading: false,
  detailsError: null,
  diff: null,
  diffLoading: false,
  diffError: null,
}

/**
 * Own the first Phase 7c history batch for the selected repository.
 *
 * Upstream stores commits in a SHA lookup beside an ordered SHA list because
 * its advanced history surfaces share them. The MVP list has one consumer, so
 * retaining the hydrated commits in order is the same information without
 * introducing a cache architecture before another consumer needs it.
 */
export class HistoryStore {
  private currentState = EmptyState
  private requestID = 0
  private detailsRequestID = 0
  private diffRequestID = 0
  private readonly dependencies: HistoryStoreDependencies
  private readonly listeners = new Set<
    (state: HistoryState) => void
  >()

  public constructor(
    dependencies: Partial<HistoryStoreDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  public get state(): HistoryState {
    return this.currentState
  }

  public onDidUpdate(
    listener: (state: HistoryState) => void
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async load(repositoryPath: string): Promise<void> {
    const requestID = ++this.requestID
    const previousSelection =
      this.currentState.repositoryPath === repositoryPath
        ? this.currentState.selectedCommitSHA
        : null
    this.update({
      repositoryPath,
      commits: [],
      selectedCommitSHA: null,
      changeset: null,
      selectedFileID: null,
      loading: true,
      error: null,
      detailsLoading: false,
      detailsError: null,
      diff: null,
      diffLoading: false,
      diffError: null,
    })

    try {
      const commits = await this.dependencies.getCommits(
        repositoryPath,
        'HEAD',
        CommitBatchSize,
        0
      )
      if (requestID !== this.requestID) {
        return
      }
      const selectedCommitSHA =
        commits.find(commit => commit.sha === previousSelection)?.sha ??
        commits[0]?.sha ??
        null
      this.update({
        repositoryPath,
        commits,
        selectedCommitSHA,
        changeset: null,
        selectedFileID: null,
        loading: false,
        error: null,
        detailsLoading: false,
        detailsError: null,
        diff: null,
        diffLoading: false,
        diffError: null,
      })
      if (selectedCommitSHA !== null) {
        await this.loadSelectedCommitDetails(
          requestID,
          selectedCommitSHA
        )
      }
    } catch (error) {
      if (requestID !== this.requestID) {
        return
      }
      this.update({
        repositoryPath,
        commits: [],
        selectedCommitSHA: null,
        changeset: null,
        selectedFileID: null,
        loading: false,
        error: String(error),
        detailsLoading: false,
        detailsError: null,
        diff: null,
        diffLoading: false,
        diffError: null,
      })
    }
  }

  public async selectCommit(sha: string): Promise<void> {
    if (!this.currentState.commits.some(commit => commit.sha === sha)) {
      return
    }
    if (
      this.currentState.selectedCommitSHA === sha &&
      this.currentState.changeset !== null
    ) {
      return
    }
    this.update({
      ...this.currentState,
      selectedCommitSHA: sha,
      changeset: null,
      selectedFileID: null,
      detailsError: null,
      diff: null,
      diffLoading: false,
      diffError: null,
    })
    await this.loadSelectedCommitDetails(this.requestID, sha)
  }

  public async selectFile(id: string): Promise<void> {
    const state = this.currentState
    const file = state.changeset?.files.find(file => file.id === id)
    if (
      file === undefined ||
      state.repositoryPath === null ||
      state.selectedCommitSHA === null
    ) {
      return
    }

    this.update({
      ...state,
      selectedFileID: id,
      diff: null,
      diffError: null,
    })
    await this.loadSelectedFileDiff(
      this.requestID,
      this.detailsRequestID,
      state.selectedCommitSHA,
      id
    )
  }

  public clear(): void {
    this.requestID++
    this.detailsRequestID++
    this.diffRequestID++
    this.update(EmptyState)
  }

  private async loadSelectedCommitDetails(
    requestID: number,
    sha: string
  ): Promise<void> {
    const repositoryPath = this.currentState.repositoryPath
    if (repositoryPath === null) {
      return
    }
    const detailsRequestID = ++this.detailsRequestID
    this.diffRequestID++
    this.update({
      ...this.currentState,
      changeset: null,
      selectedFileID: null,
      detailsLoading: true,
      detailsError: null,
      diff: null,
      diffLoading: false,
      diffError: null,
    })

    try {
      const changeset = await this.dependencies.getChangedFiles(
        repositoryPath,
        sha
      )
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        this.currentState.selectedCommitSHA !== sha
      ) {
        return
      }
      const selectedFileID = changeset.files[0]?.id ?? null
      this.update({
        ...this.currentState,
        changeset,
        selectedFileID,
        detailsLoading: false,
        detailsError: null,
      })
      if (selectedFileID !== null) {
        await this.loadSelectedFileDiff(
          requestID,
          detailsRequestID,
          sha,
          selectedFileID
        )
      }
    } catch (error) {
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        this.currentState.selectedCommitSHA !== sha
      ) {
        return
      }
      this.update({
        ...this.currentState,
        changeset: null,
        selectedFileID: null,
        detailsLoading: false,
        detailsError: String(error),
        diff: null,
        diffLoading: false,
        diffError: null,
      })
    }
  }

  private async loadSelectedFileDiff(
    requestID: number,
    detailsRequestID: number,
    sha: string,
    fileID: string
  ): Promise<void> {
    const state = this.currentState
    const repositoryPath = state.repositoryPath
    const file = state.changeset?.files.find(file => file.id === fileID)
    if (repositoryPath === null || file === undefined) {
      return
    }
    const diffRequestID = ++this.diffRequestID
    this.update({
      ...state,
      diff: null,
      diffLoading: true,
      diffError: null,
    })

    try {
      const diff = await this.dependencies.getCommitDiff(
        repositoryPath,
        file.path,
        file.status,
        file.commitish,
        false
      )
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        diffRequestID !== this.diffRequestID ||
        this.currentState.selectedCommitSHA !== sha ||
        this.currentState.selectedFileID !== fileID
      ) {
        return
      }
      this.update({
        ...this.currentState,
        diff,
        diffLoading: false,
        diffError: null,
      })
    } catch (error) {
      if (
        requestID !== this.requestID ||
        detailsRequestID !== this.detailsRequestID ||
        diffRequestID !== this.diffRequestID ||
        this.currentState.selectedCommitSHA !== sha ||
        this.currentState.selectedFileID !== fileID
      ) {
        return
      }
      this.update({
        ...this.currentState,
        diff: null,
        diffLoading: false,
        diffError: String(error),
      })
    }
  }

  private update(state: HistoryState): void {
    this.currentState = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
