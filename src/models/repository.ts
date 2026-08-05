/**
 * MIGRATION NOTE — this model was redesigned rather than ported verbatim.
 *
 * The original performed IO. `Repository.url` was a *synchronous* getter that fired an un-awaited
 * `getRemotes()` git subprocess and returned a private field that hadn't been populated yet:
 *
 * ```ts
 * public get url(): string | null {
 *   if (this._url === null) { this.fetchUrl() }  // fire-and-forget
 *   return this._url                              // so the first read is always null
 * }
 * ```
 *
 * Three problems: the first read always returned `null`; every read before the promise settled
 * spawned *another* `git remote` process; and the promise had no `.catch`, so failures surfaced as
 * unhandled rejections. It also made a domain model depend on the entire git layer, which is what
 * kept five tests unportable for three phases.
 *
 * So `url` is now a plain readonly field, supplied by whoever loads the repository (the repositories
 * store, from a Rust query). A data type cannot do IO, which makes the bug unrepresentable rather
 * than merely fixed.
 *
 * `resolvedGitDir` was also dropped. It was `gitDir ?? join(path, '.git')`, which is simply wrong for
 * worktrees and submodules, where `.git` is a *file* pointing elsewhere. Every one of its consumers
 * was in `lib/git/**` or `git-store.ts` — all Rust-bound — and Rust resolves it correctly by asking
 * git (`rev_parse::resolve_git_dir`). Nothing in TypeScript needs it.
 */

import { GitHubRepository, ForkedGitHubRepository } from "./github-repository";
import { IAheadBehind } from "./branch";
import { WorktreeEntry } from "./worktree";
import { WorkflowPreferences, ForkContributionTarget } from "./workflow-preferences";
import { UpdateBranchStrategy } from "../lib/update-branch-strategy";
import { assertNever, fatalError } from "../lib/fatal-error";
import { createEqualityHash } from "./equality-hash";
import { isTrustedRemoteHost } from "../lib/trusted-remote-host";
import { EditorOverride } from "./editor-override";
import { basename } from "../lib/path-utils";

export enum LoginSpecialValue {
  ForceNullLogin = 1,
}

function getBaseName(path: string): string {
  const baseName = basename(path);

  if (baseName.length === 0) {
    // the repository is at the root of the drive
    // -> show the full path here to show _something_
    return path;
  }

  return baseName;
}

/** A local repository. */
export class Repository {
  public readonly name: string;

  /**
   * A hash of the properties of the object.
   *
   * Objects with the same hash are guaranteed to be structurally equal.
   */
  public hash: string;

  /**
   * @param path The working directory of this repository
   * @param missing Was the repository missing on disk last we checked?
   */
  public constructor(
    public readonly path: string,
    public readonly id: number,
    public readonly gitHubRepository: GitHubRepository | null,
    public readonly missing: boolean,
    public readonly alias: string | null = null,
    public readonly groupName: string | null = null,
    public readonly defaultBranch: string | null = null,
    public readonly workflowPreferences: WorkflowPreferences = {},
    public readonly customEditorOverride: EditorOverride | null = null,
    /**
     * True if the repository is a tutorial repository created as part of the
     * onboarding flow. Tutorial repositories trigger a tutorial user experience
     * which introduces new users to some core concepts of Git and GitHub.
     */
    public readonly isTutorialRepository: boolean = false,
    public readonly overrideLogin: string | LoginSpecialValue | null = null,
    /**
     * The path to the .git directory for this repository, or undefined if it
     * hasn't been resolved yet (e.g. for repositories added before this
     * property was introduced).
     */
    public readonly gitDir: string | undefined = undefined,
    /**
     * The URL of this repository's default remote, or `null` when it isn't known.
     *
     * Supplied by whoever loads the repository — it is a live git fact, not user configuration, so
     * the model only carries it. See the migration note at the top of this file for why this
     * replaced a self-resolving getter.
     *
     * Deliberately excluded from `hash`: two repositories that differ only in a value fetched from
     * git are still the same repository, and including it would invalidate equality checks whenever
     * a remote was reconfigured.
     */
    public readonly url: string | null = null,
  ) {
    this.name = (gitHubRepository && gitHubRepository.name) || getBaseName(path);

    this.hash = createEqualityHash(
      path,
      this.id,
      gitHubRepository?.hash,
      this.missing,
      this.alias,
      this.groupName,
      this.defaultBranch,
      getCustomOverrideHash(this.customEditorOverride),
      this.workflowPreferences.forkContributionTarget,
      this.workflowPreferences.updateBranchStrategy,
      this.isTutorialRepository,
      this.overrideLogin,
    );
  }

  public get login(): string | null {
    if (this.overrideLogin != null) {
      return this.overrideLogin && this.overrideLogin !== LoginSpecialValue.ForceNullLogin
        ? this.overrideLogin
        : null;
    } else {
      return this.gitHubRepository?.login ?? null;
    }
  }
}

/** Identical to `Repository`, except it **must** have a `gitHubRepository` */
export type RepositoryWithGitHubRepository = Repository & {
  readonly gitHubRepository: GitHubRepository;
};

/**
 * Identical to `Repository`, except it **must** have a `gitHubRepository`
 * which in turn must have a parent. In other words this is a GitHub (.com
 * or Enterprise) fork.
 */
export type RepositoryWithForkedGitHubRepository = Repository & {
  readonly gitHubRepository: ForkedGitHubRepository;
};

/**
 * Returns whether the passed repository is a GitHub repository.
 *
 * This function narrows down the type of the passed repository to
 * RepositoryWithGitHubRepository if it returns true.
 */
export function isRepositoryWithGitHubRepository(
  repository: Repository,
): repository is RepositoryWithGitHubRepository {
  return repository.gitHubRepository instanceof GitHubRepository;
}

