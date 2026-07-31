// History: the commit list, the selected-commit details and its diff.
//
// The commit under test is created by CLI rather than through the commit form — that path is
// covered by working-tree.test.mjs, and this spec only needs the commit to exist.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { By, until } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  startApplication,
} from './harness.mjs'

describe('history', () => {
  let driver
  let fixture
  let head

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    head = commitWorkingTreeBaseline(fixture)
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('shows the commit, its details and its diff', async () => {
    const historyView = await driver.findElement(
      By.xpath(
        "//nav[@aria-label='Repository views']//button[normalize-space()='History']"
      )
    )
    await driver.executeScript(element => element.click(), historyView)

    const committedHistoryItem = await driver.wait(
      until.elementLocated(By.css(`[data-commit-sha="${head}"]`)),
      10_000
    )
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        committedHistoryItem
      ),
      /Commit from the real shell.*rdc E2E/s
    )

    const selectedCommitDetails = await driver.wait(
      until.elementLocated(By.css('[aria-label="Selected commit details"]')),
      10_000
    )
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        selectedCommitDetails
      ),
      /Commit from the real shell.*1 changed file.*working-tree\.txt/s
    )

    const commitDiff = await driver.wait(
      until.elementLocated(By.css('[aria-label="Diff for working-tree.txt"]')),
      10_000
    )
    assert.match(
      await driver.executeScript(element => element.textContent, commitDiff),
      /\+committed line/
    )
  })

  // The return trip matters on its own: `repositoryView` gates the changes workspace, so a
  // regression that leaves it stuck on 'history' would otherwise go unseen — no other spec
  // opens History and comes back.
  it('returns to the changes workspace from history', async () => {
    const changesView = await driver.findElement(
      By.xpath(
        "//nav[@aria-label='Repository views']//button[normalize-space()='Changes']"
      )
    )
    await driver.executeScript(element => element.click(), changesView)
    await driver.wait(
      until.elementLocated(
        By.xpath("//p[normalize-space()='No local changes.']")
      ),
      5_000,
      'the changes workspace did not come back after leaving history'
    )
  })
})
