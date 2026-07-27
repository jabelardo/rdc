/**
 * Commit-message trailers — the `Key: value` lines at the end of a commit message.
 *
 * MIGRATION NOTE (layering fix): in desktop-plus these two declarations lived in
 * `lib/git/interpret-trailers.ts`, alongside the functions that actually shell out to
 * `git interpret-trailers`. `models/commit.ts` imported *only* these two, and that single edge
 * pulled the entire git layer into the commit model — and transitively into several tests, which is
 * why `create-branch-test` and `pull-request-refs-test` were blocked for two whole phases.
 *
 * Neither of these needs git: `ITrailer` is a plain pair of strings, and `isCoAuthoredByTrailer` is
 * a case-insensitive token comparison. Everything in that module that genuinely runs git now lives
 * in `crates/git-ops/src/interpret_trailers.rs`.
 *
 * Phase 3 note: `Trailer` also exists on the Rust side, since commands need to return trailers.
 * When binding generation lands, this declaration should become the generated one rather than being
 * maintained by hand in two places.
 */

/**
 * A representation of a Git commit message trailer.
 *
 * See git-interpret-trailers for more information.
 */
export interface ITrailer {
  readonly token: string
  readonly value: string
}

/**
 * Gets a value indicating whether the trailer token is
 * Co-Authored-By. Does not validate the token value.
 */
export function isCoAuthoredByTrailer(trailer: ITrailer) {
  return trailer.token.toLowerCase() === 'co-authored-by'
}
