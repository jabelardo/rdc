/**
 * Typed wrappers over the Rust git commands.
 *
 * rdc uses Tauri's native IPC — `invoke` from `@tauri-apps/api/core` — rather than a binding
 * generator, so the types here are hand-written to match the Rust side, and
 * `crates/git-ops/tests/wire_contract.rs` pins the exact JSON of everything that crosses.
 *
 * **Domain types are re-used from `models/status.ts`, never redeclared here.** That rule exists
 * because breaking it caused a real bug: this module used to declare its own `AppFileStatus` with
 * the conflict details flattened, while the ported `models/status.ts` nests them under `entry`.
 * Both the Rust and the wire-contract test agreed with the flattened version, so everything passed
 * — but `src/lib/status.ts`, which consumes the ported `AppFileStatus`, could never have accepted
 * the result of `getStatus()`. Two definitions of one domain concept will drift, and the tests
 * guarding the boundary can't see it, because they only compare Rust to JSON.
 *
 * So: if a type already exists in `models/`, import it. Only genuinely new wire types belong here.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { hookFailureChannel, type HookFailureCallback, type IHookProgress } from "./hook-ipc";
import { GitResetMode } from "../models/git-reset-mode";
import type { AppFileStatus, GitStatusEntry } from "../models/status";
import type { ManualConflictResolution } from "../models/manual-conflict-resolution";
import { GitErrorKind } from "../models/git-error-kind";
import type { ICheckoutProgress, IMultiCommitOperationProgress } from "../models/progress";
import type { CommitOneLine } from "../models/commit";

/** How far ahead/behind a branch is relative to its upstream. */
export interface IAheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

/** What git records about an in-progress rebase. */
export interface IRebaseInternalState {
  readonly targetBranch: string;
  readonly baseBranchTip: string;
  readonly originalBranchTip: string;
}

/** One changed path, as git sees it. */
export interface IStatusFileChange {
  readonly path: string;
  readonly status: AppFileStatus;
  /**
   * Whether the UI should start with this file unticked — a dirty submodule whose own commit
   * hasn't changed, where committing in the superproject would record nothing.
   */
  readonly startsUnselected: boolean;
}

/** The status of a repository. */
export interface IStatusResult {
  readonly currentBranch?: string;
  readonly currentUpstreamBranch?: string;
  readonly currentTip?: string;
  readonly branchAheadBehind?: IAheadBehind;
  readonly mergeHeadFound: boolean;
  readonly squashMsgFound: boolean;
  readonly rebaseInternalState?: IRebaseInternalState;
  readonly isCherryPickingHeadFound: boolean;
  readonly files: ReadonlyArray<IStatusFileChange>;
  readonly doConflictedFilesExist: boolean;
}

/**
 * A command failure.
 *
 * `kind` is the classified git error, so the UI can branch on e.g. an authentication failure
 * without parsing `message`. User-facing wording belongs here in the frontend, not in Rust — see
 * the `getDescriptionForError` note in MIGRATION_MAP.md.
 */
export interface ICommandError {
  readonly message: string;
  readonly kind?: GitErrorKind;
  readonly isAuthFailure: boolean;
}

/** Whether a rejected `invoke` gave us a structured command error. */
export function isCommandError(error: unknown): error is ICommandError {
  return (
    typeof error === "object" && error !== null && "message" in error && "isAuthFailure" in error
  );
}

/** Creates a Git repository at a new or existing empty directory. */
export async function initRepository(repositoryPath: string, defaultBranch: string): Promise<void> {
  return invoke("init_repository", { repositoryPath, defaultBranch });
}

/**
 * Reads the status of the repository at `repositoryPath`, or `null` if that path isn't a git
 * repository.
 *
 * `listUntrackedFilesIndividually` does **not** mean "include untracked files": passing `false`
 * still reports them, it just collapses untracked directories into a single entry.
 */
export async function getStatus(
  repositoryPath: string,
  listUntrackedFilesIndividually = true,
): Promise<IStatusResult | null> {
  return invoke<IStatusResult | null>("get_status", {
    repositoryPath,
    listUntrackedFilesIndividually,
  });
}

