import { describe, expect, it } from 'vitest'
import { formatAsLocalRef } from './refs'

/**
 * The same cases `crates/git-ops/src/refs.rs` asserts, because the rule is implemented in both languages —
 * TypeScript for the store layer, Rust for the branch operations that need it internally.
 */
describe('formatAsLocalRef', () => {
  it('qualifies a short name', () => {
    expect(formatAsLocalRef('main')).toBe('refs/heads/main')
  })

  it('qualifies the disambiguating form git sometimes reports', () => {
    // git includes `heads/` when a short name would be ambiguous with a remote ref of the same name.
    expect(formatAsLocalRef('heads/main')).toBe('refs/heads/main')
  })

  it('leaves an already-qualified ref alone', () => {
    expect(formatAsLocalRef('refs/heads/main')).toBe('refs/heads/main')
  })

  it('handles a branch name containing a slash', () => {
    expect(formatAsLocalRef('feature/thing')).toBe('refs/heads/feature/thing')
    expect(formatAsLocalRef('heads/feature/thing')).toBe(
      'refs/heads/feature/thing'
    )
  })
})
