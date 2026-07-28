/**
 * Remote operations: push, fetch and pull.
 *
 * These are the first commands that need credentials, so they are also the first whose failures the UI
 * must distinguish: an authentication failure is recoverable by signing in, a network error is not.
 * {@linkcode isCommandError} plus `kind`/`isAuthFailure` is how that is told apart — see
 * {@link ./git-ipc.ts}.
 *
 * # `isBackgroundTask`
 *
 * Pass `true` for anything the user didn't initiate, such as a scheduled fetch. It is what stops a
 * credential prompt appearing unbidden, and the backend cannot infer it. It defaults to `false`
 * because a call site that hasn't thought about it is far more likely to be user-initiated.
 *
 * # What works today
 *
 * rdc supplies no credentials of its own yet — the accounts store and prompt UI are Phase 7. Until
 * then the backend declines, which makes git fall through to *its* own helpers: a repository reachable
 * over SSH with a loaded agent, or over HTTPS with a system credential manager, works now.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import type { IRemote } from '../models/remote'
import type {
  ICloneProgress,
  IFetchProgress,
  IPullProgress,
  IPushProgress,
} from '../models/progress'

/** Options for {@linkcode push}. Both default to off. */
export interface IPushOptions {
  /**
   * Overwrite the remote branch, but only if it is still where we last saw it.
   *
   * `--force-with-lease`, not `--force`: it refuses if someone else has pushed in the meantime, so it
   * cannot silently discard their work.
   *
   * Ignored when `remoteBranch` is `null` — see {@linkcode push}.
   */
  readonly forceWithLease?: boolean

  /** Skip the `pre-push` hook. */
  readonly noVerify?: boolean
}

/**
 * Pushes `localBranch` to `remoteName`.
 *
 * `remoteBranch` is the branch on the remote to push into. **`null` means the branch has no upstream
 * yet**, which sets one — and takes precedence over `forceWithLease`, because a lease against a ref
 * that doesn't exist remotely would fail and force-pushing onto a missing branch is meaningless.
 *
 * `tags` are pushed alongside the branch.
 */
export async function push(
  repositoryPath: string,
  remoteName: string,
  localBranch: string,
  remoteBranch: string | null,
  tags: ReadonlyArray<string> = [],
  options: IPushOptions = {},
  progressCallback?: (progress: IPushProgress) => void,
  isBackgroundTask = false
): Promise<void> {
  const onProgress = new Channel<IPushProgress>(progressCallback)

  return invoke<void>('push', {
    repositoryPath,
    remoteName,
    localBranch,
    remoteBranch,
    tags,
    options,
    isBackgroundTask,
    onProgress,
  })
}

/** Fetches from `remoteName`, pruning tracking refs for branches deleted upstream. */
export async function fetch(
  repositoryPath: string,
  remoteName: string,
  progressCallback?: (progress: IFetchProgress) => void,
  isBackgroundTask = false
): Promise<void> {
  const onProgress = new Channel<IFetchProgress>(progressCallback)

  return invoke<void>('fetch', {
    repositoryPath,
    remoteName,
    isBackgroundTask,
    onProgress,
  })
}

/**
 * Pulls from `remoteName`.
 *
 * When the branches have diverged and the user hasn't configured `pull.ff`, this reconciles with
 * `--ff` — fast-forward if possible, otherwise merge — rather than letting git refuse.
 */
export async function pull(
  repositoryPath: string,
  remoteName: string,
  progressCallback?: (progress: IPullProgress) => void,
  noVerify = false,
  isBackgroundTask = false
): Promise<void> {
  const onProgress = new Channel<IPullProgress>(progressCallback)

  return invoke<void>('pull', {
    repositoryPath,
    remoteName,
    noVerify,
    isBackgroundTask,
    onProgress,
  })
}

