/**
 * Stash and cherry-pick.
 *
 * Both are local operations, so unlike {@link ./remote-ipc.ts} they need no credentials.
 *
 * # Hydration
 *
 * A stash entry's `files` field is a *load state* the frontend owns (`NotLoaded`/`Loading`/`Loaded`), so
 * the backend doesn't send it — the same split as `WorkingDirectoryFileChange` in status.
 * {@linkcode hydrateStashEntry} adds it, defaulting to `NotLoaded`, and turns `createdAt` from epoch
 * seconds into a `Date`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  StashedChangesLoadStates,
  type IStashEntry,
  type StashedFileChanges,
} from "../models/stash-entry";
import type { AppFileStatus, CommittedFileChange } from "../models/status";
import type { ManualConflictResolution } from "../models/manual-conflict-resolution";
import type { CommitOneLine } from "../models/commit";
import { SubmoduleEntry } from "../models/submodule";
import type { IMultiCommitOperationProgress } from "../models/progress";
import { RebaseResult, type IFileToStage } from "./git-ipc";
import { hydrateCommittedFileChange, type ICommittedFileChangeData } from "./log-ipc";

/** A {@linkcode IStashEntry} as it arrives over IPC: everything but the frontend's load state. */
export interface IStashEntryData {
  readonly name: string;
  readonly branchName: string;
  readonly customName: string | null;
  readonly stashSha: string;
  /** Seconds since the Unix epoch. */
  readonly createdAt: number;
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
}

/** What {@linkcode getStashes} found. */
export interface IStashResult {
  /** Entries the app created, newest first. */
  readonly desktopEntries: ReadonlyArray<IStashEntry>;
  /**
   * How many stash entries exist in total, including ones made outside the app.
   *
   * The original reported one fewer than existed — with a single stash it said zero. See
   * MIGRATION_MAP.md §8.
   */
  readonly stashEntryCount: number;
}

interface IStashResultData {
  readonly desktopEntries: ReadonlyArray<IStashEntryData>;
  readonly stashEntryCount: number;
}

/** How a cherry-pick ended. */
export enum CherryPickResult {
  CompletedWithoutError = "CompletedWithoutError",
  ConflictsEncountered = "ConflictsEncountered",
  OutstandingFilesNotStaged = "OutstandingFilesNotStaged",
  UnableToStart = "UnableToStart",
  Error = "Error",
}

/** An interrupted cherry-pick, so a reopened frontend can recover. */
export interface ICherryPickSnapshot {
  readonly remainingCommits: ReadonlyArray<CommitOneLine>;
  readonly commits: ReadonlyArray<CommitOneLine>;
  readonly progress: IMultiCommitOperationProgress;
  readonly targetBranchUndoSha: string;
  readonly cherryPickedCount: number;
}

/**
 * Builds an {@linkcode IStashEntry}, adding the load state the backend doesn't own.
 *
 * `files` defaults to `NotLoaded`; the caller replaces it once {@linkcode getStashedFiles} resolves.
 */
export function hydrateStashEntry(
  data: IStashEntryData,
  files: StashedFileChanges = { kind: StashedChangesLoadStates.NotLoaded },
): IStashEntry {
  return {
    name: data.name,
    branchName: data.branchName,
    customName: data.customName,
    stashSha: data.stashSha,
    // Seconds on the wire, milliseconds in a Date.
    createdAt: new Date(data.createdAt * 1000),
    tree: data.tree,
    parents: data.parents,
    files,
  };
}

/** Lists the app's stash entries, newest first, and counts all of them. */
export async function getStashes(repositoryPath: string): Promise<IStashResult> {
  const result = await invoke<IStashResultData>("get_stashes", {
    repositoryPath,
  });

  return {
    desktopEntries: result.desktopEntries.map((entry) => hydrateStashEntry(entry)),
    stashEntryCount: result.stashEntryCount,
  };
}

/**
 * Stashes the working directory, resolving to whether anything was stashed.
 *
 * `untrackedFilesToStage` is separate because `git stash push` with a pathspec ignores untracked files —
 * they have to be staged first to be included. `selectedFiles: null` stashes everything.
 */
