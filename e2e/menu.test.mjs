import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
      remote: path.join(fixtureRoot, 'remote.git'),
      publisher: path.join(fixtureRoot, 'publisher'),
      clone: path.join(fixtureRoot, 'cloned'),
    }
    mkdirSync(repositoryFixture.canonical)
    execFileSync('git', ['init', '--quiet', repositoryFixture.canonical])
    execFileSync('git', [
      'init',
      '--bare',
      '--quiet',
      repositoryFixture.remote,
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'remote',
      'add',
      'origin',
      repositoryFixture.remote,
    ])
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
    assert.deepEqual(
      JSON.parse(readFileSync(configPath, 'utf8')),
      {
        titleBarStyle: 'native',
        hideWindowOnQuit: false,
      }
    )

    const logPath = path.join(
      process.env.XDG_DATA_HOME,
      'org.rdc',
      'logs',
      'rdc.log'
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
        By.xpath(
          "//h2[normalize-space()='Add a repository to get started']"
        )
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
    const theme = await preferences.findElement(
      By.css('#theme-preference')
    )
    await driver.wait(
      async () =>
        (await driver.switchTo().activeElement().getAttribute('id')) ===
        'theme-preference',
      5_000,
      'preferences did not place focus on its first control'
    )
    await theme.sendKeys(Key.chord(Key.SHIFT, Key.TAB))
    assert.equal(
      await driver.switchTo().activeElement().getText(),
      'Close'
    )
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
    await driver.executeScript(element => element.click(), includeFile)
    await driver.wait(
      async () => !(await includeFile.isSelected()),
      5_000,
      'working-tree file did not become excluded'
    )
    await driver.executeScript(element => element.click(), includeFile)
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
    await driver.wait(
      async () => {
        try {
          const remainingLine = await driver.findElement(
            By.css('[aria-label$="left for partial discard"]')
          )
          if (!(await remainingLine.isSelected())) {
            await driver.executeScript(
              element => element.click(),
              remainingLine
            )
          }
          return await remainingLine.isSelected()
        } catch {
          // Checkout refreshes replace the diff. Select the line only on
          // the live diff that will be sent to the discard command.
          return false
        }
      },
      5_000,
      'remaining diff line did not become selected for discard'
    )
    await driver.wait(
      async () => {
        try {
          const discardSelectedLines = await driver.findElement(
            By.xpath(
              "//button[normalize-space()='Discard selected lines']"
            )
          )
          if (!(await discardSelectedLines.isEnabled())) {
            return false
          }
          await driver.executeScript(
            element => element.click(),
            discardSelectedLines
          )
          return true
        } catch {
          // Independent store refreshes may replace this button. Reacquire
          // the live element before clicking it.
          return false
        }
      },
      5_000,
      'discard selected lines did not accept the click'
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
    try {
      await driver.wait(
        () =>
          String(
            execFileSync('git', [
              '-C',
              repositoryFixture.canonical,
              'status',
              '--porcelain',
            ])
          ).trim() === '',
        10_000,
        'discarded selection remained in the working tree'
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
      const workingTreeContents = String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'diff',
          '--',
          'working-tree.txt',
        ])
      )
      throw new Error(
        `discarded selection remained in the working tree; git status:\n${gitStatus}\ndiff:\n${workingTreeContents}\napplication:\n${body}`,
        { cause: error }
      )
    }
    await driver.navigate().refresh()
    await driver.wait(
      until.elementLocated(
        By.xpath("//p[normalize-space()='No local changes.']")
      ),
      5_000
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
      () => !existsSync(discardedPath),
      10_000,
      'discarded file remained on disk'
    )
    await driver.navigate().refresh()
    await driver.wait(
      until.elementLocated(
        By.xpath("//p[normalize-space()='No local changes.']")
      ),
      5_000
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
        try {
          const button = await driver.findElement(
            stageResolutionSelector
          )
          return (await button.isEnabled()) ? button : false
        } catch {
          // The independent conflict and working-tree refreshes can replace
          // the row once. Reacquire the live button on the next poll.
          return false
        }
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

  it('applies the visual tokens and compact workspace breakpoint', async () => {
    const normal = await driver.executeScript(() => {
      const root = getComputedStyle(document.documentElement)
      const toolbar = getComputedStyle(
        document.querySelector('.repository-toolbar')
      )
      return {
        fontSize: root.fontSize,
        fontFamily: root.fontFamily,
        canvas: root.getPropertyValue('--color-canvas').trim(),
        toolbar: toolbar.backgroundColor,
      }
    })
    assert.equal(normal.fontSize, '13px')
    assert.match(normal.fontFamily, /system-ui/)
    assert.notEqual(normal.toolbar, normal.canvas)

    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({
        width: 620,
        height: 720,
      })
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => matchMedia('(max-width: 52rem)').matches
          ),
        5_000,
        'compact workspace breakpoint did not activate'
      )
      const compact = await driver.executeScript(() => ({
        shellColumns: getComputedStyle(
          document.querySelector('.application-shell')
        ).gridTemplateColumns.split(' ').length,
        workspaceColumns: getComputedStyle(
          document.querySelector('.changes-workspace')
        ).gridTemplateColumns.split(' ').length,
      }))
      assert.deepEqual(compact, {
        shellColumns: 1,
        workspaceColumns: 1,
      })
    } finally {
      await driver.manage().window().setRect(originalRect)
    }
  })

  it('completes a local repository journey using only the keyboard', async () => {
    const keyboardPath = path.join(
      repositoryFixture.canonical,
      'keyboard-only.txt'
    )
    writeFileSync(keyboardPath, 'committed without pointer input\n')
    await driver.navigate().refresh()

    const changedFile = await driver.wait(
      until.elementLocated(
        By.css('[data-changed-file-path="keyboard-only.txt"]')
      ),
      5_000
    )
    const selection = await changedFile.findElement(
      By.css('[data-keyboard-list-item]')
    )
    await selection.sendKeys(Key.ENTER)
    await driver.wait(
      until.elementLocated(
        By.css(
          '[aria-label="Diff for keyboard-only.txt"], [aria-label="File diff"] [role="table"]'
        )
      ),
      5_000
    )

    const include = await changedFile.findElement(
      By.css('[aria-label="Include keyboard-only.txt"]')
    )
    assert.equal(await include.isSelected(), true)
    await include.sendKeys(Key.SPACE)
    await driver.wait(
      async () => !(await include.isSelected()),
      5_000,
      'Space did not exclude the changed file'
    )
    await include.sendKeys(Key.SPACE)
    await driver.wait(
      async () => await include.isSelected(),
      5_000,
      'Space did not include the changed file'
    )

    const message = 'Keyboard-only MVP journey'
    const commitMessage = await driver.findElement(
      By.css('#commit-message')
    )
    await commitMessage.sendKeys(message)
    const interceptHooks = await driver.findElement(
      By.xpath(
        "//label[contains(normalize-space(.), 'Run hooks with the shell environment')]//input"
      )
    )
    await interceptHooks.sendKeys(Key.SPACE)
    await driver.wait(
      async () => await interceptHooks.isSelected(),
      5_000,
      'Space did not enable hook interception'
    )
    await driver
      .findElement(
        By.xpath("//button[normalize-space()='Commit included files']")
      )
      .sendKeys(Key.ENTER)
    const hookDialog = await driver.wait(
      until.elementLocated(By.css('[role="alertdialog"]')),
      10_000
    )
    assert.match(await hookDialog.getText(), /pre-commit.*hook says no/s)

    await driver.switchTo().activeElement().sendKeys(Key.ESCAPE)
    assert.equal(await hookDialog.isDisplayed(), true)
    assert.equal(
      await driver.switchTo().activeElement().getText(),
      'Abort commit'
    )
    await driver.switchTo().activeElement().sendKeys(Key.TAB)
    assert.equal(
      await driver.switchTo().activeElement().getText(),
      'Ignore hook failure'
    )
    await driver.switchTo().activeElement().sendKeys(Key.ENTER)

    await driver.wait(
      () =>
        String(
          execFileSync('git', [
            '-C',
            repositoryFixture.canonical,
            'log',
            '-1',
            '--pretty=%s',
          ])
        ).trim() === message,
      10_000,
      'keyboard-submitted commit did not complete'
    )
    const history = await driver.findElement(
      By.xpath(
        "//nav[@aria-label='Repository views']//button[normalize-space()='History']"
      )
    )
    await history.sendKeys(Key.ENTER)
    await driver.wait(
      until.elementLocated(
        By.xpath(
          `//section[@aria-label='History']//strong[normalize-space()='${message}']`
        )
      ),
      10_000
    )
  })

  it('fetches an updated branch from a local bare remote', async () => {
    const branch = String(
      execFileSync('git', [
        '-C',
        repositoryFixture.canonical,
        'branch',
        '--show-current',
      ])
    ).trim()
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'push',
      '--set-upstream',
      'origin',
      `${branch}:${branch}`,
    ])
    execFileSync('git', [
      '--git-dir',
      repositoryFixture.remote,
      'symbolic-ref',
      'HEAD',
      `refs/heads/${branch}`,
    ])
    execFileSync('git', [
      'clone',
      '--quiet',
      repositoryFixture.remote,
      repositoryFixture.publisher,
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'config',
      'user.name',
      'rdc Remote E2E',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'config',
      'user.email',
      'rdc-remote-e2e@example.invalid',
    ])
    writeFileSync(
      path.join(repositoryFixture.publisher, 'from-remote.txt'),
      'arrived through fetch\n'
    )
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'add',
      'from-remote.txt',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'commit',
      '--quiet',
      '-m',
      'Advance the bare remote',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'push',
      '--quiet',
      'origin',
      branch,
    ])
    const remoteHead = String(
      execFileSync('git', [
        '--git-dir',
        repositoryFixture.remote,
        'rev-parse',
        `refs/heads/${branch}`,
      ])
    ).trim()
    const localRemoteRef = () =>
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'rev-parse',
          `refs/remotes/origin/${branch}`,
        ])
      ).trim()
    assert.notEqual(localRemoteRef(), remoteHead)

    const fetchButton = await driver.findElement(
      By.xpath(
        "//section[@aria-label='Remote synchronization']//button[normalize-space()='Fetch']"
      )
    )
    await driver.executeScript(element => element.click(), fetchButton)
    await driver.wait(
      () => localRemoteRef() === remoteHead,
      10_000,
      'fetch did not update the remote-tracking branch'
    )
    const remoteBranchOption = await driver.wait(
      until.elementLocated(
        By.xpath(
          `//select[@aria-label='Current branch']/option[contains(normalize-space(.), 'origin/${branch} (remote)')]`
        )
      ),
      10_000
    )
    assert.match(await remoteBranchOption.getText(), /\(remote\)$/)
  })

  it('pushes an unpublished branch to the local bare remote', async () => {
    const originalBranch = String(
      execFileSync('git', [
        '-C',
        repositoryFixture.canonical,
        'branch',
        '--show-current',
      ])
    ).trim()
    const pushBranch = 'phase-7d-push'
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'checkout',
      '--quiet',
      '--no-track',
      '-b',
      pushBranch,
      `origin/${originalBranch}`,
    ])
    writeFileSync(
      path.join(repositoryFixture.canonical, 'pushed-by-rdc.txt'),
      'this commit was pushed through rdc\n'
    )
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'add',
      'pushed-by-rdc.txt',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.canonical,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'Push through rdc',
    ])
    const localHead = String(
      execFileSync('git', [
        '-C',
        repositoryFixture.canonical,
        'rev-parse',
        'HEAD',
      ])
    ).trim()
    assert.throws(() =>
      execFileSync(
        'git',
        [
          '--git-dir',
          repositoryFixture.remote,
          'rev-parse',
          `refs/heads/${pushBranch}`,
        ],
        { stdio: 'ignore' }
      )
    )

    await driver.navigate().refresh()
    const pushButton = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(
            By.xpath(
              "//section[@aria-label='Remote synchronization']//button[normalize-space()='Push']"
            )
          )
          return (await button.isEnabled()) ? button : false
        } catch {
          return false
        }
      },
      10_000,
      'push did not become available for the new branch'
    )
    await driver.executeScript(element => element.click(), pushButton)
    await driver.wait(
      () => {
        try {
          execFileSync(
            'git',
            [
              '--git-dir',
              repositoryFixture.remote,
              'show-ref',
              '--verify',
              '--quiet',
              `refs/heads/${pushBranch}`,
            ],
            { stdio: 'ignore' }
          )
          return true
        } catch {
          return false
        }
      },
      10_000,
      'push did not create the branch in the bare remote'
    )
    assert.equal(
      String(
        execFileSync('git', [
          '--git-dir',
          repositoryFixture.remote,
          'rev-parse',
          `refs/heads/${pushBranch}`,
        ])
      ).trim(),
      localHead
    )
    const upstream = () => {
      try {
        return String(
          execFileSync(
            'git',
            [
              '-C',
              repositoryFixture.canonical,
              'rev-parse',
              '--abbrev-ref',
              '--symbolic-full-name',
              '@{upstream}',
            ],
            { stdio: ['ignore', 'pipe', 'ignore'] }
          )
        ).trim()
      } catch {
        return null
      }
    }
    await driver.wait(
      () => upstream() === `origin/${pushBranch}`,
      10_000,
      'push created the remote branch but did not configure its upstream'
    )
    assert.equal(
      upstream(),
      `origin/${pushBranch}`
    )
  })

  it('pulls a remote commit into the current working tree', async () => {
    const pullBranch = 'phase-7d-push'
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'fetch',
      '--quiet',
      'origin',
      pullBranch,
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'checkout',
      '--quiet',
      '-b',
      pullBranch,
      '--track',
      `origin/${pullBranch}`,
    ])
    writeFileSync(
      path.join(repositoryFixture.publisher, 'pulled-by-rdc.txt'),
      'this commit was pulled through rdc\n'
    )
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'add',
      'pulled-by-rdc.txt',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'commit',
      '--quiet',
      '-m',
      'Pull through rdc',
    ])
    execFileSync('git', [
      '-C',
      repositoryFixture.publisher,
      'push',
      '--quiet',
      'origin',
      pullBranch,
    ])
    const remoteHead = String(
      execFileSync('git', [
        '--git-dir',
        repositoryFixture.remote,
        'rev-parse',
        `refs/heads/${pullBranch}`,
      ])
    ).trim()
    const localHead = () =>
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'rev-parse',
          'HEAD',
        ])
      ).trim()
    assert.notEqual(localHead(), remoteHead)

    const pullButton = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(
            By.xpath(
              "//section[@aria-label='Remote synchronization']//button[normalize-space()='Pull']"
            )
          )
          return (await button.isEnabled()) ? button : false
        } catch {
          return false
        }
      },
      10_000,
      'pull did not become available for the tracked branch'
    )
    await driver.executeScript(element => element.click(), pullButton)
    await driver.wait(
      () => localHead() === remoteHead,
      10_000,
      'pull did not fast-forward the current branch'
    )
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.canonical,
          'show',
          'HEAD:pulled-by-rdc.txt',
        ])
      ),
      'this commit was pulled through rdc\n'
    )
  })

  it('clones the local bare remote and selects the persisted repository', async () => {
    await driver
      .findElement(By.css('[aria-label="Clone repository"]'))
      .click()
    const cloneDialog = await driver.wait(
      until.elementLocated(
        By.xpath(
          "//section[@role='dialog' and @aria-labelledby='clone-dialog-title']"
        )
      ),
      5_000
    )
    await cloneDialog
      .findElement(By.css('#clone-url'))
      .sendKeys(repositoryFixture.remote)
    await cloneDialog
      .findElement(By.css('#clone-path'))
      .sendKeys(repositoryFixture.clone)
    await cloneDialog
      .findElement(
        By.xpath(".//button[@type='submit' and normalize-space()='Clone']")
      )
      .click()

    await driver.wait(
      until.elementLocated(
        By.css(
          `[data-repository-path="${repositoryFixture.clone}"][aria-current="true"]`
        )
      ),
      10_000
    )
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.clone,
          'remote',
          'get-url',
          'origin',
        ])
      ).trim(),
      repositoryFixture.remote
    )
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          repositoryFixture.clone,
          'rev-parse',
          'HEAD',
        ])
      ).trim(),
      String(
        execFileSync('git', [
          '--git-dir',
          repositoryFixture.remote,
          'rev-parse',
          'HEAD',
        ])
      ).trim()
    )
  })

  it('restores a repository after the application process restarts', async () => {
    stopApplication()
    await waitForApplicationExit()
    await driver.quit().catch(() => undefined)

    driver = await startApplication()
    await driver.wait(
      until.elementLocated(
        repositorySelector(true, repositoryFixture.clone)
      ),
      5_000
    )
  })

  it('bounds representative large repository and change lists while preserving End navigation', async () => {
    const largeFileCount = 1_000
    for (let index = 0; index < largeFileCount; index++) {
      writeFileSync(
        path.join(
          repositoryFixture.clone,
          `large-${String(index).padStart(4, '0')}.txt`
        ),
        `large fixture ${index}\n`
      )
    }
    await seedRepositoryScaleFixture(250)

    const loadStarted = Date.now()
    await driver.navigate().refresh()
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
      (await changedList.findElements(
        By.css('[data-changed-file-path]')
      )).length < 40,
      'the thousand-file fixture rendered an unbounded DOM list'
    )
    assert.ok(
      (await repositoryList.findElements(
        By.css('.repository-list-item')
      )).length < 40,
      'the repository fixture rendered an unbounded DOM list'
    )

    const selectedFile = await changedList.findElement(
      By.css('[data-keyboard-list-item][tabindex="0"]')
    )
    const navigationStarted = Date.now()
    await selectedFile.sendKeys(Key.END)
    const lastPath = 'large-0999.txt'
    await driver.wait(
      until.elementLocated(
        By.css(
          `[data-changed-file-path="${lastPath}"] [aria-current="true"]`
        )
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

function repositorySelector(
  selected = false,
  repositoryPath = repositoryFixture.canonical
) {
  return By.css(
    `[data-repository-path="${repositoryPath}"]${
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

async function seedRepositoryScaleFixture(count) {
  const records = Array.from({ length: count }, (_, index) => {
    const repositoryPath = `/tmp/rdc-scale-repository-${String(
      index
    ).padStart(4, '0')}`
    return {
      path: repositoryPath,
      gitDir: path.join(repositoryPath, '.git'),
      missing: true,
      alias: null,
      groupName: null,
      defaultBranch: null,
    }
  })
  return driver.executeAsyncScript((fixtures, done) => {
    const request = indexedDB.open('rdc-repositories')
    request.onerror = () => done({ error: String(request.error) })
    request.onsuccess = () => {
      const transaction = request.result.transaction(
        'repositories',
        'readwrite'
      )
      const store = transaction.objectStore('repositories')
      for (const fixture of fixtures) {
        store.put(fixture)
      }
      transaction.onerror = () =>
        done({ error: String(transaction.error) })
      transaction.oncomplete = () => {
        request.result.close()
        done({ count: fixtures.length })
      }
    }
  }, records)
}
