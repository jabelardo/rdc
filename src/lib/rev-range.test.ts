import { describe, expect, it } from 'vitest'
import {
  revRange,
  revRangeInclusive,
  revSymmetricDifference,
} from './rev-range'

describe('git range syntax', () => {
  it('excludes the start of a two-dot range', () => {
    expect(revRange('main', 'topic')).toBe('main..topic')
  })

  it('includes the start of an inclusive range', () => {
    // The `^` is what pulls `from` back in, which is the only difference from revRange.
    expect(revRangeInclusive('main', 'topic')).toBe('main^..topic')
  })

  it('builds a symmetric difference', () => {
    expect(revSymmetricDifference('main', 'topic')).toBe('main...topic')
  })

  it('treats an empty end as HEAD, which is git syntax rather than a special case', () => {
    // `..topic` means "from HEAD", and the helpers pass that through untouched.
    expect(revRange('', 'topic')).toBe('..topic')
    expect(revSymmetricDifference('main', '')).toBe('main...')
  })
})