/**
 * Asserts that the passed repository is a GitHub repository.
 */
export function assertIsRepositoryWithGitHubRepository(
  repository: Repository,
): asserts repository is RepositoryWithGitHubRepository {
  if (!isRepositoryWithGitHubRepository(repository)) {
    return fatalError(`Repository must be GitHub repository`);
  }
}

/**
 * Returns whether the passed repository is a GitHub fork.
 *
 * This function narrows down the type of the passed repository to
 * RepositoryWithForkedGitHubRepository if it returns true.
 */
export function isRepositoryWithForkedGitHubRepository(
  repository: Repository,
): repository is RepositoryWithForkedGitHubRepository {
  return (
    isRepositoryWithGitHubRepository(repository) && repository.gitHubRepository.parent !== null
  );
}

/**
 * Returns whether the passed repository has a default remote URL set.
 *
 * This function does not check the validity of the URL.
 */
export function hasDefaultRemoteUrl(repository: Repository): boolean {
  return (getGitHubHtmlUrl(repository) ?? getNonGitHubUrl(repository)) !== null;
}

/**
 * A snapshot for the local state for a given repository
 */
export interface ILocalRepositoryState {
  /**
   * The ahead/behind count for the current branch, or `null` if no tracking
   * branch found.
   */
  readonly aheadBehind: IAheadBehind | null;
  /**
   * The number of uncommitted changes currently in the repository.
   */
  readonly changedFilesCount: number;
  /**
   * The name of the currently checked out branch, or `undefined` if the
   * branch name is not available (e.g. detached HEAD).
   */
  readonly branchName: string | null;
  /**
   * The name of the default branch, or `undefined` if not available.
   */
  readonly defaultBranchName: string | null;
  /**
   * The worktrees associated with this repository (including the main
   * worktree), or an empty array when not loaded / the feature is disabled.
   */
  readonly worktrees: ReadonlyArray<WorktreeEntry>;
}

/**
 * Returns the owner/name alias if associated with a GitHub repository,
 * otherwise the folder name that contains the repository
 */
export function nameOf(repository: Repository) {
  const { gitHubRepository } = repository;

  return gitHubRepository !== null ? gitHubRepository.fullName : repository.name;
}

/**
 * Get the GitHub html URL for a repository, if it has one.
 * Will return the parent GitHub repository's URL if it has one.
 * Otherwise, returns null.
 */
export function getGitHubHtmlUrl(repository: Repository): string | null {
  if (!isRepositoryWithGitHubRepository(repository)) {
    return null;
  }

  return getNonForkGitHubRepository(repository).htmlURL;
}

/**
 * Get the html URL for a non-GitHub repository, if it has one.
 * Will return the origin repository's URL if it has one and the URL is trusted.
 * Otherwise, returns null.
 */
export function getNonGitHubUrl(repository: Repository): string | null {
  // Usually, this method will not be called for GitHub repositories, but better be safe than sorry.
  if (isRepositoryWithGitHubRepository(repository)) {
    return null;
  }

  if (!repository.url) {
    return null;
  }

  // Convert potentially SSH URLs (e.g., git@github.com:user/repo.git) to HTTPS URLs (e.g., https://github.com/user/repo.git)
  // If the URL is already HTTPS, this will be a no-op.
  const httpsUrl = repository.url.replace(/^[^@]+@([^:]+):/, "https://$1/");

  // Only return URLs that belong to trusted hosts.
  if (isTrustedRemoteHost(httpsUrl)) {
    return httpsUrl;
  }

  return null;
}

/**
 * Attempts to honor the Repository's workflow preference for GitHubRepository contributions.
 * Falls back to returning the GitHubRepository when a non-fork repository
 * is passed, returns the parent GitHubRepository otherwise.
 */
export function getNonForkGitHubRepository(
  repository: RepositoryWithGitHubRepository,
): GitHubRepository {
  if (!isRepositoryWithForkedGitHubRepository(repository)) {
    // If the repository is not a fork, we don't have to worry about anything.
    return repository.gitHubRepository;
  }

  const forkContributionTarget = getForkContributionTarget(repository);

  switch (forkContributionTarget) {
    case ForkContributionTarget.Self:
      return repository.gitHubRepository;
    case ForkContributionTarget.Parent:
      return repository.gitHubRepository.parent;
    default:
      return assertNever(forkContributionTarget, "Invalid fork contribution target");
  }
}

/**
 * Returns a non-undefined forkContributionTarget for the specified repository.
 */
export function getForkContributionTarget(repository: Repository): ForkContributionTarget {
  return repository.workflowPreferences.forkContributionTarget !== undefined
    ? repository.workflowPreferences.forkContributionTarget
    : ForkContributionTarget.Parent;
}

/**
 * Returns how the "Update from <default branch>" action should update the
 * current branch.
 */
export function getUpdateBranchStrategy(repository: Repository): UpdateBranchStrategy {
  return repository.workflowPreferences.updateBranchStrategy ?? UpdateBranchStrategy.Merge;
}

/**
 * Returns whether the fork is contributing to the parent
 */
export function isForkedRepositoryContributingToParent(repository: Repository): boolean {
  return (
    isRepositoryWithForkedGitHubRepository(repository) &&
    getForkContributionTarget(repository) === ForkContributionTarget.Parent
  );
}

function getCustomOverrideHash(customEditorOverride: EditorOverride | null): string {
  return createEqualityHash(
    customEditorOverride?.selectedExternalEditor,
    customEditorOverride?.useCustomEditor,
    customEditorOverride?.customEditor?.path,
    customEditorOverride?.customEditor?.arguments,
  );
}
