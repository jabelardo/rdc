// Branches: creating a branch checks it out, and the branch selector checks out an existing one.
import assert from 'node:assert/strict'
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

describe('branches', () => {
  let driver
  let fixture
  let initialBranch

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    initialBranch = git(fixture.canonical, 'branch', '--show-current')
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
    const branchesHeading = await driver.findElement(
      By.css('#sidebar-branches-heading')
    )
    await branchesHeading.click()
    await driver.wait(
      async () =>
        (await branchesHeading.getAttribute('aria-expanded')) === 'true',
      5_000,
      'the Branches panel did not expand'
    )
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('creates and checks out a branch, then checks the original out again', async () => {
    const newBranchName = 'phase-7c-e2e'
    await driver.findElement(By.css('button[aria-label="New branch"]')).click()
    const newBranchInput = await driver.wait(
      until.elementLocated(By.css('#new-branch-name')),
      5_000
    )
    await newBranchInput.sendKeys(newBranchName)
    await driver
      .findElement(By.css('button[aria-label="Create branch"]'))
      .click()
    await driver.wait(
      () =>
        git(fixture.canonical, 'branch', '--show-current') === newBranchName,
      10_000,
      'new branch was not created and checked out'
    )

    const initialBranchButton = await driver.wait(
      until.elementLocated(By.css(`[data-branch-name="${initialBranch}"]`)),
      5_000,
      'the original branch did not appear in the branch list'
    )
    await initialBranchButton.click()
    await driver.wait(
      () =>
        git(fixture.canonical, 'branch', '--show-current') === initialBranch,
      10_000,
      'existing branch was not checked out'
    )
    assert.match(
      git(fixture.canonical, 'branch', '--list', newBranchName),
      new RegExp(newBranchName)
    )
  })
})
