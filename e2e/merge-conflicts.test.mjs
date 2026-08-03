// Minimum conflict recovery, reached through the product: the Branch menu's merge
// initiates a real conflict, the app surfaces the in-progress merge, refuses to
// stage an unresolved file, and stages the resolution once the markers are gone.
//
// This supersedes the previous spec, which started the merge with CLI `git merge`
// in `before` — the last MVP criterion satisfiable only from a terminal.
import assert from 'node:assert/strict'
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

async function clickMenuItem(driver, label) {
  await driver.wait(
    async () => {
      try {
        const item = await driver.findElement(
          By.css(`[role="menuitem"][aria-label="${label}"]`)
        )
        await driver.executeScript(element => element.click(), item)
        return true
      } catch {
        return false
      }
    },
    5_000,
    `menu item ${label} did not accept the click`
  )
}

// React-controlled <select>: go through the native value setter and dispatch a
// bubbling 'change' so the picker's controlled state actually updates.
async function selectReactOption(driver, id, value) {
  await driver.wait(
    async () => {
      try {
        const select = await driver.findElement(By.css(`#${id}`))
        await driver.executeScript(
          (element, val) => {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype,
              'value'
            ).set
            setter.call(element, val)
            element.dispatchEvent(new Event('change', { bubbles: true }))
          },
          select,
          value
        )
        return (
          (await driver
            .findElement(By.css(`#${id}`))
            .getAttribute('value')) === value
        )
      } catch {
        return false
      }
    },
    5_000,
    `could not select option ${value}`
  )
}

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
    assert.equal(git(fixture.canonical, 'status', '--porcelain'), '')

    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    try {
      git(fixture.canonical, 'merge', '--abort')
    } catch {
      // Cleanup only: if `before` failed before the merge there is nothing to
      // abort, and throwing here would mask the real failure.
    }
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('merges from the Branch menu into a conflict and stages the resolution', async () => {
    await clickMenuItem(driver, 'Branch')
    await clickMenuItem(driver, 'Merge into current branch…')
    const picker = await driver.wait(
      until.elementLocated(By.css('#merge-target-branch')),
      5_000
    )
    await selectReactOption(driver, 'merge-target-branch', 'phase-7c-conflict')
    await driver.wait(
      async () => {
        try {
          const merge = await driver.findElement(
            By.xpath("//button[normalize-space()='Merge']")
          )
          if (await merge.isEnabled()) {
            await driver.executeScript(element => element.click(), merge)
            return true
          }
          return false
        } catch {
          return false
        }
      },
      5_000,
      'merge confirm did not accept the click'
    )

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
