// Large lists: the measured Phase 7e contract. A thousand changed files and 250 extra
// repositories must stay windowed, and `End` must still reveal and select the final row.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { By, Key, until } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  seedRepositoryScaleFixture,
  selectRepository,
  startApplication,
  expandRepositoriesPanel,
} from './harness.mjs'

const largeFileCount = 1_000

describe('large lists', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
    // Make this repository the persisted selection before the scale records arrive, so the
    // measured reload shows its changed files rather than an arbitrary repository's.
    await selectRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('bounds representative large repository and change lists while preserving End navigation', async () => {
    for (let index = 0; index < largeFileCount; index++) {
      writeFileSync(
        path.join(
          fixture.canonical,
          `large-${String(index).padStart(4, '0')}.txt`
        ),
        `large fixture ${index}\n`
      )
    }
    await seedRepositoryScaleFixture(driver, 250)

    const loadStarted = Date.now()
    await driver.navigate().refresh()
    // The refresh boots the app with every sidebar section collapsed again.
    await expandRepositoriesPanel(driver)
    const changedList = await driver.wait(
      until.elementLocated(
        By.css('[aria-label="Changed files"][data-virtualized="true"]')
      ),
      10_000,
      'the thousand-file fixture did not reach the virtualized list'
    )
    const repositoryList = await driver.wait(
      until.elementLocated(
        By.css('[aria-label="Repositories"][data-virtualized="true"]')
      ),
      10_000,
      'the repository fixture did not reach the virtualized list'
    )
    assert.ok(
      Date.now() - loadStarted < 10_000,
      'representative large-list load exceeded ten seconds'
    )
    assert.ok(
      (await changedList.findElements(By.css('[data-changed-file-path]')))
        .length < 40,
      'the thousand-file fixture rendered an unbounded DOM list'
    )
    assert.ok(
      (await repositoryList.findElements(By.css('.repository-list-item')))
        .length < 40,
      'the repository fixture rendered an unbounded DOM list'
    )

    const selectedFile = await changedList.findElement(
      By.css('[data-keyboard-list-item][tabindex="0"]')
    )
    const navigationStarted = Date.now()
    await selectedFile.sendKeys(Key.END)
    const lastPath = `large-${String(largeFileCount - 1).padStart(4, '0')}.txt`
    await driver.wait(
      until.elementLocated(
        By.css(`[data-changed-file-path="${lastPath}"] [aria-current="true"]`)
      ),
      5_000,
      'End did not select and reveal the final virtualized file'
    )
    assert.ok(
      Date.now() - navigationStarted < 5_000,
      'virtualized End navigation exceeded five seconds'
    )
  })
})
