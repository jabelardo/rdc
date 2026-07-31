/**
 * The history side of the IPC boundary.
 *
 * `crates/git-ops/src/log.rs` reads commits and changesets; this module types that payload and
 * builds the `models/` classes from it.
 *
 * Same hydration split as {@link ./diff-ipc.ts}, and for a stronger reason here: `Commit` and
 * `CommittedFileChange` don't merely have methods, their **constructors derive fields**. `Commit`
 * computes `coAuthors`, `bodyNoCoAuthors`, `authoredByCommitter` and `isMergeCommit`;
 * `CommittedFileChange` computes `id`. Sending those from Rust would mean a second implementation of
 * each rule — the thing that produced the conflict-shape bug — so the wire carries the constructor
 * *arguments* and the derived fields come out of the constructor for free.
 */

import { invoke } from '@tauri-apps/api/core'
import { Commit } from '../models/commit'
import { CommitIdentity } from '../models/commit-identity'
import { CommittedFileChange, type AppFileStatus } from '../models/status'
import type { ITrailer } from '../models/trailer'

/** A {@linkcode CommitIdentity} as it arrives over IPC. */
export interface ICommitIdentityData {
  readonly name: string
  readonly email: string
  /**
   * Seconds since the Unix epoch.
   *
   * A number rather than a formatted string, so there is one representation of "when" on the wire
   * and no re-parsing here.
   */
  readonly date: number
  /**
   * Offset from UTC in minutes, positive east of Greenwich.
   *
   * Note this is the **opposite sign** to `Date.prototype.getTimezoneOffset()`. The inconsistency is
   * the original's — `parseIdentity` produced `+120` for `+0200` while the class's default parameter
   * uses `getTimezoneOffset()` — and it is preserved rather than corrected, because flipping it would
   * silently shift every timestamp the UI renders.
   */
  readonly tzOffset: number
}

/** A {@linkcode Commit} as it arrives over IPC: the constructor's arguments. */
export interface ICommitData {
  readonly sha: string
  readonly shortSha: string
  readonly summary: string
  readonly body: string
  readonly author: ICommitIdentityData
  readonly committer: ICommitIdentityData
  readonly parentSHAs: ReadonlyArray<string>
  readonly trailers: ReadonlyArray<ITrailer>
  readonly tags: ReadonlyArray<string>
}

/** A {@linkcode CommittedFileChange} as it arrives over IPC. */
export interface ICommittedFileChangeData {
  readonly path: string
  readonly status: AppFileStatus
  readonly commitish: string
  readonly parentCommitish: string
}

/** What a commit changed, and by how much. */
export interface IChangesetData {
  readonly files: ReadonlyArray<CommittedFileChange>
  readonly linesAdded: number
  readonly linesDeleted: number
}

/** {@linkcode IChangesetData} before hydration. */
export interface IChangesetDataWire {
  readonly files: ReadonlyArray<ICommittedFileChangeData>
  readonly linesAdded: number
  readonly linesDeleted: number
}

export function hydrateCommitIdentity(
  data: ICommitIdentityData
): CommitIdentity {
  // The wire carries seconds; `Date` takes milliseconds.
  return new CommitIdentity(
    data.name,
    data.email,
    new Date(data.date * 1000),
    data.tzOffset
  )
}

/**
 * Builds a {@linkcode Commit}, whose constructor derives `coAuthors`, `bodyNoCoAuthors`,
 * `authoredByCommitter` and `isMergeCommit`.
 */
export function hydrateCommit(data: ICommitData): Commit {
  return new Commit(
    data.sha,
    data.shortSha,
    data.summary,
    data.body,
    hydrateCommitIdentity(data.author),
    hydrateCommitIdentity(data.committer),
    data.parentSHAs,
    data.trailers,
    data.tags
  )
}

export function hydrateCommittedFileChange(
  data: ICommittedFileChangeData
): CommittedFileChange {
  return new CommittedFileChange(
    data.path,
    data.status,
    data.commitish,
    data.parentCommitish
  )
}

export function hydrateChangesetData(data: IChangesetDataWire): IChangesetData {
  return {
    files: data.files.map(hydrateCommittedFileChange),
    linesAdded: data.linesAdded,
    linesDeleted: data.linesDeleted,
  }
}

/**
 * Reads commits, most recent first.
 *
 * `revisionRange` is passed to `git log` as-is; omit it for the current branch. A repository with no
 * commits yields an empty array rather than rejecting — an unborn `HEAD` is a normal state.
 */
export async function getCommits(
  repositoryPath: string,
  revisionRange?: string,
  limit?: number,
  skip?: number,
  additionalArgs: ReadonlyArray<string> = []
): Promise<ReadonlyArray<Commit>> {
  const commits = await invoke<ReadonlyArray<ICommitData>>('get_commits', {
    repositoryPath,
    revisionRange,
    limit,
    skip,
    additionalArgs,
  })

  return commits.map(hydrateCommit)
}

/** Reads a single commit, or `null` if `reference` doesn't resolve to one. */
export async function getCommit(
  repositoryPath: string,
  reference: string
): Promise<Commit | null> {
  const commit = await invoke<ICommitData | null>('get_commit', {
    repositoryPath,
    reference,
  })

  return commit === null ? null : hydrateCommit(commit)
}

/** Reads the files a commit changed, with its line counts. */
export async function getChangedFiles(
  repositoryPath: string,
  sha: string
): Promise<IChangesetData> {
  const changeset = await invoke<IChangesetDataWire>('get_changed_files', {
    repositoryPath,
    sha,
  })

  return hydrateChangesetData(changeset)
}