export async function createStashEntry(
  repositoryPath: string,
  branchName: string,
  untrackedFilesToStage: ReadonlyArray<IFileToStage> = [],
  selectedFiles: ReadonlyArray<string> | null = null,
): Promise<boolean> {
  return invoke<boolean>("create_stash_entry", {
    repositoryPath,
    branchName,
    untrackedFilesToStage,
    selectedFiles,
  });
}

/** Drops the entry with the given commit. Dropping an unknown one succeeds. */
export async function dropStashEntry(repositoryPath: string, stashSha: string): Promise<void> {
  return invoke<void>("drop_stash_entry", { repositoryPath, stashSha });
}

/**
 * Applies the entry with the given commit and removes it.
 *
 * A pop that conflicts does not reject — the entry is still removed, and the caller drives resolution.
 */
export async function popStashEntry(repositoryPath: string, stashSha: string): Promise<void> {
  return invoke<void>("pop_stash_entry", { repositoryPath, stashSha });
}

/** The app's most recent stash for a branch, or `null`. */
export async function getLastStashEntryForBranch(
  repositoryPath: string,
  branchName: string,
): Promise<IStashEntry | null> {
  const entry = await invoke<IStashEntryData | null>("get_last_stash_entry_for_branch", {
    repositoryPath,
    branchName,
  });

  return entry === null ? null : hydrateStashEntry(entry);
}

/**
 * Sets or clears a stash entry's name, resolving to its new SHA — or `null` when nothing changed.
 *
 * A blank or whitespace-only name clears it. `null` matters: rebuilding the entry would change its SHA
 * and invalidate whatever the caller holds.
 */
export async function renameStashEntry(
  repositoryPath: string,
  entry: IStashEntry,
  newName: string | null,
): Promise<string | null> {
  return invoke<string | null>("rename_stash_entry", {
    repositoryPath,
    entry: dehydrateStashEntry(entry),
    newName,
  });
}

/** Re-associates a stash entry with a different branch, resolving to its new SHA. */
export async function moveStashEntry(
  repositoryPath: string,
  entry: IStashEntry,
  branchName: string,
): Promise<string> {
  return invoke<string>("move_stash_entry", {
    repositoryPath,
    entry: dehydrateStashEntry(entry),
    branchName,
  });
}

/**
 * Strips the frontend-owned parts of an entry so it can be sent back.
 *
 * `files` is dropped and `createdAt` returns to epoch seconds — the backend rebuilds the entry with the
 * same date so it keeps its position when sorted.
 */
function dehydrateStashEntry(entry: IStashEntry): IStashEntryData {
  return {
    name: entry.name,
    branchName: entry.branchName,
    customName: entry.customName,
    stashSha: entry.stashSha,
    createdAt: Math.floor(entry.createdAt.getTime() / 1000),
    tree: entry.tree,
    parents: entry.parents,
  };
}

/** The files a stash entry touches. */
export async function getStashedFiles(
  repositoryPath: string,
  stashSha: string,
): Promise<ReadonlyArray<CommittedFileChange>> {
  const files = await invoke<ReadonlyArray<ICommittedFileChangeData>>("get_stashed_files", {
    repositoryPath,
    stashSha,
  });

  return files.map(hydrateCommittedFileChange);
}

/**
 * Cherry-picks commits onto the current branch, oldest first.
 *
 * Resolves to a {@linkcode CherryPickResult} rather than rejecting on conflicts — those are an expected
 * outcome the UI drives to resolution.
 */
export async function cherryPick(
  repositoryPath: string,
  commits: ReadonlyArray<CommitOneLine>,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void,
): Promise<CherryPickResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(progressCallback);

  return invoke<CherryPickResult>("cherry_pick", {
    repositoryPath,
    commits,
    onProgress,
  });
}

/** An interrupted cherry-pick, or `null` if none is in progress. */
export async function getCherryPickSnapshot(
  repositoryPath: string,
): Promise<ICherryPickSnapshot | null> {
  return invoke<ICherryPickSnapshot | null>("get_cherry_pick_snapshot", {
    repositoryPath,
  });
}

