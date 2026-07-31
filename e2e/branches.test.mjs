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
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('creates and checks out a branch, then checks the original out again', async () => {
    const newBranchName = 'phase-7c-e2e'
    const newBranchInput = await driver.wait(
      until.elementLocated(By.css('#new-branch-name')),
      5_000
    )
    await newBranchInput.sendKeys(newBranchName)
    await driver
      .findElement(By.xpath("//button[normalize-space()='Create branch']"))
      .click()
    await driver.wait(
      () =>
        git(fixture.canonical, 'branch', '--show-current') === newBranchName,
      10_000,
      'new branch was not created and checked out'
    )

    const branchSelector = await driver.findElement(
      By.css('select[aria-label="Current branch"]')
    )
    await driver.executeScript(
      (select, branchName) => {
        select.value = branchName
        select.dispatchEvent(new Event('change', { bubbles: true }))
      },
      branchSelector,
      initialBranch
    )
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
