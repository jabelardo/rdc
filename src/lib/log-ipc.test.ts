import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Commit } from '../models/commit'
import { CommitIdentity } from '../models/commit-identity'
import { AppFileStatusKind, CommittedFileChange } from '../models/status'
import snapshot from './__generated__/wire-snapshot.json'
import type { IChangesetDataWire, ICommitData } from './log-ipc'
import {
  hydrateChangesetData,
  hydrateCommit,
  hydrateCommitIdentity,
} from './log-ipc'

/**
 * Checks the history boundary.
 *
 * The fixtures come from `wire_contract.rs`, so hydration runs against Rust's real serializer output.
 * What makes this worth testing beyond field-matching is that `Commit`'s constructor **derives**
 * `coAuthors`, `bodyNoCoAuthors`, `authoredByCommitter` and `isMergeCommit`, and
 * `CommittedFileChange` derives `id`. Those rules exist once, in TypeScript; the tests below prove
 * the wire payload is enough to run them.
 */
const commitData = snapshot.commit as ICommitData
const changesetData = snapshot.changesetData as IChangesetDataWire

describe('the history wire shape', () => {
  it('hydrates a commit into the ported Commit class', () => {
    const commit = hydrateCommit(commitData)

    expect(commit).toBeInstanceOf(Commit)
    expect(commit.sha).toBe(commitData.sha)
    expect(commit.shortSha).toBe('aaaaaaa')
    expect(commit.summary).toBe('Fix the thing')
    expect(commit.author).toBeInstanceOf(CommitIdentity)
  })

  it('turns epoch seconds into a Date', () => {
    // The wire carries seconds; Date takes milliseconds. Getting this wrong is a factor-of-1000
    // error that puts every commit in 1970.
    const identity = hydrateCommitIdentity(commitData.author)

    expect(identity.date).toBeInstanceOf(Date)
    expect(identity.date.getTime()).toBe(1475670580 * 1000)
    expect(identity.date.getUTCFullYear()).toBe(2016)
  })

  it('keeps the timezone offset as sent, including its sign', () => {
    // Deliberately NOT normalised to getTimezoneOffset()'s convention — see the note in log-ipc.ts.
    expect(hydrateCommitIdentity(commitData.author).tzOffset).toBe(120)
    expect(hydrateCommitIdentity(commitData.committer).tzOffset).toBe(-480)
  })

  it('derives the fields the Commit constructor owns', () => {
    // The payload carries constructor arguments only; these four come from the constructor. If Rust
    // ever started sending them, there would be two implementations of each.
    const commit = hydrateCommit(commitData)

    expect(commit.coAuthors).toHaveLength(1)
    expect(commit.coAuthors[0].email).toBe('someone@example.com')
    expect(commit.bodyNoCoAuthors).not.toContain('Co-Authored-By')
    expect(commit.bodyNoCoAuthors).toContain('longer explanation')
    expect(commit.isMergeCommit).toBe(false)
    // The fixture's author and committer differ.
    expect(commit.authoredByCommitter).toBe(false)
  })

  it('recognizes a merge commit from its parent count', () => {
    const merge = hydrateCommit({
      ...commitData,
      parentSHAs: ['a'.repeat(40), 'b'.repeat(40)],
    })
    expect(merge.isMergeCommit).toBe(true)

    const root = hydrateCommit({ ...commitData, parentSHAs: [] })
    expect(root.isMergeCommit).toBe(false)
  })

  it('reports a commit authored by its committer', () => {
    const same = hydrateCommit({
      ...commitData,
      committer: commitData.author,
    })
    expect(same.authoredByCommitter).toBe(true)
  })

  it('spells the parent field parentSHAs on the wire', () => {
    // The one field whose JSON name is not plain camelCase, because the TypeScript class spells it
    // that way. A rename to `parentShas` would leave parentSHAs undefined and every commit looking
    // like a root commit.
    expect('parentSHAs' in commitData).toBe(true)
    expect(commitData.parentSHAs).toHaveLength(1)
  })

  it('carries trailers in the ported ITrailer shape', () => {
    expect(commitData.trailers).toEqual([
      {
        token: 'Co-Authored-By',
        value: 'Someone <someone@example.com>',
      },
    ])
  })

  it('hydrates a changeset into CommittedFileChange objects', () => {
    const changeset = hydrateChangesetData(changesetData)

    expect(changeset.files).toHaveLength(2)
    expect(changeset.files[0]).toBeInstanceOf(CommittedFileChange)
    expect(changeset.linesAdded).toBe(12)
    expect(changeset.linesDeleted).toBe(3)
  })

  it('gives changeset files the id their constructor derives', () => {
    const [modified, renamed] = hydrateChangesetData(changesetData).files

    // A plain change is keyed on kind and path; a rename also includes the old path, so moving a
    // file does not collide with whatever now occupies its old location.
    expect(modified.id).toBe('Modified+src/thing.ts')
    expect(renamed.id).toBe('Renamed+after+before')
  })

  it('reuses the status types from models/status', () => {
    const [modified, renamed] = changesetData.files

    expect(modified.status.kind).toBe(AppFileStatusKind.Modified)
    expect(renamed.status.kind).toBe(AppFileStatusKind.Renamed)
    if (renamed.status.kind === AppFileStatusKind.Renamed) {
      expect(renamed.status.oldPath).toBe('before')
      expect(renamed.status.renameIncludesModifications).toBe(true)
    }
  })
})

// --- command names and arguments ---

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { getCommits, getCommit, getChangedFiles } = await import('./log-ipc')

const REPO = '/tmp/repo'

describe('the history commands', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('getCommits sends the optional arguments as undefined when omitted', async () => {
    invoke.mockResolvedValue([])

    await getCommits(REPO)

    expect(invoke).toHaveBeenCalledWith('get_commits', {
      repositoryPath: REPO,
      revisionRange: undefined,
      limit: undefined,
      skip: undefined,
      additionalArgs: [],
    })
  })

  it('getCommits forwards a range, limit and skip', async () => {
    invoke.mockResolvedValue([])

    await getCommits(REPO, 'HEAD', 50, 10, ['--author=me'])

    expect(invoke).toHaveBeenCalledWith('get_commits', {
      repositoryPath: REPO,
      revisionRange: 'HEAD',
      limit: 50,
      skip: 10,
      additionalArgs: ['--author=me'],
    })
  })

  it('getCommits hydrates what it receives', async () => {
    invoke.mockResolvedValue([commitData])

    const [commit] = await getCommits(REPO)

    expect(commit).toBeInstanceOf(Commit)
    expect(commit.isMergeCommit).toBe(false)
  })

  it('getCommit returns null rather than a Commit when nothing resolves', async () => {
    invoke.mockResolvedValue(null)
    expect(await getCommit(REPO, 'HEAD')).toBeNull()

    invoke.mockResolvedValue(commitData)
    expect(await getCommit(REPO, 'HEAD')).toBeInstanceOf(Commit)
    expect(invoke).toHaveBeenLastCalledWith('get_commit', {
      repositoryPath: REPO,
      reference: 'HEAD',
    })
  })

  it('getChangedFiles hydrates the changeset', async () => {
    invoke.mockResolvedValue(changesetData)

    const changeset = await getChangedFiles(REPO, 'abc123')

    expect(invoke).toHaveBeenCalledWith('get_changed_files', {
      repositoryPath: REPO,
      sha: 'abc123',
    })
    expect(changeset.files[0]).toBeInstanceOf(CommittedFileChange)
  })
})
