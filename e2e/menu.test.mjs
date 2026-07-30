import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  Builder,
  By,
  Capabilities,
  until,
} from 'selenium-webdriver'

const application = path.resolve('src-tauri/target/debug/rdc')
let driver

describe('native integration', () => {
  before(async () => {
    const capabilities = new Capabilities()
    capabilities.setBrowserName('wry')
    capabilities.set('tauri:options', { application })

    driver = await new Builder()
      .usingServer('http://127.0.0.1:4444/')
      .withCapabilities(capabilities)
      .build()

    await driver.wait(until.elementLocated(By.css('main h1')), 10_000)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
  })

  it('launches the real Tauri application', async () => {
    const heading = await driver.findElement(By.css('main h1')).getText()
    assert.equal(heading, 'rdc')
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

  it('returns a nested contextual-menu selection to React', async () => {
    await openContextMenu()
    sendNativeKeys('Home', 'Down', 'Right', 'Home', 'Return')

    await waitForResult('Selected nested item')
  })

  it('returns dismissal to React', async () => {
    await openContextMenu()
    sendNativeKeys('Escape')

    await waitForResult('Contextual menu dismissed')
  })

  it('opens and dismisses a native directory dialog', async () => {
    await driver
      .findElement(By.css('[aria-label="Native dialog harness"] button'))
      .click()
    await new Promise(resolve => setTimeout(resolve, 250))
    sendNativeKeys('Escape')

    const output = await driver.findElement(
      By.css('[aria-label="Native dialog harness"] output')
    )
    await driver.wait(
      until.elementTextIs(output, 'Directory dialog dismissed'),
      5_000
    )
  })

  it('delivers a repository action to a fresh window and closes only that window', async () => {
    const originalWindow = await driver.getWindowHandle()
    const repositoryPath = '/tmp/repo/../repo'
    const input = await driver.findElement(
      By.css('input[placeholder="/path/to/a/git/repository"]')
    )
    await input.clear()
    await input.sendKeys(repositoryPath)
    await driver
      .findElement(By.css('[aria-label="Repository window harness"] button'))
      .click()

    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length === 2,
      5_000
    )
    const handles = await driver.getAllWindowHandles()
    const repositoryWindow = handles.find(handle => handle !== originalWindow)
    assert.ok(repositoryWindow)
    await driver.switchTo().window(repositoryWindow)

    const output = await driver.wait(
      until.elementLocated(
        By.css('[aria-label="Repository window harness"] output')
      ),
      5_000
    )
    await driver.wait(
      until.elementTextIs(
        output,
        `Open repository: ${repositoryPath}; persist selection: false`
      ),
      5_000
    )

    await driver
      .findElement(By.css('[aria-label="Application lifetime harness"] button'))
      .click()
    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length === 1,
      5_000
    )
    await driver.switchTo().window(originalWindow)
  })

  it('resolves a native close request in the frontend and exits', async () => {
    await driver
      .findElement(By.css('[aria-label="Application lifetime harness"] button'))
      .click()

    await driver.wait(async () => {
      try {
        execFileSync('pgrep', ['-x', 'rdc'])
        return false
      } catch {
        return true
      }
    }, 5_000)
  })
})

async function openContextMenu() {
  await driver
    .findElement(By.css('[aria-label="Native integration harness"] button'))
    .click()

  // Selenium's click returns when the JavaScript handler has opened the
  // native popup, but GTK needs one event-loop turn to establish its input grab.
  await new Promise(resolve => setTimeout(resolve, 250))
}

function sendNativeKeys(...keys) {
  execFileSync('xdotool', ['key', '--delay', '150', ...keys])
}

async function waitForResult(expected) {
  const output = await driver.findElement(
    By.css('[aria-label="Native integration harness"] output')
  )
  await driver.wait(until.elementTextIs(output, expected), 5_000)
}
