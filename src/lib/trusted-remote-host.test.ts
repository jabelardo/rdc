import { describe, expect, it } from 'vitest'
import { isTrustedRemoteHost } from './trusted-remote-host'

describe('trusted remote hosts', () => {
  it.each([
    'https://github.com/owner/repository',
    'https://gist.github.com/owner/id',
    'https://dev.azure.com/owner/repository',
    'https://subdomain.gitlab.com/owner/repository',
    'https://bitbucket.org/owner/repository',
  ])('accepts %s', url => {
    expect(isTrustedRemoteHost(url)).toBe(true)
  })

  it.each([
    'http://github.com/owner/repository',
    'https://github.com.example.test/repository',
    'https://example.test/repository',
    'not a URL',
  ])('rejects %s', url => {
    expect(isTrustedRemoteHost(url)).toBe(false)
  })
})