/** The lines selected from a partially-selected text file. */
export interface IPartialSelection {
  /** The file status determines how Rust constructs the partial patch. */
  readonly status: AppFileStatus;
  /**
   * Absolute indices across the unified diff, including hunk headers.
   *
   * These are the same indices consumed by `DiffSelection`.
   */
  readonly selectedLines: ReadonlyArray<number>;
}

/**
 * A file the user has selected for staging.
 *
 * `oldPath`, `deleted`, and `partial` have defaults on the Rust side, so a fully-selected added or
 * modified file is just `{ path }`.
 */
export interface IFileToStage {
  readonly path: string;
  /** The path this file was renamed *from*, when the change is a rename or a copy. */
  readonly oldPath?: string;
  /** Whether the file is gone from the working tree. */
  readonly deleted?: boolean;
  /** Present when only the listed lines should be staged. */
  readonly partial?: IPartialSelection;
}

/**
 * Whether to run the repository's hooks with the user's shell environment, and where to report them.
 *
 * Omitting this leaves interception **off** and Git still runs the hooks itself. The working-tree
 * commit flow deliberately supplies this by default so hooks receive the user's shell environment
 * and failures can be resolved in the UI; its explicit **Bypass hooks** option instead sends
 * `CommitOptions.noVerify`. Other operations choose interception at their own product boundary — see
 * `src/lib/hook-ipc.ts` for why the list of hooks is not a parameter.
 */
export interface IHookOptions {
  readonly interceptHooks: boolean;
  readonly onHookProgress?: (progress: IHookProgress) => void;
  readonly onHookFailure?: HookFailureCallback;
}

/** A chunk of combined stdout/stderr from the Git commit process. */
export type TerminalOutputCallback = (chunk: string) => void;

/**
 * The hook arguments for an `invoke` call.
 *
 * A Channel is sent even when nothing listens, because the Rust side takes one unconditionally — the same
 * shape the progress Channels already use.
 */
function hookArgs(hooks: IHookOptions | undefined) {
  return {
    interceptHooks: hooks?.interceptHooks ?? false,
    onHookProgress: new Channel<IHookProgress>(hooks?.onHookProgress),
    onHookFailure: hookFailureChannel(hooks?.onHookFailure),
  };
}

/** Options for {@linkcode createCommit}. Every flag defaults to off. */
export interface ICommitOptions {
  readonly amend?: boolean;
  readonly noVerify?: boolean;
  readonly signOff?: boolean;
  readonly allowEmpty?: boolean;
}

/** The outcome of merging a branch into the current branch. */
export enum MergeResult {
  Success = "Success",
  AlreadyUpToDate = "AlreadyUpToDate",
  Failed = "Failed",
}

export interface IMergeOptions {
  readonly squash?: boolean;
  readonly noVerify?: boolean;
}

/** The outcome of starting or continuing a rebase. */
export enum RebaseResult {
  CompletedWithoutError = "CompletedWithoutError",
  AlreadyUpToDate = "AlreadyUpToDate",
  ConflictsEncountered = "ConflictsEncountered",
  OutstandingFilesNotStaged = "OutstandingFilesNotStaged",
  Aborted = "Aborted",
  Error = "Error",
}

/**
 * A conflict the user resolved by picking a side in the app.
 *
 * `entries` is the conflict's `[us, them]` pair, from the file's `status.entry`. It is optional on the
 * wire, but supply it whenever the status is to hand: without it the resolution can only be staged as
 * "take the chosen side's content", and a side that **deleted** the file cannot be honoured at all —
 * `git checkout --ours/--theirs` refuses such a path outright.
 */
export interface IManualResolution {
  readonly path: string;
  readonly resolution: ManualConflictResolution;
  readonly entries?: readonly [GitStatusEntry, GitStatusEntry];
}

export interface IRebaseSnapshot {
  readonly progress: IMultiCommitOperationProgress;
  readonly commits: ReadonlyArray<CommitOneLine>;
}

/**
 * Creates a commit containing exactly `files`, and resolves to its full SHA.
 *
 * The SHA is the full 40 characters. The original returned git's abbreviation — and returned the
 * string `'(root-commit)'` for a repository's first commit, a bug its own tests had pinned as
 * expected. See MIGRATION_MAP.md §8.
 */
