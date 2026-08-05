/**
 * Possible statuses of an entry in the index, as `git diff-index` reports them.
 *
 * MIGRATION NOTE (layering fix): in desktop-plus this enum lived in `lib/git/diff-index.ts`,
 * alongside the function that produced it. That module is backend-bound and is now
 * `src-tauri/crates/git-ops/src/diff_index.rs`, so the enum had nowhere to live on the frontend —
 * and an enum that crosses the IPC boundary is a domain type, not an implementation detail of the
 * command that returns it. It belongs here.
 *
 * The numeric values are the wire representation: `IndexStatus` serializes as its discriminant, so
 * these numbers must match `IndexStatus` in `diff_index.rs`. Pinned by the wire snapshot.
 */
export enum IndexStatus {
  Unknown = 0,
  Added = 1,
  Copied = 2,
  Deleted = 3,
  Modified = 4,
  Renamed = 5,
  TypeChanged = 6,
  Unmerged = 7,
}

/**
 * Index statuses excluding renames and copies.
 *
 * `getIndexChanges` passes `--no-renames`, so git cannot report either — the Rust side rejects them
 * rather than returning a value this type would exclude.
 */
export type NoRenameIndexStatus =
  | IndexStatus.Added
  | IndexStatus.Deleted
  | IndexStatus.Modified
  | IndexStatus.TypeChanged
  | IndexStatus.Unmerged
  | IndexStatus.Unknown;
