// Branch lifecycle: rename the current branch from the Branch menu, and verify the
// delete guard surfaces for the current branch.
//
// Rename is exercised end-to-end through the application menu (the renamed branch
// stays checked out, per git's `branch -m`). A successful delete of a *non-current*
// branch goes through the native branch-row context menu, which has no WebDriver
// backend, so the delete guard is proven here instead: the Branch menu's Delete
// targets the current branch and the product refuses it with an explicit dialog.
// The success path (delete + optional tracking-ref prune) is pinned by the
// branch-store unit tests.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { By, Key, until } from 'selenium-webdriver'
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

describe('branch lifecycle', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('renames the current branch and stays on it', async () => {
    const initial = git(fixture.canonical, 'branch', '--show-current')
    const newName = 'renamed-by-rdc'
    await clickMenuItem(driver, 'Branch')
    await clickMenuItem(driver, 'Rename…')
    const input = await driver.wait(
      until.elementLocated(By.css('#rename-branch-name')),
      5_000
    )
    const prefilled = await input.getAttribute('value')
    assert.equal(
      prefilled,
      initial,
      'rename input is not prefilled with current name'
    )
    await input.sendKeys(Key.chord(Key.CONTROL, 'a'))
    await input.sendKeys(newName)
    await driver.wait(
      async () => {
        try {
          const confirm = await driver.findElement(
            By.xpath("//button[normalize-space()='Rename']")
          )
          if (await confirm.isEnabled()) {
            await driver.executeScript(element => element.click(), confirm)
            return true
          }
          return false
        } catch {
          return false
        }
      },
      5_000,
      'rename confirmation did not accept the click'
    )
    await driver.wait(
      () => git(fixture.canonical, 'branch', '--show-current') === newName,
      10_000,
      'renamed branch was not made current'
    )
    assert.match(
      git(fixture.canonical, 'branch', '--list', newName),
      new RegExp(newName)
    )
    assert.equal(
      git(fixture.canonical, 'branch', '--list', initial),
      '',
      'the original branch name still exists after rename'
    )
  })

  it('refuses to delete the current branch from the menu', async () => {
    await clickMenuItem(driver, 'Branch')
    await clickMenuItem(driver, 'Delete…')
    await driver.wait(
      until.elementLocated(By.css('[role="alertdialog"]')),
      5_000
    )
    const current = git(fixture.canonical, 'branch', '--show-current')
    const body = await driver.findElement(By.css('body')).getText()
    assert.match(body, /cannot delete the current branch/)
    assert.match(
      body,
      new RegExp(`'${current}'`),
      'branch name missing from guard'
    )
    assert.match(
      git(fixture.canonical, 'branch', '--list', current),
      new RegExp(current),
      'the refused branch was unexpectedly deleted'
    )
    await driver
      .findElement(By.xpath("//button[normalize-space()='Close']"))
      .click()
  })
})