export async function createCommit(
  repositoryPath: string,
  message: string,
  files: ReadonlyArray<IFileToStage>,
  options?: ICommitOptions,
  hooks?: IHookOptions,
  onTerminalOutput?: TerminalOutputCallback,
): Promise<string> {
  const hooksArguments = hookArgs(hooks);
  const terminalOutputChannel = new Channel<string>(onTerminalOutput);

  // Await here rather than returning invoke's promise directly. These locals keep all three Channel
  // handlers alive until the native operation settles; a hook may not fail until minutes after commit
  // starts, by which point a temporary Channel argument is eligible for collection.
  return await invoke<string>("create_commit", {
    repositoryPath,
    message,
    files,
    options,
    ...hooksArguments,
    onTerminalOutput: terminalOutputChannel,
  });
}

/**
 * Creates the commit that concludes an in-progress merge, and resolves to its full SHA.
 *
 * Unlike {@linkcode createCommit} this does **not** clear the index first: a merge's staged state is
 * what git built while merging, and discarding it would throw away the resolution.
 *
 * `manualResolutions` is a list rather than a record keyed by path, because a repository path is an
 * arbitrary string and so isn't a safe object key. Each entry carries the conflict's index entries,
 * which is what lets a resolution in favour of the side that deleted the file stage a deletion.
 */
export async function createMergeCommit(
  repositoryPath: string,
  files: ReadonlyArray<IFileToStage>,
  manualResolutions: ReadonlyArray<IManualResolution> = [],
): Promise<string> {
  return invoke<string>("create_merge_commit", {
    repositoryPath,
    files,
    manualResolutions,
  });
}

/** Checks out an existing local branch. */
export async function checkoutBranch(
  repositoryPath: string,
  name: string,
  progressCallback?: (progress: ICheckoutProgress) => void,
): Promise<void> {
  const onProgress = new Channel<ICheckoutProgress>(progressCallback);
  return invoke<void>("checkout_branch", { repositoryPath, name, onProgress });
}

/**
 * Checks out a remote-tracking branch by creating a local branch from it.
 *
 * Rejects if `localName` already exists — git won't repoint an existing branch, and the UI needs
 * that failure in order to prompt.
 */
export async function checkoutRemoteBranch(
  repositoryPath: string,
  remoteRef: string,
  localName: string,
  progressCallback?: (progress: ICheckoutProgress) => void,
): Promise<void> {
  const onProgress = new Channel<ICheckoutProgress>(progressCallback);
  return invoke<void>("checkout_remote_branch", {
    repositoryPath,
    remoteRef,
    localName,
    onProgress,
  });
}

/** Checks out a commit, leaving `HEAD` detached. */
export async function checkoutCommit(
  repositoryPath: string,
  commit: string,
  progressCallback?: (progress: ICheckoutProgress) => void,
): Promise<void> {
  const onProgress = new Channel<ICheckoutProgress>(progressCallback);
  return invoke<void>("checkout_commit", {
    repositoryPath,
    commit,
    onProgress,
  });
}

/**
 * Restores the given paths from `HEAD`.
 *
 * **This discards the user's working-tree changes to those paths.** An empty list is a no-op rather
 * than meaning "everything".
 */
export async function checkoutPaths(
  repositoryPath: string,
  paths: ReadonlyArray<string>,
): Promise<void> {
  return invoke<void>("checkout_paths", { repositoryPath, paths });
}

/** Merges `branch` into the current branch. */
export async function mergeBranch(
  repositoryPath: string,
  branch: string,
  options?: IMergeOptions,
  hooks?: IHookOptions,
): Promise<MergeResult> {
  const hooksArguments = hookArgs(hooks);
  return await invoke<MergeResult>("merge_branch", {
    repositoryPath,
    branch,
    options,
    ...hooksArguments,
  });
}

/** Finds the best common ancestor of two refs. */
export async function getMergeBase(
  repositoryPath: string,
  firstCommitish: string,
  secondCommitish: string,
): Promise<string | null> {
  return invoke<string | null>("get_merge_base", {
    repositoryPath,
    firstCommitish,
    secondCommitish,
  });
}

/** Aborts an in-progress merge. */
export async function abortMerge(repositoryPath: string): Promise<void> {
  return invoke<void>("abort_merge", { repositoryPath });
}

