/**
 * The diff side of the IPC boundary.
 *
 * `crates/git-ops/src/diff_parser.rs` parses unified diffs and sends structured hunks; this module
 * types that payload and turns it into the `models/diff` classes the UI renders.
 *
 * # Why hydration is needed here, unlike for status
 *
 * `AppFileStatus` is a plain type, so `getStatus()` can hand its result straight to ported code. The
 * diff types are **classes with methods** — `DiffHunk.equals`, `DiffLine.withNoTrailingNewLine`,
 * `DiffLine.content` — so a JSON object is *not* assignable to them however well its fields line up.
 * The wire types below therefore describe the data, and {@linkcode hydrateRawDiff} constructs the
 * real objects.
 *
 * That is not a workaround, it's the check: hydration only compiles if the wire shape can actually
 * build the domain classes, which is the guarantee the AGENTS.md rule asks for. It is the same split
 * `status` made for `WorkingDirectoryFileChange`, where view state stays in the frontend.
 *
 * # Nulls are explicit
 *
 * The `models/diff` classes declare `number | null`, not `number?`, so Rust serializes explicit
 * nulls rather than omitting the fields — the opposite of the status types. `DiffLineType` is a
 * *numeric* TypeScript enum, so it arrives as `0`–`3`. Both are pinned by the wire snapshot.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  hydrateChangesetData,
  type IChangesetData,
  type IChangesetDataWire,
} from "@/lib/ipc/log-ipc";
import type { NoRenameIndexStatus } from "@/models/index-status";
import type { AppFileStatus, SubmoduleStatus } from "@/models/status";
import { assertNever } from "@/utils/fatal-error";
import {
  DiffHunk,
  DiffHunkExpansionType,
  DiffHunkHeader,
  DiffLine,
  DiffLineType,
  DiffType,
  Image,
  IRawDiff,
  type IDiff,
  type ITextDiff,
  type LineEndingsChange,
} from "@/models/diff";

/** A {@linkcode DiffLine} as it arrives over IPC. */
export interface IDiffLineData {
  readonly text: string;
  readonly type: DiffLineType;
  readonly originalLineNumber: number | null;
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly noTrailingNewLine: boolean;
}

/** A {@linkcode DiffHunkHeader} as it arrives over IPC. */
export interface IDiffHunkHeaderData {
  readonly oldStartLine: number;
  readonly oldLineCount: number;
  readonly newStartLine: number;
  readonly newLineCount: number;
}

/** A {@linkcode DiffHunk} as it arrives over IPC. */
export interface IDiffHunkData {
  readonly header: IDiffHunkHeaderData;
  readonly lines: ReadonlyArray<IDiffLineData>;
  readonly unifiedDiffStart: number;
  readonly unifiedDiffEnd: number;
  readonly expansionType: DiffHunkExpansionType;
}

/** An {@linkcode IRawDiff} as it arrives over IPC, before hydration. */
export interface IRawDiffData {
  readonly header: string;
  readonly contents: string;
  readonly hunks: ReadonlyArray<IDiffHunkData>;
  readonly isBinary: boolean;
  readonly maxLineNumber: number;
  readonly hasHiddenBidiChars: boolean;
}

function hydrateLine(data: IDiffLineData): DiffLine {
  return new DiffLine(
    data.text,
    data.type,
    data.originalLineNumber,
    data.oldLineNumber,
    data.newLineNumber,
    data.noTrailingNewLine,
  );
}

function hydrateHeader(data: IDiffHunkHeaderData): DiffHunkHeader {
  return new DiffHunkHeader(
    data.oldStartLine,
    data.oldLineCount,
    data.newStartLine,
    data.newLineCount,
  );
}

function hydrateHunk(data: IDiffHunkData): DiffHunk {
  return new DiffHunk(
    hydrateHeader(data.header),
    data.lines.map(hydrateLine),
    data.unifiedDiffStart,
    data.unifiedDiffEnd,
    data.expansionType,
  );
}

