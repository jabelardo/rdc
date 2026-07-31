// Fetch: a user-initiated fetch advances the remote-tracking ref and surfaces the remote
// branch in the branch selector, without publishing anything.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { By, until } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  createPublisherClone,
  git,
  gitBare,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  publishCommit,
  removeFixtureRoot,
  startApplication,
} from './harness.mjs'

describe('remote fetch', () => {
  let driver
  let fixture
  let branch
  let remoteHead

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    branch = publishCanonical(fixture)
    createPublisherClone(fixture)

    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('fetches an updated branch from a local bare remote', async () => {
    // The remote advances *after* the application has loaded the repository, as in the original
    // journey. Doing it in `before()` would make the "local is behind" precondition depend on the
    // app never fetching on open — true today, but it would fail as an opaque `notEqual` the day
    // an auto-fetch is added, instead of failing at the behaviour under test.
    publishCommit(
      fixture,
      branch,
      'from-remote.txt',
      'arrived through fetch\n',
      'Advance the bare remote'
    )
    remoteHead = gitBare(fixture.remote, 'rev-parse', `refs/heads/${branch}`)

    const localRemoteRef = () =>
      git(fixture.canonical, 'rev-parse', `refs/remotes/origin/${branch}`)
    assert.notEqual(localRemoteRef(), remoteHead)

    const fetchButton = await driver.wait(
      until.elementLocated(
        By.xpath(
          "//section[@aria-label='Remote synchronization']//button[normalize-space()='Fetch']"
        )
      ),
      5_000
    )
    await driver.executeScript(element => element.click(), fetchButton)
    await driver.wait(
      () => localRemoteRef() === remoteHead,
      10_000,
      'fetch did not update the remote-tracking branch'
    )
    const remoteBranchOption = await driver.wait(
      until.elementLocated(
        By.xpath(
          `//select[@aria-label='Current branch']/option[contains(normalize-space(.), 'origin/${branch} (remote)')]`
        )
      ),
      10_000
    )
    assert.match(await remoteBranchOption.getText(), /\(remote\)$/)
  })
})
