/**
 * Pure string path helpers.
 *
 * MIGRATION NOTE: several ported models used Node's `path` for nothing more than string
 * manipulation. Node's `path` doesn't exist in a webview, and pulling in a polyfill for a couple of
 * `basename` calls isn't worth it — so the small, well-understood operations live here.
 *
 * Deliberately limited to operations that are genuinely simple. In particular there is **no
 * `normalize`/`resolve` here**: their edge cases (`..` beyond the root, drive letters, UNC paths)
 * are exactly where hand-rolled path code goes wrong. Anything needing those should ask Rust, which
 * has `std::path` — see `rev_parse::resolve_git_dir` for the pattern.
 */

/**
 * The last segment of a path, optionally with a suffix removed.
 *
 * Mirrors Node's `path.basename`, including its trailing-separator handling:
 * `basename('/foo/bar/')` is `'bar'`.
 *
 * Separator handling is platform-correct rather than universal: `\` is only treated as a separator
 * on Windows, because on Unix a backslash is a legal character *in a filename* and splitting on it
 * would silently truncate paths.
 */
export function basename(path: string, suffix?: string): string {
  const separators = __WIN32__ ? ['/', '\\'] : ['/']

  // Node special-cases the suffix matching the *entire path* and returns an empty string, which is
  // why `basename('.git', '.git')` is `''` while `basename('/foo/.git', '.git')` is `'.git'`. The
  // asymmetry looks like a bug but is long-standing documented behaviour, and callers may depend on
  // it, so it's reproduced rather than "fixed".
  if (suffix !== undefined && suffix.length > 0 && suffix === path) {
    return ''
  }

  // Drop trailing separators first, so a path ending in one yields its last real segment.
  let end = path.length
  while (end > 0 && separators.includes(path[end - 1])) {
    end--
  }
  if (end === 0) {
    // The path was nothing but separators (e.g. '/'), which has no basename.
    return ''
  }

  let start = 0
  for (let i = end - 1; i >= 0; i--) {
    if (separators.includes(path[i])) {
      start = i + 1
      break
    }
  }

  let result = path.slice(start, end)

  // Node only strips the suffix when it isn't the entire basename.
  if (suffix !== undefined && suffix.length > 0 && result !== suffix) {
    if (result.endsWith(suffix)) {
      result = result.slice(0, result.length - suffix.length)
    }
  }

  return result
}