/**
 * Turns the parsed diff Rust sent into the `models/diff` classes the UI renders.
 *
 * The return type is the ported `IRawDiff`, so this failing to compile is the signal that the Rust
 * wire shape and the domain model have diverged.
 */
export function hydrateRawDiff(data: IRawDiffData): IRawDiff {
  return {
    header: data.header,
    contents: data.contents,
    hunks: data.hunks.map(hydrateHunk),
    isBinary: data.isBinary,
    maxLineNumber: data.maxLineNumber,
    hasHiddenBidiChars: data.hasHiddenBidiChars,
  };
}

/**
 * Lists what the index holds that `HEAD` does not, and how each path differs.
 *
 * Pairs rather than a record, because a repository path is an arbitrary string and so isn't a safe
 * object key. Callers wanting lookup can build a `Map` from the result — a `Map` accepts any string
 * key, unlike a plain object.
 *
 * A repository with no commits resolves rather than rejecting: the Rust side falls back to diffing
 * against git's empty tree, so everything staged reads as an addition.
 */
export async function getIndexChanges(
  repositoryPath: string,
): Promise<ReadonlyArray<readonly [string, NoRenameIndexStatus]>> {
  return invoke<ReadonlyArray<readonly [string, NoRenameIndexStatus]>>("get_index_changes", {
    repositoryPath,
  });
}

/** A {@linkcode ITextDiffData} payload as it arrives over IPC. */
export interface ITextDiffDataWire {
  readonly text: string;
  readonly hunks: ReadonlyArray<IDiffHunkData>;
  readonly lineEndingsChange?: LineEndingsChange;
  readonly maxLineNumber: number;
  readonly hasHiddenBidiChars: boolean;
}

/**
 * An {@linkcode IDiff} as it arrives over IPC.
 *
 * Discriminated on the same numeric `kind` as the domain union, so narrowing works identically
 * before and after hydration.
 */
/** An {@linkcode Image} as it arrives over IPC — the constructor's arguments. */
export interface IImageDataWire {
  readonly url: string;
  readonly mediaType: string;
  readonly bytes: number;
}

/**
 * An image diff as it arrives over IPC.
 *
 * A side is **absent** rather than null when that version doesn't exist: no `previous` for an added file, no
 * `current` for a deleted one, and neither for a conflicted binary — which would take showing three versions
 * and asking the user which they mean.
 *
 * `textDiff` is present for an SVG, which is text that can also be rendered, so the viewer can offer both.
 */
export interface IImageDiffWire {
  readonly previous?: IImageDataWire;
  readonly current?: IImageDataWire;
  readonly textDiff?: ITextDiffDataWire;
}

export type IDiffWire =
  | ({ readonly kind: DiffType.Text } & ITextDiffDataWire)
  | ({ readonly kind: DiffType.LargeText } & ITextDiffDataWire)
  | ({ readonly kind: DiffType.Image } & IImageDiffWire)
  | { readonly kind: DiffType.Binary }
  | { readonly kind: DiffType.Unrenderable }
  | {
      readonly kind: DiffType.Submodule;
      readonly fullPath: string;
      readonly path: string;
      readonly url: string | null;
      readonly status: SubmoduleStatus;
      readonly oldSHA: string | null;
      readonly newSHA: string | null;
    };

/**
 * Builds an {@linkcode Image}, or leaves the side absent.
 *
 * `undefined` in, `undefined` out: a missing side is what an added or deleted file has, and inventing an
 * empty `Image` would make the viewer render a broken one.
 */
function hydrateImage(data: IImageDataWire | undefined): Image | undefined {
  return data && new Image(data.url, data.mediaType, data.bytes);
}

function hydrateTextDiffData(data: ITextDiffDataWire) {
  return {
    text: data.text,
    hunks: data.hunks.map(hydrateHunk),
    lineEndingsChange: data.lineEndingsChange,
    maxLineNumber: data.maxLineNumber,
    hasHiddenBidiChars: data.hasHiddenBidiChars,
  };
}

