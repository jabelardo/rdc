/**
 * Pure logic over diff hunks, depending only on the `models/diff` types.
 *
 * MIGRATION NOTE (layering fix + circular-dependency break): in desktop-plus these
 * lived under `ui/`, and `lib/diff-parser.ts` imported them from there:
 *
 *   - `DefaultDiffExpansionStep`, `getHunkHeaderExpansionType`
 *       <- ui/diff/text-diff-expansion.ts
 *   - `getLargestLineNumber`
 *       <- ui/diff/diff-helpers.tsx  (a .tsx module that also imports React)
 *
 * That produced a genuine **import cycle**: `lib/diff-parser` -> `ui/diff/text-diff-expansion`
 * -> `lib/diff-parser` (for `HiddenBidiCharsRegex`). It also meant the diff *parser* — pure
 * text processing — could not be used without pulling in React.
 *
 * None of these functions are view concerns, so they belong in `lib/`. When
 * `ui/diff/text-diff-expansion.ts` and `ui/diff/diff-helpers.tsx` are ported in Phase 7 they
 * should import from here, leaving a one-way `ui/` -> `lib/` dependency and no cycle.
 *
 * UPDATE (Phase 2, when the parser moved to Rust): `HiddenBidiCharsRegex` now lives here too. It
 * was exported from `lib/diff-parser.ts`, which has been **deleted** — parsing is done by
 * `crates/git-ops/src/diff_parser.rs` and the parsed `RawDiff` arrives over IPC. The regex could
 * not go with it, because `ui/diff/text-diff-expansion.ts` needs it for content the UI fetches
 * during hunk expansion, which never passes through the Rust parser. Moving it here also removes
 * the last edge of the cycle described above.
 *
 * The functions below are **also implemented in Rust**, in `diff_parser.rs`. That is deliberate,
 * not an oversight: Rust applies them while parsing, and the UI re-applies them after the user
 * expands a hunk. The two implementations are pinned against each other by the wire snapshot.
 */

import { DiffHunk, DiffHunkExpansionType, DiffHunkHeader, DiffLineType } from "../models/diff";

/** How many new lines will be added to a diff hunk by default. */
export const DefaultDiffExpansionStep = 20;

/**
 * Matches invisible bidirectional Unicode characters, which can make text render differently from
 * how it is compiled or interpreted. See https://github.co/hiddenchars
 *
 * Kept in sync with `is_hidden_bidi_char` in `crates/git-ops/src/diff_parser.rs`.
 */
export const HiddenBidiCharsRegex = /[\u202A-\u202E]|[\u2066-\u2069]/;

/**
 * Calculates whether or not a hunk header can be expanded up, down, both, or if
 * the space represented by the hunk header is short and expansion there would
 * mean merging with the hunk above.
 *
 * @param hunkIndex     Index of the hunk to evaluate within the whole diff.
 * @param hunkHeader    Header of the hunk to evaluate.
 * @param previousHunk  Hunk previous to the one to evaluate. Null if the
 *                      evaluated hunk is the first one.
 */
export function getHunkHeaderExpansionType(
  hunkIndex: number,
  hunkHeader: DiffHunkHeader,
  previousHunk: DiffHunk | null,
): DiffHunkExpansionType {
  const distanceToPrevious =
    previousHunk === null
      ? Infinity
      : hunkHeader.oldStartLine -
        previousHunk.header.oldStartLine -
        previousHunk.header.oldLineCount;

  // In order to simplify the whole logic around expansion, only the hunk at the
  // top can be expanded up exclusively, and only the hunk at the bottom (the
  // dummy one, see getTextDiffWithBottomDummyHunk) can be expanded down
  // exclusively.
  // The rest of the hunks can be expanded both ways, except those which are too
  // short and therefore the direction of expansion doesn't matter.
  if (hunkIndex === 0) {
    // The top hunk can only be expanded if there is content above it
    if (hunkHeader.oldStartLine > 1 && hunkHeader.newStartLine > 1) {
      return DiffHunkExpansionType.Up;
    } else {
      return DiffHunkExpansionType.None;
    }
  } else if (distanceToPrevious <= DefaultDiffExpansionStep) {
    return DiffHunkExpansionType.Short;
  } else {
    return DiffHunkExpansionType.Both;
  }
}

/** Utility function for getting the digit count of the largest line number in an array of diff hunks */
export function getLargestLineNumber(hunks: DiffHunk[]): number {
  if (hunks.length === 0) {
    return 0;
  }

  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i];

    for (let j = hunk.lines.length - 1; j >= 0; j--) {
      const line = hunk.lines[j];

      if (line.type === DiffLineType.Hunk) {
        continue;
      }

      const newLineNumber = line.newLineNumber ?? 0;
      const oldLineNumber = line.oldLineNumber ?? 0;
      return newLineNumber > oldLineNumber ? newLineNumber : oldLineNumber;
    }
  }

  return 0;
}
