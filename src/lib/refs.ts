/**
 * Ref-name formatting.
 *
 * Ported from the pure half of `desktop-plus/app/src/lib/git/refs.ts`. The other half — reading a symbolic
 * ref — runs git, so it is a command in `branch-ipc.ts`.
 *
 * This stays TypeScript rather than becoming a command because it computes a string from a string: a round
 * trip to Rust for that would be latency and a wire contract in exchange for nothing. `git-ops` has its own
 * copy for the branch operations that need it internally, which is two implementations of one rule — accepted
 * here, unlike the diff-expansion case, because the rule is four lines and pinned on both sides.
 */

/**
 * Fully qualifies a local branch name as a ref.
 *
 * git usually reports the short name, but includes a `heads/` prefix when a short name would be ambiguous
 * with a remote ref of the same name — so both spellings have to arrive at `refs/heads/<name>`.
 */
export function formatAsLocalRef(name: string): string {
  if (name.startsWith('heads/')) {
    // Git reported it this way to disambiguate from a remote ref.
    return `refs/${name}`
  }

  if (!name.startsWith('refs/heads/')) {
    // Git drops the `heads/` prefix unless it has to include it.
    return `refs/heads/${name}`
  }

  return name
}