/**
 * Turns the diff Rust sent into the domain {@linkcode IDiff}.
 *
 * Only the hunks need building — everything else is plain data — but the switch is exhaustive on
 * purpose: if Rust starts producing `DiffType.Image`, this stops compiling rather than silently
 * falling through to a default.
 */
export function hydrateDiff(data: IDiffWire): IDiff {
  switch (data.kind) {
    case DiffType.Text:
      return { kind: DiffType.Text, ...hydrateTextDiffData(data) };
    case DiffType.LargeText:
      return { kind: DiffType.LargeText, ...hydrateTextDiffData(data) };
    case DiffType.Image:
      return {
        kind: DiffType.Image,
        previous: hydrateImage(data.previous),
        current: hydrateImage(data.current),
        textDiff: data.textDiff && hydrateTextDiffData(data.textDiff),
      };
    case DiffType.Binary:
      return { kind: DiffType.Binary };
    case DiffType.Unrenderable:
      return { kind: DiffType.Unrenderable };
    case DiffType.Submodule:
      return {
        kind: DiffType.Submodule,
        fullPath: data.fullPath,
        path: data.path,
        url: data.url,
        status: data.status,
        oldSHA: data.oldSHA,
        newSHA: data.newSHA,
      };
    default:
      return assertNever(data, `Unknown diff kind: ${data}`);
  }
}

/**
 * Diffs a file in the working directory.
 *
 * `status` comes straight from `getStatus()` — how a file is diffed depends on it: a new or untracked
 * file has nothing to compare against, a rename needs its source path, and a submodule is described
 * rather than diffed.
 *
 * Image diffs are not produced yet, so a binary image reports {@linkcode DiffType.Binary} and an SVG
 * reports a plain text diff. See the note in `crates/git-ops/src/diff.rs`.
 */
export async function getWorkingDirectoryDiff(
  repositoryPath: string,
  path: string,
  status: AppFileStatus,
  hideWhitespace = false,
): Promise<IDiff> {
  const diff = await invoke<IDiffWire>("get_working_directory_diff", {
    repositoryPath,
    path,
    status,
    hideWhitespace,
  });

  return hydrateDiff(diff);
}

/** Diffs a file in a commit against that commit's first parent. */
export async function getCommitDiff(
  repositoryPath: string,
  path: string,
  status: AppFileStatus,
  commitish: string,
  hideWhitespace = false,
): Promise<IDiff> {
  const diff = await invoke<IDiffWire>("get_commit_diff", {
    repositoryPath,
    path,
    status,
    commitish,
    hideWhitespace,
  });

  return hydrateDiff(diff);
}

/**
 * Diffs a file across a range of commits, oldest first.
 *
 * A branch's first commit works without the caller doing anything special: `<root>^` doesn't resolve,
 * and the Rust side retries against git's empty tree so the file reads as entirely added.
 */
export async function getCommitRangeDiff(
  repositoryPath: string,
  path: string,
  status: AppFileStatus,
  commits: ReadonlyArray<string>,
  hideWhitespace = false,
): Promise<IDiff> {
  const diff = await invoke<IDiffWire>("get_commit_range_diff", {
    repositoryPath,
    path,
    status,
    commits,
    hideWhitespace,
  });

  return hydrateDiff(diff);
}

/**
 * Turns a diff back into the shape Rust reads.
 *
 * The mirror of {@linkcode hydrateTextDiffData}, and needed for the same reason: the domain hunks are
 * class instances, and relying on the IPC layer's structured clone to flatten them would leave the
 * agreement between the two sides unchecked. Writing it out means a field renamed on either side stops
 * compiling here.
 *
 * Takes {@linkcode ITextDiff} rather than the shared text payload because that is what the original's
 * `discardChangesFromSelection` took, so a `LargeText` diff can't be discarded from — the Rust side
 * would accept one. Widening it is a UI decision for Phase 7, not something to slip in here.
 */
