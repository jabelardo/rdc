/**
 * Commit-message trailers — the `Key: value` lines at the end of a commit message.
 *
 * MIGRATION NOTE (layering fix): in desktop-plus these two declarations lived in
 * `lib/git/interpret-trailers.ts`, alongside the functions that actually shell out to
 * `git interpret-trailers`. `models/commit.ts` imported *only* these two, and that single edge
 * pulled the entire git layer into the commit model — and transitively into several tests, which is
 * why `create-branch-test` and `pull-request-refs-test` were blocked for two whole phases.
 *
 * None of what's here needs git: `ITrailer` is a plain pair of strings, `isCoAuthoredByTrailer` is a
 * case-insensitive token comparison, and `parseSingleUnfoldedTrailer` is a line parser. Everything in
 * that module that genuinely runs git now lives in `crates/git-ops/src/interpret_trailers.rs`.
 *
 * `Trailer` also exists on the Rust side because commands return trailers. Binding generation was
 * evaluated and rejected: this domain declaration remains authoritative in TypeScript, while Rust's
 * real serializer snapshot and TypeScript fixture tests pin the shared wire shape.
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

/**
 * Parses a single unfolded trailer line, or `null` if the line isn't one.
 *
 * `separators` is a set of *characters*, any of which may separate token from value — see git's
 * `trailer.separators` option, and {@linkcode getTrailerSeparatorCharacters} for reading it.
 *
 * **TypeScript rather than a command**, even though `git-ops` has the same function: upstream's
 * `git-store` calls this once per line while scanning a commit message, so a command would be a round
 * trip per line. The Rust copy stays because `parse_raw_unfolded_trailers` needs it there.
 *
 * The `> 0` bound is from the original and is load bearing: a separator at index 0 would mean an empty
 * token, so such a line isn't a trailer.
 */
export function parseSingleUnfoldedTrailer(
  line: string,
  separators: string
): ITrailer | null {
  for (const separator of separators) {
    const index = line.indexOf(separator)

    if (index > 0) {
      return {
        token: line.substring(0, index).trim(),
        // `separator.length` rather than the original's `index + 1`: iterating a string yields whole
        // code points, so a separator outside the BMP is two UTF-16 units and `+ 1` would slice the
        // surrogate pair in half — leaving a lone surrogate at the front of the value. Fixed the same
        // way in `git_ops::interpret_trailers`, which uses `len_utf8`.
        value: line.substring(index + separator.length).trim(),
      }
    }
  }

  return null
}
