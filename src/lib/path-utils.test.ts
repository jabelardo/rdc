import { describe, expect, it } from 'vitest'
import { basename as nodeBasename } from 'node:path/posix'
import { basename } from './path-utils'

// These run on macOS/Linux, so __WIN32__ is false and the helper should match POSIX semantics
// exactly. Comparing against Node's own posix implementation is a stronger check than hand-written
// expectations, since the point of this helper is to behave like the thing it replaced.
describe('basename', () => {
  const cases = [
    '/foo/bar/baz.txt',
    '/foo/bar/',
    '/foo/bar//',
    'baz.txt',
    '/',
    '//',
    '',
    'a',
    '/a',
    'foo/bar/.hidden',
    '/foo/bar/name.with.dots.ts',
    'relative/path/to/thing',
    // A backslash is a legal filename character on Unix and must NOT split.
    'weird\\name',
    '/foo/weird\\name',
  ]

  it.each(cases)('matches node:path/posix for %j', path => {
    expect(basename(path)).toBe(nodeBasename(path))
  })

  const suffixCases: Array<[string, string]> = [
    ['/foo/bar/baz.txt', '.txt'],
    ['/foo/bar/baz.txt', '.md'],
    ['repo.git', '.git'],
    // Node does not strip when the suffix is the whole basename.
    ['.git', '.git'],
    ['/foo/.git', '.git'],
    ['baz', ''],
  ]

  it.each(suffixCases)(
    'matches node:path/posix for %j with suffix %j',
    (path, suffix) => {
      expect(basename(path, suffix)).toBe(nodeBasename(path, suffix))
    }
  )

  it('returns the last segment for a plain path', () => {
    expect(basename('/foo/bar/baz.txt')).toBe('baz.txt')
  })

  it('ignores trailing separators', () => {
    expect(basename('/foo/bar/')).toBe('bar')
  })

  it('has no basename for a root path', () => {
    expect(basename('/')).toBe('')
  })

  it('strips a suffix when it is not the whole name', () => {
    expect(basename('repo.git', '.git')).toBe('repo')
  })

  it("reproduces node's asymmetric whole-path suffix rule", () => {
    // Node returns '' when the suffix equals the entire path, but returns the basename unchanged
    // when the suffix merely equals the basename. Surprising, but long-standing behaviour.
    expect(basename('.git', '.git')).toBe('')
    expect(basename('/foo/.git', '.git')).toBe('.git')
  })
})
