/**
 * Branch-related application state.
 *
 * Extracted verbatim from `desktop-plus/app/src/lib/app-state.ts` — see this directory's README for
 * why that module is being decomposed rather than ported wholesale.
 */

import { Branch } from '../../models/branch'
import { PullRequest } from '../../models/pull-request'
import { Tip } from '../../models/tip'

export interface IBranchesState {
  /**
   * The current tip of HEAD, either a branch, a commit (if HEAD is
   * detached) or an unborn branch (a branch with no commits).
   */
  readonly tip: Tip

  /**
   * The default branch for a given repository. Historically it's been
   * common to use 'master' as the default branch but as of September 2020
   * GitHub Desktop and GitHub.com default to using 'main' as the default branch.
   *
   * GitHub Desktop users are able to configure the `init.defaultBranch` Git
   * setting in preferences.
   *
   * GitHub.com users are able to change their default branch in the web UI.
   */
  readonly defaultBranch: Branch | null

  /**
   * The default branch of the upstream remote in a forked GitHub repository
   * with the ForkContributionTarget.Parent behavior, or null if it cannot be
   * inferred or is another kind of repository.
   */
  readonly upstreamDefaultBranch: Branch | null

  /**
   * A list of all branches (remote and local) that's currently in
   * the repository.
   */
  readonly allBranches: ReadonlyArray<Branch>

  /**
   * A list of zero to a few (at time of writing 5 but check loadRecentBranches
   * in git-store for definitive answer) branches that have been checked out
   * recently. This list is compiled by reading the reflog and tracking branch
   * switches over the last couple of thousand reflog entries.
   */
  readonly recentBranches: ReadonlyArray<Branch>

  /** The open pull requests in the repository. */
  readonly openPullRequests: ReadonlyArray<PullRequest>

  /** Are we currently loading pull requests? */
  readonly isLoadingPullRequests: boolean

  /** The pull request associated with the current branch. */
  readonly currentPullRequest: PullRequest | null

  /**
   * Is the current branch configured to rebase on pull?
   *
   * This is the value returned from git config (local or global) for `git config pull.rebase`
   *
   * If this value is not found in config, this will be `undefined` to indicate
   * that the default Git behaviour will occur.
   */
  readonly pullWithRebase?: boolean

  /** Tracking branches that have been allowed to be force-pushed within Desktop */
  readonly forcePushBranches: ReadonlyMap<string, string>
}
