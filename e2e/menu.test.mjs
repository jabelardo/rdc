import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  Builder,
  By,
  Capabilities,
  Key,
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
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'config',
      'user.name',
      'rdc E2E',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'config',
      'user.email',
      'rdc-e2e@example.invalid',
    ])
    writeFileSync(
      path.join(repositoryFixture.canonical, 'working-tree.txt'),
      'committed line\nleft for partial discard\n'
    )
    const preCommitHook = path.join(
      repositoryFixture.canonical,
      '.git',
      'hooks',
      'pre-commit'
    )
    writeFileSync(
      preCommitHook,
      "#!/bin/sh\necho 'hook says no' >&2\nexit 7\n"
    )
    chmodSync(preCommitHook, 0o755)

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
    const changedFile = await driver.wait(
      until.elementLocated(
        By.css('[data-changed-file-path="working-tree.txt"]')
      ),
      5_000
    )
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        changedFile
      ),
      /working-tree\.txtNew/
    )
    const diff = await driver.wait(
      until.elementLocated(
        By.css('[aria-label="File diff"] [role="table"]')
      ),
      5_000
    )
    assert.match(
      await driver.executeScript(element => element.textContent, diff),
      /\+committed line.*\+left for partial discard/s
    )
    const includeFile = await driver.findElement(
      By.css(
        '[aria-label="Include working-tree.txt"]'
      )
    )
    assert.equal(await includeFile.isSelected(), true)
    await includeFile.click()
    await driver.wait(
      async () => !(await includeFile.isSelected()),
      5_000,
      'working-tree file did not become excluded'
    )
    await includeFile.click()
    await driver.wait(
      async () => await includeFile.isSelected(),
      5_000,
      'working-tree file did not become included'
    )
    const secondLine = await driver.findElement(
      By.css(
        '[aria-label="Include diff line 2: left for partial discard"]'
      )
    )
    assert.equal(await secondLine.isSelected(), true)
    // WebKitGTK occasionally accepts WebDriver's synthetic pointer click
    // without dispatching the checkbox change event while branch facts finish
    // their independent initial load. DOM click exercises the same product
    // handler deterministically.
    await driver.executeScript(element => element.click(), secondLine)
    await driver.wait(
      async () => !(await secondLine.isSelected()),
      5_000,
      'second diff line did not become excluded'
    )
    const commitMessage = await driver.findElement(
      By.css('#commit-message')
    )
    await commitMessage.sendKeys('Commit from the real shell')
    const useShellHooks = await driver.findElement(
      By.xpath(
        "//label[contains(normalize-space(.), 'Run hooks with the shell environment')]//input"
      )
    )
    await driver.executeScript(element => element.click(), useShellHooks)
    await driver.wait(
      async () => await useShellHooks.isSelected(),
      5_000,
      'shell hook option did not become selected'
    )
    const commitButton = await driver.findElement(
      By.xpath(
        "//button[normalize-space()='Commit included files']"
      )
    )
    await commitMessage.sendKeys(Key.ENTER)
    await driver.wait(
      until.elementTextIs(commitButton, 'Committing…'),
      5_000
    )
    let hookResult
    try {
      hookResult = await driver.wait(
        until.elementLocated(
          By.css('[role="alertdialog"], .commit-form .application-error')
        ),
        10_000
      )
    } catch (error) {
      const body = await driver.findElement(By.css('body')).getText()
      const gitStatus = String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'status',
          '--short',
        ])
      )
      throw new Error(
        `hook prompt did not surface; git status:\n${gitStatus}\napplication:\n${body}`,
        { cause: error }
      )
    }
    assert.equal(
      await hookResult.getAttribute('role'),
      'alertdialog',
      `hook interception failed before prompting: ${await hookResult.getText()}`
    )
    const hookFailure = hookResult
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        hookFailure
      ),
      /pre-commit.*hook says no/s
    )
    await driver
      .findElement(
        By.xpath("//button[normalize-space()='Ignore hook failure']")
      )
      .click()
    await driver.wait(
      async () => {
        try {
          return (
            String(
              execFileSync('git', [
                '-C',
                repositoryFixture.canonical,
                'log',
                '-1',
                '--pretty=%s',
              ])
            ).trim() === 'Commit from the real shell'
          )
        } catch {
          return false
        }
      },
      10_000
    )
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'log',
          '-1',
          '--pretty=%s',
        ])
      ).trim(),
      'Commit from the real shell'
    )
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'show',
          'HEAD:working-tree.txt',
        ])
      ),
      'committed line\n'
    )
    const historyView = await driver.findElement(
      By.xpath(
        "//nav[@aria-label='Repository views']//button[normalize-space()='History']"
      )
    )
    await driver.executeScript(element => element.click(), historyView)
    const committedHistoryItem = await driver.wait(
      until.elementLocated(
        By.css(`[data-commit-sha="${String(
          execFileSync('git', [
            '-C',
            repositoryFixture.canonical,
            'rev-parse',
            'HEAD',
          ])
        ).trim()}"]`)
      ),
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
      until.elementLocated(
        By.css('[aria-label="Selected commit details"]')
      ),
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
      until.elementLocated(
        By.css('[aria-label="Diff for working-tree.txt"]')
      ),
      10_000
    )
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        commitDiff
      ),
      /\+committed line/
    )
    const initialBranch = String(
      execFileSync('git', [
        '-C',
        repositoryFixture.canonical,
        'branch',
        '--show-current',
      ])
    ).trim()
    const newBranchName = 'phase-7c-e2e'
    const newBranchInput = await driver.findElement(
      By.css('#new-branch-name')
    )
    await newBranchInput.sendKeys(newBranchName)
    await driver
      .findElement(
        By.xpath("//button[normalize-space()='Create branch']")
      )
      .click()
    await driver.wait(
      async () =>
        String(
          execFileSync('git', [
            '-C',
            repositoryFixture.canonical,
            'branch',
            '--show-current',
          ])
        ).trim() === newBranchName,
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
      async () =>
        String(
          execFileSync('git', [
            '-C',
            repositoryFixture.canonical,
            'branch',
            '--show-current',
          ])
        ).trim() === initialBranch,
      10_000,
      'existing branch was not checked out'
    )
    assert.match(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'branch',
          '--list',
          newBranchName,
        ])
      ),
      new RegExp(newBranchName)
    )
    const changesView = await driver.findElement(
      By.xpath(
        "//nav[@aria-label='Repository views']//button[normalize-space()='Changes']"
      )
    )
    await driver.executeScript(element => element.click(), changesView)
    await driver.wait(
      until.elementLocated(
        By.css('[data-changed-file-path="working-tree.txt"]')
      ),
      5_000
    )
    const discardSelectedLines = await driver.wait(
      until.elementLocated(
        By.xpath("//button[normalize-space()='Discard selected lines']")
      ),
      5_000
    )
    await driver.wait(until.elementIsEnabled(discardSelectedLines), 5_000)
    await driver.executeScript(
      element => element.click(),
      discardSelectedLines
    )
    await driver.wait(
      until.elementLocated(By.css('[role="alertdialog"]')),
      5_000
    )
    await driver.wait(
      async () => {
        try {
          const discardChanges = await driver.findElement(
            By.xpath("//button[normalize-space()='Discard changes']")
          )
          await driver.executeScript(
            element => element.click(),
            discardChanges
          )
          return true
        } catch {
          // React may replace the dialog once while the checkout-triggered
          // working-tree refresh settles. Reacquire the live button.
          return false
        }
      },
      5_000,
      'discard confirmation did not accept the click'
    )
    await driver.wait(
      until.elementLocated(
        By.xpath("//p[normalize-space()='No local changes.']")
      ),
      10_000
    )

    const discardedPath = path.join(
      repositoryFixture.canonical,
      'discard-me.txt'
    )
    writeFileSync(discardedPath, 'recoverable change\n')
    await driver.navigate().refresh()
    await driver.wait(
      until.elementLocated(
        By.css('[data-changed-file-path="discard-me.txt"]')
      ),
      5_000
    )
    const discardFile = await driver.findElement(
      By.css('[aria-label="Discard discard-me.txt"]')
    )
    await driver.executeScript(element => element.click(), discardFile)
    await driver.wait(
      until.elementLocated(By.css('[role="alertdialog"]')),
      5_000
    )
    await driver
      .findElement(
        By.xpath("//button[normalize-space()='Discard changes']")
      )
      .click()
    await driver.wait(
      until.elementLocated(
        By.xpath("//p[normalize-space()='No local changes.']")
      ),
      10_000
    )
    assert.equal(existsSync(discardedPath), false)

    const conflictPath = path.join(
      repositoryFixture.canonical,
      'merge-conflict.txt'
    )
    writeFileSync(conflictPath, 'base\n')
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'add',
      'merge-conflict.txt',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Add conflict base',
    ])
    const conflictBranch = 'phase-7c-conflict'
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'branch',
      conflictBranch,
    ])
    writeFileSync(conflictPath, 'ours\n')
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-am',
      'Change conflict on current branch',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'checkout',
      '--quiet',
      conflictBranch,
    ])
    writeFileSync(conflictPath, 'theirs\n')
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-am',
      'Change conflict on other branch',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'checkout',
      '--quiet',
      initialBranch,
    ])
    assert.throws(() =>
      execFileSync('git', [
        '-C',
        repositoryFixture.canonical,
        'merge',
        '--no-edit',
        conflictBranch,
      ])
    )
    const refreshChanges = await driver.findElement(
      By.xpath("//button[normalize-space()='Refresh changes']")
    )
    await driver.executeScript(
      element => element.click(),
      refreshChanges
    )
    const mergeConflicts = await driver.wait(
      until.elementLocated(
        By.css('[aria-label="Merge conflicts"]')
      ),
      10_000
    )
    assert.match(
      await driver.executeScript(
        element => element.textContent,
        mergeConflicts
      ),
      /Merge in progress.*merge-conflict\.txt.*[1-9]\d* conflict markers?/s
    )
    const stageResolutionSelector = By.css(
      '[aria-label="Stage resolution for merge-conflict.txt"]'
    )
    assert.equal(
      await driver.findElement(stageResolutionSelector).isEnabled(),
      false
    )
    writeFileSync(conflictPath, 'resolved by rdc e2e\n')
    const refreshConflicts = await driver.findElement(
      By.xpath(
        "//button[normalize-space()='Refresh conflict state']"
      )
    )
    await driver.executeScript(
      element => element.click(),
      refreshConflicts
    )
    const stageResolution = await driver.wait(
      async () => {
        const button = await driver.findElement(stageResolutionSelector)
        return (await button.isEnabled()) ? button : false
      },
      10_000,
      'resolved conflict did not become stageable'
    )
    await driver.executeScript(
      element => element.click(),
      stageResolution
    )
    await driver.wait(
      () =>
        String(
          execFileSync('git', [
            '-C',
            repositoryFixture.canonical,
            'diff',
            '--name-only',
            '--diff-filter=U',
          ])
        ).trim() === '',
      10_000,
      'resolved conflict remained unmerged'
    )
    assert.match(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'diff',
          '--cached',
          '--name-only',
        ])
      ),
      /merge-conflict\.txt/
    )
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'merge',
      '--abort',
    ])
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