/**
 * Continues a cherry-pick once conflicts are resolved.
 *
 * `files` is `[path, status]` pairs, because a path is an arbitrary string. Untracked entries are
 * excluded by the backend, so unrelated work isn't swept into the commit.
 */
export async function continueCherryPick(
  repositoryPath: string,
  files: ReadonlyArray<readonly [string, AppFileStatus]>,
  manualResolutions: ReadonlyArray<readonly [string, ManualConflictResolution]> = [],
  progressCallback?: (progress: IMultiCommitOperationProgress) => void,
): Promise<CherryPickResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(progressCallback);

  return invoke<CherryPickResult>("continue_cherry_pick", {
    repositoryPath,
    files,
    manualResolutions,
    onProgress,
  });
}

/** Abandons the cherry-pick, restoring the branch to where it started. */
export async function abortCherryPick(repositoryPath: string): Promise<void> {
  return invoke<void>("abort_cherry_pick", { repositoryPath });
}

/** A {@linkcode SubmoduleEntry} as it arrives over IPC. */
export interface ISubmoduleEntryData {
  readonly sha: string;
  readonly path: string;
  /** Absent for an uninitialized or conflicted submodule, where git reports no describe value. */
  readonly describe?: string;
}

/**
 * Lists the top-level submodules.
 *
 * Uninitialized and conflicted submodules **are** included, with a `null` `describe`. The original
 * dropped them, and that mattered: this list is what tells the discard path a given path is a submodule
 * and must be reset rather than moved to the trash. See MIGRATION_MAP.md §8.
 *
 * Not recursive, matching `git status` — the app has no story for managing nested submodules.
 */
export async function listSubmodules(
  repositoryPath: string,
): Promise<ReadonlyArray<SubmoduleEntry>> {
  const entries = await invoke<ReadonlyArray<ISubmoduleEntryData>>("list_submodules", {
    repositoryPath,
  });

  // `describe` is omitted rather than null on the wire, so it is normalised here to the model's
  // `string | null`.
  return entries.map((entry) => new SubmoduleEntry(entry.sha, entry.path, entry.describe ?? null));
}

/**
 * Restores submodule paths to the commits the containing repository records.
 *
 * **This discards whatever those submodules' working trees currently have.** An empty list is a no-op.
 */
export async function resetSubmodulePaths(
  repositoryPath: string,
  paths: ReadonlyArray<string>,
): Promise<void> {
  return invoke<void>("reset_submodule_paths", { repositoryPath, paths });
}

/**
 * Squashes commits together.
 *
 * The replay order is the **log's**, not the order `toSquash` is given in. So squashing the last two
 * commits produces the same result whichever the user selects as the target — history decides.
 *
 * `lastRetainedCommitRef` is the commit *before* the range being rewritten; `null` reaches the root of
 * the branch. A blank `commitMessage` leaves git to combine the originals as it normally would.
 *
 * Resolves to a {@linkcode RebaseResult}. A validation failure — an empty list, a target that is also in
 * the list, a target missing from the log — comes back as `Error` rather than rejecting.
 */
export async function squash(
  repositoryPath: string,
  toSquash: ReadonlyArray<string>,
  squashOnto: string,
  lastRetainedCommitRef: string | null,
  commitMessage = "",
  progressCallback?: (progress: IMultiCommitOperationProgress) => void,
): Promise<RebaseResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(progressCallback);

  return invoke<RebaseResult>("squash", {
    repositoryPath,
    toSquash,
    squashOnto,
    lastRetainedCommitRef,
    commitMessage,
    onProgress,
  });
}

/**
 * Moves commits so they sit immediately before `before`.
 *
 * `before` of `null` moves them to the end of history. The moved commits keep their relative log order
 * however `toMove` is ordered.
 */
export async function reorder(
  repositoryPath: string,
  toMove: ReadonlyArray<string>,
  before: string | null,
  lastRetainedCommitRef: string | null,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void,
): Promise<RebaseResult> {
  const onProgress = new Channel<IMultiCommitOperationProgress>(progressCallback);

  return invoke<RebaseResult>("reorder", {
    repositoryPath,
    toMove,
    before,
    lastRetainedCommitRef,
    onProgress,
  });
}
