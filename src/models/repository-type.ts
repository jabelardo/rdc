/**
 * What, if anything, lives at a path.
 *
 * Ported from `desktop-plus/app/src/lib/git/rev-parse.ts`, and it lives in `models/` for the reason
 * `IndexStatus` and `GitResetMode` do: a type that crosses IPC is a domain type, and its old home is now Rust.
 *
 * A discriminated union on a **lowercase** `kind`, which is the spelling the original used — and what
 * `git-ops` serializes, pinned by the wire snapshot.
 */
export type RepositoryType =
  | { readonly kind: 'bare' }
  | {
      readonly kind: 'regular'
      readonly topLevelWorkingDirectory: string
      readonly gitDir: string
    }
  /** Nothing usable: the path doesn't exist, isn't a directory, or isn't a repository. */
  | { readonly kind: 'missing' }
  /**
   * A repository git refuses because it's owned by a different user.
   *
   * `addSafeDirectory` is the only way out — see `src/lib/misc-ipc.ts`.
   */
  | { readonly kind: 'unsafe'; readonly path: string }
