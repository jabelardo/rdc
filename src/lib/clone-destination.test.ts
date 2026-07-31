import { describe, expect, it } from 'vitest'
import { getCloneDirectoryName } from './clone-destination'

describe('getCloneDirectoryName', () => {
  it('uses the parsed repository name for hosted URLs', () => {
    expect(
      getCloneDirectoryName('https://example.com/org/repository.git')
    ).toBe('repository')
    expect(getCloneDirectoryName('git@example.com:org/repository.git')).toBe(
      'repository'
    )
  })

  it('uses a local bare repositories basename', () => {
    expect(getCloneDirectoryName('/tmp/source.git')).toBe('source')
  })

  it('returns null when no safe destination name can be inferred', () => {
    expect(getCloneDirectoryName('')).toBeNull()
    expect(getCloneDirectoryName('/')).toBeNull()
  })
})
