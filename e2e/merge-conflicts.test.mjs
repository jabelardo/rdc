// Minimum conflict recovery: surfacing an in-progress merge, refusing to stage an unresolved
// file, and staging the resolution once the markers are gone.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { By, until } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  startApplication,
} from './harness.mjs'

describe('merge conflicts', () => {
  let driver
  let fixture
  let conflictPath

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)

    const initialBranch = git(fixture.canonical, 'branch', '--show-current')
    conflictPath = path.join(fixture.canonical, 'merge-conflict.txt')
    writeFileSync(conflictPath, 'base\n')
    git(fixture.canonical, 'add', 'merge-conflict.txt')
    git(
      fixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Add conflict base'
    )
    const conflictBranch = 'phase-7c-conflict'
    git(fixture.canonical, 'branch', conflictBranch)
    writeFileSync(conflictPath, 'ours\n')
    git(
      fixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-am',
      'Change conflict on current branch'
    )
    git(fixture.canonical, 'checkout', '--quiet', conflictBranch)
    writeFileSync(conflictPath, 'theirs\n')
    git(
      fixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-am',
      'Change conflict on other branch'
    )
    git(fixture.canonical, 'checkout', '--quiet', initialBranch)
    assert.throws(() =>
      execFileSync('git', [
        '-C',
        fixture.canonical,
        'merge',
        '--no-edit',
        conflictBranch,
      ])
    )

    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    try {
      git(fixture.canonical, 'merge', '--abort')
    } catch {
      // Cleanup only: if `before` failed before starting the merge there is nothing to abort,
      // and throwing here would mask the real failure.
    }
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('surfaces the in-progress merge and stages a resolved conflict', async () => {
    const refreshChanges = await driver.wait(
      until.elementLocated(
        By.xpath("//button[normalize-space()='Refresh changes']")
      ),
      5_000
    )
    await driver.executeScript(element => element.click(), refreshChanges)
    const mergeConflicts = await driver.wait(
      until.elementLocated(By.css('[aria-label="Merge conflicts"]')),
      10_000
    )
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        mergeConflicts
      ),
      /Merge in progress.*merge-conflict\.txt.*[1-9]\d* conflict markers?/s
    )

    const stageResolutionSelector = By.css(
      '[aria-label="Stage resolution for merge-conflict.txt"]'
    )
    assert.equal(
      await driver.findElement(stageResolutionSelector).isEnabled(),
      false
    )

    writeFileSync(conflictPath, 'resolved by rdc e2e\n')
    const refreshConflicts = await driver.findElement(
      By.xpath("//button[normalize-space()='Refresh conflict state']")
    )
    await driver.executeScript(element => element.click(), refreshConflicts)
    const stageResolution = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(stageResolutionSelector)
          return (await button.isEnabled()) ? button : false
        } catch {
          // The independent conflict and working-tree refreshes can replace
          // the row once. Reacquire the live button on the next poll.
          return false
        }
      },
      10_000,
      'resolved conflict did not become stageable'
    )
    await driver.executeScript(element => element.click(), stageResolution)
    await driver.wait(
      () =>
        git(fixture.canonical, 'diff', '--name-only', '--diff-filter=U') === '',
      10_000,
      'resolved conflict remained unmerged'
    )
    assert.match(
      git(fixture.canonical, 'diff', '--cached', '--name-only'),
      /merge-conflict\.txt/
    )
  })
})
