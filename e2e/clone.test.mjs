// Clone: the clone dialog produces a real repository, registers it and selects it.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { By, until } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  gitBare,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  removeFixtureRoot,
  startApplication,
} from './harness.mjs'

describe('clone', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    // The bare remote needs a HEAD and a branch before it can be cloned.
    publishCanonical(fixture)
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('clones the local bare remote and selects the persisted repository', async () => {
    await driver.findElement(By.css('[aria-label="Clone repository"]')).click()
    const cloneDialog = await driver.wait(
      until.elementLocated(
        By.xpath(
          "//section[@role='dialog' and @aria-labelledby='clone-dialog-title']"
        )
      ),
      5_000
    )
    await cloneDialog.findElement(By.css('#clone-url')).sendKeys(fixture.remote)
    await cloneDialog.findElement(By.css('#clone-path')).sendKeys(fixture.clone)
    await cloneDialog
      .findElement(
        By.xpath(".//button[@type='submit' and normalize-space()='Clone']")
      )
      .click()

    await driver.wait(
      until.elementLocated(
        By.css(`[data-repository-path="${fixture.clone}"][aria-current="true"]`)
      ),
      10_000
    )
    assert.equal(
      git(fixture.clone, 'remote', 'get-url', 'origin'),
      fixture.remote
    )
    assert.equal(
      git(fixture.clone, 'rev-parse', 'HEAD'),
      gitBare(fixture.remote, 'rev-parse', 'HEAD')
    )
  })
})