/** Rebases `targetBranch` onto `baseBranch`. */
export async function rebaseBranch(
  repositoryPath: string,
  baseBranch: string,
  targetBranch: string,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void,
): Promise<RebaseResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(progressCallback);
  return invoke<RebaseResult>("rebase_branch", {
    repositoryPath,
    baseBranch,
    targetBranch,
    onProgress,
  });
}

/**
 * Stages selected files and manual resolutions, then continues the active rebase.
 */
export async function continueRebase(
  repositoryPath: string,
  files: ReadonlyArray<IFileToStage>,
  manualResolutions: ReadonlyArray<IManualResolution> = [],
  noVerify = false,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void,
): Promise<RebaseResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(progressCallback);
  return invoke<RebaseResult>("continue_rebase", {
    repositoryPath,
    files,
    manualResolutions,
    noVerify,
    onProgress,
  });
}

/** Aborts an in-progress rebase. */
export async function abortRebase(repositoryPath: string): Promise<void> {
  return invoke<void>("abort_rebase", { repositoryPath });
}

/** Recovers progress for a rebase started by rdc or another Git client. */
export async function getRebaseSnapshot(repositoryPath: string): Promise<IRebaseSnapshot | null> {
  return invoke<IRebaseSnapshot | null>("get_rebase_snapshot", {
    repositoryPath,
  });
}

/**
 * Resets `refName`, moving `HEAD` and — depending on the mode — the index and working tree.
 *
 * **{@linkcode GitResetMode.Hard} discards work.** Everything in the working tree that differs from `refName`
 * is gone, with no reflog of the file contents, so ask the user first.
 */
export async function reset(
  repositoryPath: string,
  mode: GitResetMode,
  refName: string,
): Promise<void> {
  await invoke("reset", { repositoryPath, mode, refName });
}

/**
 * Updates the index for `paths` from the tree at `refName`.
 *
 * An empty `paths` is a **no-op**, not "reset everything" — which is what those arguments would mean to git
 * with no pathspec, and the opposite of what an empty selection means.
 */
export async function resetPaths(
  repositoryPath: string,
  mode: GitResetMode,
  refName: string,
  paths: ReadonlyArray<string>,
): Promise<void> {
  await invoke("reset_paths", { repositoryPath, mode, refName, paths });
}

/**
 * Clears the staging area.
 *
 * Distinct from {@linkcode unstageAllFiles}: this restores the index to `HEAD`, and works even in a
 * repository with no commits.
 */
export async function unstageAll(repositoryPath: string): Promise<void> {
  await invoke("unstage_all", { repositoryPath });
}

/**
 * Removes every path from the index, leaving the working tree alone.
 *
 * Distinct from {@linkcode unstageAll} despite the name — upstream keeps them in different files for the same
 * reason. This is `rm --cached`, which empties the index including paths that exist only there.
 */
export async function unstageAllFiles(repositoryPath: string): Promise<void> {
  await invoke("unstage_all_files", { repositoryPath });
}

/**
 * A conflict the user has finished with.
 *
 * The Rust side takes git facts rather than a `WorkingDirectoryFileChange`, because that is view state — the
 * same split `getStatus` makes. Supply what the status already told you.
 */
export interface IResolvedConflict {
  readonly path: string;

  /**
   * The conflict's index entries, `[us, them]`. Supplying them lets a deletion be staged as a deletion,
   * which content alone cannot express.
   */
  readonly entries?: readonly [GitStatusEntry, GitStatusEntry];

  /**
   * How many conflict markers git still found.
   *
   * `0` is the interesting value: a text conflict the user resolved in their own editor.
   */
  readonly conflictMarkerCount?: number;

  /** The side the user picked in the app, when they picked one. */
  readonly resolution?: ManualConflictResolution;
}

/**
 * Stages the conflicts the user has finished with.
 *
 * A checkout refuses to run while the index holds unresolved conflicts, so anything that checks out after one
 * has to stage the resolutions first.
 *
 * Two kinds count as resolved: a side picked in the app, or a marker count of **zero**. Anything else is left
 * alone — staging a file that still has markers would commit them.
 */
export async function stageResolvedConflictFiles(
  repositoryPath: string,
  files: ReadonlyArray<IResolvedConflict>,
): Promise<void> {
  await invoke("stage_resolved_conflict_files", { repositoryPath, files });
}
