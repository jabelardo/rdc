// Discard-all: the Branch menu's "Discard all changes" clears the whole working tree,
// tracked modifications and untracked files alike.
//
// The DOM click is deliberate (the pattern used throughout the suite): WebKitGTK sometimes
// accepts WebDriver's synthetic pointer click without dispatching the handler, and the
// working-tree store refreshes after the discard, replacing live nodes mid-poll.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

describe('discard-all', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    // One tracked modification plus one untracked file exercise the asymmetry: the tracked
    // change is reset and cannot be recovered, while the untracked file moves to the OS trash.
    writeFileSync(
      path.join(fixture.canonical, 'working-tree.txt'),
      'discard-all tracked modification\n'
    )
    writeFileSync(
      path.join(fixture.canonical, 'discard-all-untracked.txt'),
      'discard-all untracked file\n'
    )
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
    await driver.wait(
      until.elementLocated(
        By.css('[data-changed-file-path="working-tree.txt"]')
      ),
      5_000
    )
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('discards all changes from the Branch menu, tracked and untracked', async () => {
    await clickMenuItem(driver, 'Branch')
    await clickMenuItem(driver, 'Discard all changes…')
    await driver.wait(
      until.elementLocated(By.css('[role="alertdialog"]')),
      5_000
    )
    await driver.wait(
      async () => {
        try {
          const confirm = await driver.findElement(
            By.xpath("//button[normalize-space()='Discard changes']")
          )
          await driver.executeScript(element => element.click(), confirm)
          return true
        } catch {
          return false
        }
      },
      5_000,
      'discard-all confirmation did not accept the click'
    )
    await driver.wait(
      () => git(fixture.canonical, 'status', '--porcelain') === '',
      10_000,
      'discard-all left changes in the working tree'
    )
    assert.equal(
      readFileSync(path.join(fixture.canonical, 'working-tree.txt'), 'utf8'),
      'committed line\n'
    )
    assert.equal(
      existsSync(path.join(fixture.canonical, 'discard-all-untracked.txt')),
      false
    )
  })
})