/**
 * Fast-forwards local branches to their upstreams without checking them out.
 *
 * `branches` is `[upstreamRef, localRef]` pairs — pairs rather than a record, because a ref name is an
 * arbitrary string. Branches that have diverged are left alone rather than failing the call, so this
 * is safe to run over every tracking branch.
 */
export async function fastForwardBranches(
  repositoryPath: string,
  branches: ReadonlyArray<readonly [string, string]>
): Promise<void> {
  return invoke<void>('fast_forward_branches', { repositoryPath, branches })
}

/** Additional arguments for {@linkcode clone}. */
export interface ICloneOptions {
  /** The branch to check out once the clone finishes. */
  readonly branch?: string

  /**
   * The branch name to use if the repository turns out to be empty.
   *
   * Narrower than it looks: a clone of an empty repository adopts the *source's* unborn branch name
   * when the remote advertises it, which local and modern-protocol remotes do. This only decides when
   * the remote doesn't — so it is a fallback, not the usual path.
   */
  readonly defaultBranch?: string
}

/**
 * Clones `url` into `path`, creating missing parent directories.
 *
 * `login` is inserted into the URL as userinfo, which is how the credential helper is told *which*
 * account to use for a host the user has several of. A URL that already carries userinfo is left
 * alone.
 */
export async function clone(
  url: string,
  path: string,
  login: string | null = null,
  options: ICloneOptions = {},
  progressCallback?: (progress: ICloneProgress) => void,
  isBackgroundTask = false
): Promise<void> {
  const onProgress = new Channel<ICloneProgress>(progressCallback)

  return invoke<void>('clone', {
    url,
    path,
    login,
    options,
    isBackgroundTask,
    onProgress,
  })
}

/**
 * Lists a repository's remotes, alphabetically by name.
 *
 * A path that isn't a repository resolves to an empty array rather than rejecting — the question is
 * usually "does this have remotes?", and a missing repository has none.
 *
 * Only fetch URLs are reported, even for a remote configured with a different push URL.
 */
export async function getRemotes(
  repositoryPath: string
): Promise<ReadonlyArray<IRemote>> {
  return invoke<ReadonlyArray<IRemote>>('get_remotes', { repositoryPath })
}

/** Adds a remote and resolves to it. Rejects if one of that name already exists. */
export async function addRemote(
  repositoryPath: string,
  name: string,
  url: string
): Promise<IRemote> {
  return invoke<IRemote>('add_remote', { repositoryPath, name, url })
}

/** Removes a remote. Removing one that doesn't exist succeeds. */
export async function removeRemote(
  repositoryPath: string,
  name: string
): Promise<void> {
  return invoke<void>('remove_remote', { repositoryPath, name })
}

/** Points an existing remote at a different URL. */
export async function setRemoteURL(
  repositoryPath: string,
  name: string,
  url: string
): Promise<void> {
  return invoke<void>('set_remote_url', { repositoryPath, name, url })
}

/** The fetch URL of a remote, or `null` if there is no such remote. */
export async function getRemoteURL(
  repositoryPath: string,
  name: string
): Promise<string | null> {
  return invoke<string | null>('get_remote_url', { repositoryPath, name })
}

/**
 * Asks the remote which branch its `HEAD` points at and records it locally.
 *
 * Contacts the remote. An unreachable remote does not reject, since this is usually incidental to
 * whatever the caller was really doing.
 */
export async function updateRemoteHEAD(
  repositoryPath: string,
  name: string,
  isBackgroundTask = false
): Promise<void> {
  return invoke<void>('update_remote_head', {
    repositoryPath,
    name,
    isBackgroundTask,
  })
}

/**
 * The branch a remote's `HEAD` points at, with the remote prefix stripped.
 *
 * Reads what {@linkcode updateRemoteHEAD} recorded, so it needs no network. Note a plain fetch already
 * records this when the remote advertises it.
 */
export async function getRemoteHEAD(
  repositoryPath: string,
  name: string
): Promise<string | null> {
  return invoke<string | null>('get_remote_head', { repositoryPath, name })
}
