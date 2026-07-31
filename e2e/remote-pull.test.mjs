// Pull: a tracked branch fast-forwards onto a commit that arrived on the remote.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { By } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  createPublisherClone,
  git,
  gitBare,
  gitRaw,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  publishCommit,
  removeFixtureRoot,
  startApplication,
} from './harness.mjs'

const pullBranch = 'phase-7d-push'

describe('remote pull', () => {
  let driver
  let fixture
  let remoteHead

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    publishCanonical(fixture)

    // Publish the branch the pull will happen on, with an upstream configured — the state
    // remote-push.test.mjs leaves behind, established here directly so the two are independent.
    git(fixture.canonical, 'checkout', '--quiet', '-b', pullBranch)
    writeFileSync(
      path.join(fixture.canonical, 'pushed-by-rdc.txt'),
      'this commit was pushed through rdc\n'
    )
    git(fixture.canonical, 'add', 'pushed-by-rdc.txt')
    git(
      fixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Push through rdc'
    )
    git(
      fixture.canonical,
      'push',
      '--set-upstream',
      'origin',
      `${pullBranch}:${pullBranch}`
    )

    createPublisherClone(fixture)
    git(fixture.publisher, 'fetch', '--quiet', 'origin', pullBranch)
    git(
      fixture.publisher,
      'checkout',
      '--quiet',
      '-b',
      pullBranch,
      '--track',
      `origin/${pullBranch}`
    )
    publishCommit(
      fixture,
      pullBranch,
      'pulled-by-rdc.txt',
      'this commit was pulled through rdc\n',
      'Pull through rdc'
    )
    remoteHead = gitBare(
      fixture.remote,
      'rev-parse',
      `refs/heads/${pullBranch}`
    )

    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('pulls a remote commit into the current working tree', async () => {
    const localHead = () => git(fixture.canonical, 'rev-parse', 'HEAD')
    assert.notEqual(localHead(), remoteHead)

    const pullButton = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(
            By.xpath(
              "//section[@aria-label='Remote synchronization']//button[normalize-space()='Pull']"
            )
          )
          return (await button.isEnabled()) ? button : false
        } catch {
          return false
        }
      },
      10_000,
      'pull did not become available for the tracked branch'
    )
    await driver.executeScript(element => element.click(), pullButton)
    await driver.wait(
      () => localHead() === remoteHead,
      10_000,
      'pull did not fast-forward the current branch'
    )
    assert.equal(
      gitRaw(fixture.canonical, 'show', 'HEAD:pulled-by-rdc.txt'),
      'this commit was pulled through rdc\n'
    )
  })
})
