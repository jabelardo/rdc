/**
 * How far a reset reaches.
 *
 * Ported from `desktop-plus/app/src/lib/git/reset.ts`, and it lives in `models/` for the same reason
 * `IndexStatus` does: an enum that crosses IPC is a domain type, and its old home is now Rust.
 *
 * A **numeric** enum, so it crosses as its discriminant — switching to variant names would leave every
 * `=== GitResetMode.Mixed` comparison false. The values are pinned by a wire-contract test.
 *
 * Note `Hard` is **0**, which is upstream's ordering: a missing or zeroed field selects the *destructive*
 * mode, so nothing should default this.
 */
export enum GitResetMode {
  /** Resets the index and the working tree, discarding changes to tracked files since the ref. */
  Hard = 0,

  /** Moves `HEAD` only. Everything that differs stays staged — "Changes to be committed". */
  Soft = 1,

  /** Resets the index but leaves the working tree. git's own default for `reset`. */
  Mixed = 2,
}
