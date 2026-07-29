import { describe, expect, it } from 'vitest'
import {
  isCoAuthoredByTrailer,
  parseSingleUnfoldedTrailer,
} from './trailer'

/**
 * The same cases as `git_ops::interpret_trailers`' unit tests, because both sides parse trailers and
 * they have to agree: Rust does it for `parse_trailers`, which reads a whole commit message, and this
 * does it for the per-line scan in the commit-message store. A disagreement would show up as a
 * co-author that appears in one place and not the other.
 */
describe('parseSingleUnfoldedTrailer', () => {
  it('parses a simple trailer', () => {
    expect(parseSingleUnfoldedTrailer('Co-Authored-By: Jane', ':')).toEqual({
      token: 'Co-Authored-By',
      value: 'Jane',
    })
  })

  it('trims whitespace around the token and the value', () => {
    expect(
      parseSingleUnfoldedTrailer('  Token  :   value  ', ':')
    ).toEqual({ token: 'Token', value: 'value' })
  })

  it('rejects a line with no separator', () => {
    expect(parseSingleUnfoldedTrailer('not a trailer', ':')).toBeNull()
  })

  it('rejects a line whose separator comes first, since the token would be empty', () => {
    expect(parseSingleUnfoldedTrailer(': value', ':')).toBeNull()
  })

  it('honours alternative separators', () => {
    // `trailer.separators` is configurable; any listed character may separate.
    expect(parseSingleUnfoldedTrailer('Token=value', ':=')).toEqual({
      token: 'Token',
      value: 'value',
    })
    expect(parseSingleUnfoldedTrailer('Token#value', ':=#')).toEqual({
      token: 'Token',
      value: 'value',
    })
  })

  it('splits on the first separator only', () => {
    // A value may contain the separator itself — a URL after "Link:", for instance.
    expect(
      parseSingleUnfoldedTrailer('Link: https://example.com/x', ':')
    ).toEqual({ token: 'Link', value: 'https://example.com/x' })
  })

  it('handles a separator outside the BMP', () => {
    // The original advanced by one UTF-16 unit. An astral separator is a surrogate *pair*, so that
    // left a lone surrogate at the front of the value; advancing by the separator's own length is
    // what `git_ops::interpret_trailers` does with `len_utf8`.
    const clef = '\u{1D11E}'
    expect(clef).toHaveLength(2)

    expect(parseSingleUnfoldedTrailer(`Token${clef}value`, clef)).toEqual({
      token: 'Token',
      value: 'value',
    })
  })

  it('tries the separators in the order given', () => {
    // Both appear, and the first listed wins rather than the leftmost in the line.
    expect(parseSingleUnfoldedTrailer('a=b:c', ':=')).toEqual({
      token: 'a=b',
      value: 'c',
    })
    expect(parseSingleUnfoldedTrailer('a=b:c', '=:')).toEqual({
      token: 'a',
      value: 'b:c',
    })
  })

  it('feeds isCoAuthoredByTrailer, whatever the casing', () => {
    const trailer = parseSingleUnfoldedTrailer(
      'co-authored-by: Jane <jane@example.com>',
      ':'
    )

    expect(trailer).not.toBeNull()
    expect(isCoAuthoredByTrailer(trailer!)).toBe(true)
  })
})
