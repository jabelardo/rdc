// Application shell: launch, the Phase 5a security boundary, directory isolation, and the two
// native-menu surfaces. Nothing here needs a repository.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { after, before, describe, it } from 'node:test'
import { By, Key, until } from 'selenium-webdriver'
import {
  resetRepositoryFixtures,
  sendNativeKeys,
  startApplication,
} from './harness.mjs'

describe('application shell', () => {
  let driver

  before(async () => {
    driver = await startApplication()
    // Start from no registered repositories, the state this spec's empty-shell assertions
    // were originally written against. See resetRepositoryFixtures.
    await resetRepositoryFixtures(driver)
    await driver.navigate().refresh()
    // The reload must finish before any assertion runs, or the first one races it and the
    // shell has no DOM yet.
    await driver.wait(
      until.elementLocated(
        By.css('main.application-shell [aria-label="Navigation"]')
      ),
      10_000
    )
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
  })

  it('launches the real Tauri application', async () => {
    assert.equal(await driver.getTitle(), 'RDC')
    assert.equal(
      await driver
        .findElements(
          By.css('main.application-shell [aria-label="Navigation"]')
        )
        .then(elements => elements.length),
      1
    )
  })

  it('keeps the empty shell aligned through sidebar collapse', async () => {
    const measure = () =>
      driver.executeScript(() => {
        const sidebar = document.querySelector('.repository-sidebar')
        const commandBar = document.querySelector('.sidebar-command-bar')
        const collapse = document.querySelector('.sidebar-collapse')
        const railSection = document.querySelector('.sidebar-icon-rail button')
        const workspace = document.querySelector('.repository-workspace')
        const actions = document.querySelector('.repository-empty-actions')
        const sidebarRect = sidebar.getBoundingClientRect()
        const collapseRect = collapse.getBoundingClientRect()
        const collapseStyle = getComputedStyle(collapse)
        const workspaceRect = workspace.getBoundingClientRect()
        const actionsRect = actions.getBoundingClientRect()
        return {
          sidebarBottom: sidebarRect.bottom,
          viewportBottom: window.innerHeight,
          collapseLeft: collapseRect.left,
          collapseRightGap: sidebarRect.right - collapseRect.right,
          commandBarRightPadding: Number.parseFloat(
            getComputedStyle(commandBar).paddingRight
          ),
          collapseCenterOffset:
            collapseRect.left +
            collapseRect.width / 2 -
            (sidebarRect.left + sidebarRect.width / 2),
          collapseWidth: collapseRect.width,
          collapseHeight: collapseRect.height,
          collapseBorderColor: collapseStyle.borderColor,
          collapseBackgroundColor: collapseStyle.backgroundColor,
          railSectionWidth: railSection?.getBoundingClientRect().width ?? null,
          railSectionHeight:
            railSection?.getBoundingClientRect().height ?? null,
          actionTopOffset: actionsRect.top - workspaceRect.top,
        }
      })

    const expanded = await measure()
    assert.ok(
      Math.abs(expanded.sidebarBottom - expanded.viewportBottom) <= 1,
      'the sidebar divider does not span the available window height'
    )
    assert.ok(
      expanded.actionTopOffset <= 48,
      'the empty-state actions sit too far below the workspace top'
    )
    assert.ok(
      Math.abs(expanded.collapseRightGap - expanded.commandBarRightPadding) <=
        1,
      'the expanded sidebar control is not right-aligned'
    )
    assert.equal(expanded.collapseBorderColor, 'rgba(0, 0, 0, 0)')
    assert.equal(expanded.collapseBackgroundColor, 'rgba(0, 0, 0, 0)')

    await driver
      .findElement(By.css('button[aria-label="Collapse sidebar"]'))
      .click()
    await driver.wait(
      until.elementLocated(By.css('button[aria-label="Expand sidebar"]')),
      5_000
    )
    const collapsed = await measure()
    assert.ok(
      Math.abs(collapsed.collapseCenterOffset) <= 1,
      'the collapsed sidebar control is not centered in the rail'
    )
    assert.equal(collapsed.collapseWidth, collapsed.railSectionWidth)
    assert.equal(collapsed.collapseHeight, collapsed.railSectionHeight)

    await driver
      .findElement(By.css('button[aria-label="Expand sidebar"]'))
      .click()
    await driver.wait(
      until.elementLocated(By.css('button[aria-label="Collapse sidebar"]')),
      5_000
    )
  })

  it('enforces the production CSP and freezes the shared prototype', async () => {
    const security = await driver.executeScript(() => ({
      inlineScriptBlocked: (() => {
        delete window.__rdcInlineCspProbe
        const script = document.createElement('script')
        script.textContent = 'window.__rdcInlineCspProbe = true'
        document.head.append(script)
        script.remove()
        return window.__rdcInlineCspProbe !== true
      })(),
      objectPrototypeFrozen: Object.isFrozen(Object.prototype),
    }))

    assert.equal(security.objectPrototypeFrozen, true)
    assert.equal(security.inlineScriptBlocked, true)
  })

  it('writes configuration and logs only to the isolated application directories', async () => {
    const config = await driver.executeAsyncScript(done => {
      window.__TAURI_INTERNALS__
        .invoke('update_main_process_config', {
          configDiff: { hideWindowOnQuit: false },
        })
        .then(done, error => done({ error: String(error) }))
    })
    assert.equal(config.hideWindowOnQuit, false)

    const configPath = path.join(
      process.env.XDG_CONFIG_HOME,
      'org.rdc',
      'main-process-config.json'
    )
    await driver.wait(
      () => existsSync(configPath),
      5_000,
      'main-process configuration was not written to app_config_dir'
    )
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      titleBarStyle: 'native',
      hideWindowOnQuit: false,
    })

    const logPath = path.join(
      process.env.XDG_DATA_HOME,
      'org.rdc',
      'logs',
      'RDC.log'
    )
    await driver.wait(
      () => existsSync(logPath),
      5_000,
      'renderer startup log was not written to app_log_dir'
    )
  })

  it('opens and dismisses the add-repository dialog from the application menu', async () => {
    sendNativeKeys('ctrl+o')
    await new Promise(resolve => setTimeout(resolve, 250))
    sendNativeKeys('Escape')

    await driver.wait(
      until.elementLocated(
        By.xpath("//button[normalize-space()='Create repository']")
      ),
      5_000
    )
  })

  it('opens MVP preferences from the native menu and applies theme changes', async () => {
    sendNativeKeys('ctrl+comma')
    const preferences = await driver.wait(
      until.elementLocated(
        By.css('[role="dialog"][aria-labelledby="preferences-dialog-title"]')
      ),
      5_000
    )
    const theme = await preferences.findElement(By.css('#theme-preference'))
    await driver.wait(
      async () =>
        (await driver.switchTo().activeElement().getAttribute('id')) ===
        'theme-preference',
      5_000,
      'preferences did not place focus on its first control'
    )
    await theme.sendKeys(Key.chord(Key.SHIFT, Key.TAB))
    assert.equal(await driver.switchTo().activeElement().getText(), 'Close')
    await driver.switchTo().activeElement().sendKeys(Key.TAB)
    assert.equal(
      await driver.switchTo().activeElement().getAttribute('id'),
      'theme-preference'
    )
    await driver.executeScript(select => {
      select.value = 'dark'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, theme)
    await driver.wait(
      async () =>
        (await driver
          .findElement(By.css('html'))
          .getAttribute('data-theme')) === 'dark',
      5_000,
      'dark theme preference was not applied'
    )
    await driver.executeScript(select => {
      select.value = 'system'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, theme)
    await theme.sendKeys(Key.ESCAPE)
    await driver.wait(
      until.stalenessOf(preferences),
      5_000,
      'preferences dialog did not close'
    )
  })
})
