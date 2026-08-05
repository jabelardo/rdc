/**
 * Git's range syntax, as strings.
 *
 * Ported from the pure half of `desktop-plus/app/src/lib/git/rev-list.ts`. These stay TypeScript because they
 * concatenate strings: a round trip to Rust would buy latency and a wire contract in exchange for nothing.
 * What the ranges are *for* — counting commits, listing them — is a command.
 *
 * Each end can be a SHA, a ref name, or an empty string to mean `HEAD`.
 */

/**
 * Commits reachable from `to` but not from `from`, excluding `from` itself.
 *
 * `from..to`.
 */
export function revRange(from: string, to: string): string {
  return `${from}..${to}`;
}

/**
 * Commits reachable from `to` but not from `from`, **including** `from`.
 *
 * `from^..to` — the `^` is what pulls `from` back into the range.
 */
export function revRangeInclusive(from: string, to: string): string {
  return `${from}^..${to}`;
}

/**
 * Commits reachable from either end but not both.
 *
 * `from...to`. The three-dot form goes back to the merge base, which is what makes ahead/behind counts see
 * "through" a merge rather than counting everything since the branches last touched.
 */
export function revSymmetricDifference(from: string, to: string): string {
  return `${from}...${to}`;
}
