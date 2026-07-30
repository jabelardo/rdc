import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
let repositoryFixture

describe('native integration', () => {
  before(async () => {
    const fixtureRoot = mkdtempSync('/tmp/rdc-e2e-repository-')
    repositoryFixture = {
      canonical: path.join(fixtureRoot, 'repo'),
    }
    mkdirSync(repositoryFixture.canonical)
    execFileSync('git', ['init', '--quiet', repositoryFixture.canonical])

    driver = await startApplication()
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

  it('opens and dismisses the add-repository dialog from the application menu', async () => {
    sendNativeKeys('ctrl+o')
    await new Promise(resolve => setTimeout(resolve, 250))
    sendNativeKeys('Escape')

    await driver.wait(
      until.elementLocated(
        By.xpath(
          "//h2[normalize-space()='Add a repository to get started']"
        )
      ),
      5_000
    )
  })

  it('loads the persisted repository fixture into the real shell', async () => {
    const seeded = await seedRepositoryFixture()
    assert.deepEqual(seeded, { count: 1 })
    await driver.navigate().refresh()
    const persisted = await readRepositoryFixtures()
    assert.deepEqual(persisted.map(repository => repository.path), [
      repositoryFixture.canonical,
    ])
    await driver.wait(until.elementLocated(repositorySelector()), 5_000)
  })

  it('restores a repository after the application process restarts', async () => {
    stopApplication()
    await waitForApplicationExit()
    await driver.quit().catch(() => undefined)

    driver = await startApplication()
    await driver.wait(
      until.elementLocated(repositorySelector(true)),
      5_000
    )
  })
})

async function startApplication() {
  const capabilities = new Capabilities()
  capabilities.setBrowserName('wry')
  capabilities.set('tauri:options', { application })

  const applicationDriver = await new Builder()
    .usingServer('http://127.0.0.1:4444/')
    .withCapabilities(capabilities)
    .build()
  await applicationDriver.wait(
    until.elementLocated(By.css('main h1')),
    10_000
  )
  return applicationDriver
}

async function waitForApplicationExit() {
  await driver.wait(async () => {
    try {
      execFileSync('pgrep', ['-x', 'rdc'])
      return false
    } catch {
      return true
    }
  }, 5_000)
}

function stopApplication() {
  execFileSync('pkill', ['-x', 'rdc'])
}

function repositorySelector(selected = false) {
  return By.css(
    `[data-repository-path="${repositoryFixture.canonical}"]${
      selected ? '[aria-current="true"]' : ''
    }`
  )
}

function sendNativeKeys(...keys) {
  execFileSync('xdotool', ['key', '--delay', '150', ...keys])
}

async function seedRepositoryFixture() {
  return driver.executeAsyncScript((record, done) => {
    const request = indexedDB.open('rdc-repositories')
    request.onerror = () => done({ error: String(request.error) })
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('repositories', {
        keyPath: 'id',
        autoIncrement: true,
      })
      store.createIndex('path', 'path', { unique: true })
    }
    request.onsuccess = () => {
      const transaction = request.result.transaction(
        'repositories',
        'readwrite'
      )
      transaction.objectStore('repositories').put(record)
      transaction.onerror = () =>
        done({ error: String(transaction.error) })
      transaction.oncomplete = () => {
        const countRequest = request.result
          .transaction('repositories')
          .objectStore('repositories')
          .count()
        countRequest.onerror = () =>
          done({ error: String(countRequest.error) })
        countRequest.onsuccess = () => {
          request.result.close()
          done({ count: countRequest.result })
        }
      }
    }
  }, {
    path: repositoryFixture.canonical,
    gitDir: path.join(repositoryFixture.canonical, '.git'),
    missing: false,
    alias: null,
    groupName: null,
    defaultBranch: null,
  })
}

async function readRepositoryFixtures() {
  return driver.executeAsyncScript(done => {
    const request = indexedDB.open('rdc-repositories')
    request.onerror = () => done([])
    request.onsuccess = () => {
      const records = request.result
        .transaction('repositories')
        .objectStore('repositories')
        .getAll()
      records.onerror = () => done([])
      records.onsuccess = () => {
        request.result.close()
        done(records.result)
      }
    }
  })
}
