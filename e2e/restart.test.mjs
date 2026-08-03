// Crash/restart recovery: the registered repositories and the *persisted selection* survive the
// application process being killed out of band.
//
// Two repositories, and the assertion is on the second one, on purpose. `AppStore.load()` resolves
// the selection as `find(id === lastSelectedID) ?? repositories[0] ?? null`, and
// `RepositoriesStore.getAll()` orders by `id`. With a single registered repository the
// `repositories[0]` fallback satisfies `[aria-current="true"]` whether or not the persisted id was
// read back — the assertion would pass even with persistence deleted outright. Selecting the
// *later-registered* repository makes the fallback the wrong answer, so only real persistence
// passes.
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { until } from 'selenium-webdriver'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  expandSidebarSection,
  initCanonicalRepository,
  initSimpleRepository,
  removeFixtureRoot,
  repositorySelector,
  resetRepositoryFixtures,
  seedRepositoryFixture,
  selectRepository,
  startApplication,
  stopApplication,
  waitForApplicationExit,
} from './harness.mjs'

describe('restart recovery', () => {
  let driver
  let fixture
  let secondRepository

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    secondRepository = path.join(path.dirname(fixture.canonical), 'second')
    initSimpleRepository(secondRepository)

    driver = await startApplication()
    await resetRepositoryFixtures(driver)
    // Seed in order: canonical takes the lower id, so it is what the fallback would choose.
    await seedRepositoryFixture(driver, fixture.canonical)
    await seedRepositoryFixture(driver, secondRepository)
    await driver.navigate().refresh()
    await selectRepository(driver, secondRepository)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('restores the persisted repository selection after the application process restarts', async () => {
    stopApplication()
    await waitForApplicationExit(driver)
    await driver.quit().catch(() => undefined)

    driver = await startApplication()
    // The relaunched window starts with the accordion closed, so expand Repositories before
    // asserting which row is current. Sidebar expansion is intentionally *not* persisted; the
    // selection is, and that is what this asserts.
    await expandSidebarSection(driver, 'repositories')
    await driver.wait(
      until.elementLocated(repositorySelector(secondRepository, true)),
      5_000
    )
  })
})