export function dehydrateTextDiff(diff: ITextDiff): ITextDiffDataWire {
  return {
    text: diff.text,
    hunks: diff.hunks.map((hunk) => ({
      header: {
        oldStartLine: hunk.header.oldStartLine,
        oldLineCount: hunk.header.oldLineCount,
        newStartLine: hunk.header.newStartLine,
        newLineCount: hunk.header.newLineCount,
      },
      lines: hunk.lines.map((line) => ({
        text: line.text,
        type: line.type,
        originalLineNumber: line.originalLineNumber,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        noTrailingNewLine: line.noTrailingNewLine,
      })),
      unifiedDiffStart: hunk.unifiedDiffStart,
      unifiedDiffEnd: hunk.unifiedDiffEnd,
      expansionType: hunk.expansionType,
    })),
    lineEndingsChange: diff.lineEndingsChange,
    maxLineNumber: diff.maxLineNumber,
    hasHiddenBidiChars: diff.hasHiddenBidiChars,
  };
}

/**
 * Discards the given lines of a file from the working tree.
 *
 * `selectedLines` are absolute indices across the unified diff — the same ones `DiffSelection` uses,
 * where index zero is the first hunk's header.
 *
 * **`diff` must be the diff the selection was made against.** It is sent rather than re-read for that
 * reason: if the file has changed since, git rejects the patch instead of discarding whichever lines
 * now happen to sit at those indices.
 *
 * Discarding nothing resolves without touching the file.
 */
export async function discardChangesFromSelection(
  repositoryPath: string,
  filePath: string,
  diff: ITextDiff,
  selectedLines: ReadonlyArray<number>,
): Promise<void> {
  await invoke("discard_changes_from_selection", {
    repositoryPath,
    filePath,
    diff: dehydrateTextDiff(diff),
    selectedLines,
  });
}

/**
 * Diffs a file between two branches, from where they diverged.
 *
 * `--merge-base` on the Rust side is what makes this a *comparison*: commits the base branch gained after the
 * two diverged would otherwise read as though the comparison branch removed them.
 *
 * `latestCommit` labels the result — it names the version of the file being shown, which the diff itself does
 * not carry.
 */
export async function getBranchMergeBaseDiff(
  repositoryPath: string,
  path: string,
  status: AppFileStatus,
  baseBranch: string,
  comparisonBranch: string,
  latestCommit: string,
  hideWhitespace = false,
): Promise<IDiff> {
  const diff = await invoke<IDiffWire>("get_branch_merge_base_diff", {
    repositoryPath,
    path,
    status,
    baseBranch,
    comparisonBranch,
    latestCommit,
    hideWhitespace,
  });

  return hydrateDiff(diff);
}

/**
 * What changed between two branches, from where they diverged.
 *
 * `null` means the branches have **no common ancestor** — unrelated histories, a real state rather than a
 * failure, since there is no point to compare from.
 */
export async function getBranchMergeBaseChangedFiles(
  repositoryPath: string,
  baseBranch: string,
  comparisonBranch: string,
  latestComparisonCommit: string,
): Promise<IChangesetData | null> {
  const changeset = await invoke<IChangesetDataWire | null>("get_branch_merge_base_changed_files", {
    repositoryPath,
    baseBranch,
    comparisonBranch,
    latestComparisonCommit,
  });

  return changeset === null ? null : hydrateChangesetData(changeset);
}

/**
 * What changed across a range of commits, oldest first.
 *
 * The oldest commit's **parent** is the starting point, so the range includes its own change. A branch's first
 * commit works without the caller doing anything: `<sha>^` doesn't resolve there, and the Rust side retries
 * against git's empty tree.
 */
export async function getCommitRangeChangedFiles(
  repositoryPath: string,
  shas: ReadonlyArray<string>,
): Promise<IChangesetData> {
  const changeset = await invoke<IChangesetDataWire>("get_commit_range_changed_files", {
    repositoryPath,
    shas,
  });

  return hydrateChangesetData(changeset);
}
