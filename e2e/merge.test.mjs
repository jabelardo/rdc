// Merge initiation: a clean branch is merged into the current branch from the
// Branch menu, and HEAD advances to the merged branch's tip (fast-forward).
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

// React-controlled <select>: Selenium's Select can attach its value without firing
// the change React listens for, leaving the controlled state empty. Go through the
// native value setter and dispatch a bubbling 'change' so the picker's state updates.
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

describe('merge', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    const initialBranch = git(fixture.canonical, 'branch', '--show-current')
    const mergeBranch = 'phase-7d-merge'
    git(fixture.canonical, 'branch', mergeBranch)
    git(fixture.canonical, 'checkout', '--quiet', mergeBranch)
    writeFileSync(
      path.join(fixture.canonical, 'merged-content.txt'),
      'feature content\n'
    )
    git(fixture.canonical, 'add', 'merged-content.txt')
    git(fixture.canonical, 'commit', '--quiet', '--no-verify', '-m', 'Feature')
    git(fixture.canonical, 'checkout', '--quiet', initialBranch)
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('merges a clean branch into the current one from the Branch menu', async () => {
    const base = git(fixture.canonical, 'rev-parse', 'HEAD')
    await clickMenuItem(driver, 'Branch')
    await clickMenuItem(driver, 'Merge into current branch…')
    await driver.wait(
      until.elementLocated(By.css('#merge-target-branch')),
      5_000
    )
    await selectReactOption(driver, 'merge-target-branch', 'phase-7d-merge')
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
    const target = git(fixture.canonical, 'rev-parse', 'phase-7d-merge')
    await driver.wait(
      () => git(fixture.canonical, 'rev-parse', 'HEAD') === target,
      10_000,
      'working HEAD did not advance to the merged branch'
    )
    assert.notEqual(target, base, 'merge should have advanced the branch')
    assert.match(git(fixture.canonical, 'log', '-1', '--format=%s'), /Feature/)
    assert.equal(
      git(fixture.canonical, 'status', '--porcelain'),
      '',
      'a clean merge should leave the tree clean'
    )
  })
})
