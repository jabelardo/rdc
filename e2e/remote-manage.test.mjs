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

async function setInput(driver, id, value) {
  const input = await driver.wait(until.elementLocated(By.css(`#${id}`)), 5_000)
  await input.clear()
  await input.sendKeys(value)
}

describe('remote management', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    git(fixture.canonical, 'remote', 'remove', 'origin')
    assert.equal(git(fixture.canonical, 'remote'), '')
    driver = await startApplication()
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('adds a remote to a remote-less repository from the Repository menu', async () => {
    await clickMenuItem(driver, 'Repository')
    await clickMenuItem(driver, 'Manage remotes…')

    const manageDialog = await driver.wait(
      until.elementLocated(
        By.xpath("//*[@role='dialog' and .//*[@id='manage-remotes-title']]")
      ),
      5_000
    )
    assert.match(await manageDialog.getText(), /This repository has no remotes/)

    await driver
      .findElement(By.xpath("//button[normalize-space()='New remote']"))
      .click()

    await setInput(driver, 'add-remote-name', 'origin')
    await setInput(driver, 'add-remote-url', fixture.remote)
    await driver.wait(
      async () => {
        try {
          const add = await driver.findElement(
            By.xpath("//button[normalize-space()='Add remote']")
          )
          if (await add.isEnabled()) {
            await driver.executeScript(element => element.click(), add)
            return true
          }
          return false
        } catch {
          return false
        }
      },
      5_000,
      'add remote confirm did not accept the click'
    )

    await driver.wait(
      () =>
        git(fixture.canonical, 'remote') === 'origin' ||
        git(fixture.canonical, 'remote').includes('origin'),
      10_000,
      'new remote was not registered'
    )
    assert.match(git(fixture.canonical, 'remote'), /origin/)
  })
})
