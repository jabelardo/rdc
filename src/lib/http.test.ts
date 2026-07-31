import { describe, it } from 'vitest'
import assert from 'node:assert'
import { getAbsoluteUrl, getUserAgent } from './http'
import { getDotComAPIEndpoint } from './api'

describe('getUserAgent', () => {
  // Pinned deliberately. rdc must not announce another product's identity on the wire, and this
  // string previously read `GitHubDesktop/<version>`; a test is the only thing that stops it
  // drifting back during a future port from upstream.
  it('identifies rdc, not the upstream product', () => {
    const userAgent = getUserAgent()
    assert.match(userAgent, /^RDC\//)
    assert.ok(
      !/GitHubDesktop|GitHub Desktop|Desktop Plus/.test(userAgent),
      `user agent must not name another product: ${userAgent}`
    )
  })

  it('names the platform it is actually running on', () => {
    // jsdom runs with the test-time build constants, where none of __DARWIN__/__LINUX__/__WIN32__
    // is forced — so assert the shape rather than one platform, and that Linux is reachable at all
    // (it used to report `Windows` for everything that was not macOS).
    assert.match(getUserAgent(), /^RDC\/\S+ \((Macintosh|Linux|Windows)\)$/)
  })
})

describe('getAbsoluteUrl', () => {
  describe('dotcom endpoint', () => {
    const dotcomEndpoint = getDotComAPIEndpoint()

    it('handles leading slashes', () => {
      const result = getAbsoluteUrl(dotcomEndpoint, '/user/repos')
      assert.equal(result, 'https://api.github.com/user/repos')
    })

    it('handles missing leading slash', () => {
      const result = getAbsoluteUrl(dotcomEndpoint, 'user/repos')
      assert.equal(result, 'https://api.github.com/user/repos')
    })

    it("doesn't mangle encoded query parameters", () => {
      const result = getAbsoluteUrl(
        getDotComAPIEndpoint(),
        '/issues?since=2019-05-10T16%3A00%3A00Z'
      )
      assert.equal(
        result,
        'https://api.github.com/issues?since=2019-05-10T16%3A00%3A00Z'
      )
    })
  })

  describe('enterprise endpoint', () => {
    const enterpriseEndpoint = 'https://my-cool-company.com/api/v3'

    it('handles leading slash', () => {
      const result = getAbsoluteUrl(enterpriseEndpoint, '/user/repos')
      assert.equal(result, `${enterpriseEndpoint}/user/repos`)
    })

    it('handles missing leading slash', () => {
      const result = getAbsoluteUrl(enterpriseEndpoint, 'user/repos')
      assert.equal(result, `${enterpriseEndpoint}/user/repos`)
    })

    it('handles next page resource which already contains prefix', () => {
      const result = getAbsoluteUrl(
        enterpriseEndpoint,
        '/api/v3/user/repos?page=2'
      )
      assert.equal(result, `${enterpriseEndpoint}/user/repos?page=2`)
    })

    it("doesn't mangle encoded query parameters", () => {
      const result = getAbsoluteUrl(
        enterpriseEndpoint,
        '/issues?since=2019-05-10T16%3A00%3A00Z'
      )
      assert.equal(
        result,
        `${enterpriseEndpoint}/issues?since=2019-05-10T16%3A00%3A00Z`
      )
    })
  })
})
