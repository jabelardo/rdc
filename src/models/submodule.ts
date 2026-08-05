/**
 * A submodule as `git submodule status` reports it.
 *
 * MIGRATION NOTE: `describe` is `string | null` here, where the original typed it `string`. git only
 * prints the parenthesised `git describe` value for a submodule that is checked out — an uninitialized
 * one is reported as `-<sha> <path>` and a conflicted one as `U<sha> <path>`, both without it.
 *
 * The original's parser *required* that value, so it silently dropped exactly those entries. That
 * mattered: the submodule list is what tells the discard-changes path a given path is a submodule and
 * must be reset rather than moved to the trash. See MIGRATION_MAP.md §8.
 */
export class SubmoduleEntry {
  public constructor(
    public readonly sha: string,
    public readonly path: string,
    /** `git describe` output, or `null` for an uninitialized or conflicted submodule. */
    public readonly describe: string | null,
  ) {}
}
