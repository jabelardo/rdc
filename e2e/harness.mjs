// Shared harness for the native WebDriver specs.
//
// Split out of the former single `menu.test.mjs` so that each product slice owns an
// independently runnable spec file. Two consequences worth knowing before editing:
//
//   - **Every spec file builds its own fixture and its own application session.** The old
//     suite ran one app instance and let each test inherit whatever state the previous one
//     had left behind, so a single early failure erased the signal from everything after it.
//     Preconditions are now established explicitly, by CLI, in each file's `before`.
//   - **Spec files must not run concurrently.** `tauri-driver` is a single process on one
//     fixed port and `stopApplication` is a process-wide `pkill -x rdc`, so two spec files
//     racing would kill each other's application. `e2e/run.sh` passes
//     `--test-concurrency=1` for exactly this reason; don't remove it.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Builder, By, Capabilities, until } from 'selenium-webdriver'

export const application = path.resolve('src-tauri/target/debug/rdc')

/** Must match `PreferencesStorageKey` in `src/lib/stores/preferences-store.ts`. */
const PREFERENCES_STORAGE_KEY = 'rdc-preferences-v1'

/**
 * Runs git and returns stdout with trailing whitespace removed — the common case.
 *
 * `trimEnd`, not `trim`: `status --porcelain` encodes staged/unstaged state in two leading
 * columns, so a plain `trim` would turn ` M file` into `M file` and silently misreport the XY
 * status to any assertion that looks at it.
 *
 * @param {string} repositoryPath a working tree, passed as `-C`
 * @param {...string} args
 * @returns {string}
 */
export function git(repositoryPath, ...args) {
  return String(execFileSync('git', ['-C', repositoryPath, ...args])).trimEnd()
}

/**
 * As {@link git}, but preserves stdout verbatim. Needed where the assertion is about exact
 * bytes, e.g. `show HEAD:file` compared against `'committed line\n'`.
 *
 * @param {string} repositoryPath
 * @param {...string} args
 * @returns {string}
 */
export function gitRaw(repositoryPath, ...args) {
  return String(execFileSync('git', ['-C', repositoryPath, ...args]))
}

/**
 * Runs git against a bare repository addressed by `--git-dir`.
 *
 * @param {string} gitDir
 * @param {...string} args
 * @returns {string}
 */
export function gitBare(gitDir, ...args) {
  return String(execFileSync('git', ['--git-dir', gitDir, ...args])).trim()
}

/**
 * Creates the temporary fixture tree. Only `canonical` and `remote` are created on disk;
 * `publisher` and `clone` are paths for the specs that produce them.
 *
 * @returns {{canonical: string, remote: string, publisher: string, clone: string}}
 */
export function createFixtureRoot() {
  const fixtureRoot = mkdtempSync('/tmp/rdc-e2e-repository-')
  return {
    root: fixtureRoot,
    canonical: path.join(fixtureRoot, 'repo'),
    remote: path.join(fixtureRoot, 'remote.git'),
    publisher: path.join(fixtureRoot, 'publisher'),
    clone: path.join(fixtureRoot, 'cloned'),
  }
}

/**
 * Removes a fixture tree. Call from `after`.
 *
 * There are now 14 spec files each creating a root, and `run.sh` reuses `/tmp/rdc-e2e-config` and
 * `/tmp/rdc-e2e-data`, so a container that runs the suite more than once would otherwise
 * accumulate fixtures — including the thousand-file tree from the large-list spec.
 *
 * @param {{root?: string}} fixture
 */
export function removeFixtureRoot(fixture) {
  if (fixture?.root === undefined) {
    return
  }
  rmSync(fixture.root, { recursive: true, force: true })
}

/**
 * Initialises the canonical working tree, its bare `origin`, the committer identity and the
 * `working-tree.txt` fixture content.
 *
 * @param {{canonical: string, remote: string}} fixture
 * @param {{failingPreCommitHook?: boolean}} [options] installs a `pre-commit` hook that exits
 *   7 with `hook says no` on stderr — the fixture the hook-interception specs assert against.
 */
export function initCanonicalRepository(fixture, options = {}) {
  const { failingPreCommitHook = false } = options

  mkdirSync(fixture.canonical)
  execFileSync('git', ['init', '--quiet', fixture.canonical])
  execFileSync('git', ['init', '--bare', '--quiet', fixture.remote])
  git(fixture.canonical, 'remote', 'add', 'origin', fixture.remote)
  git(fixture.canonical, 'config', 'user.name', 'rdc E2E')
  git(fixture.canonical, 'config', 'user.email', 'rdc-e2e@example.invalid')
  writeFileSync(
    path.join(fixture.canonical, 'working-tree.txt'),
    'committed line\nleft for partial discard\n'
  )

  if (failingPreCommitHook) {
    const preCommitHook = path.join(
      fixture.canonical,
      '.git',
      'hooks',
      'pre-commit'
    )
    writeFileSync(preCommitHook, "#!/bin/sh\necho 'hook says no' >&2\nexit 7\n")
    chmodSync(preCommitHook, 0o755)
  }
}

/**
 * Commits `working-tree.txt` holding only `committed line`, reproducing the state the former
 * suite reached by driving the commit form with the second diff line excluded. Specs that
 * assert on history, branches or discard need that commit to exist but are not testing how it
 * was made, so establishing it by CLI keeps each file independent and deterministic.
 *
 * @param {{canonical: string}} fixture
 * @param {string} [message]
 * @returns {string} the new commit SHA
 */
export function commitWorkingTreeBaseline(
  fixture,
  message = 'Commit from the real shell'
) {
  writeFileSync(
    path.join(fixture.canonical, 'working-tree.txt'),
    'committed line\n'
  )
  git(fixture.canonical, 'add', 'working-tree.txt')
  git(fixture.canonical, 'commit', '--quiet', '--no-verify', '-m', message)
  return git(fixture.canonical, 'rev-parse', 'HEAD')
}

/**
 * Initialises a minimal repository with one commit, for specs that need a *second* registered
 * repository rather than a second working tree to operate on.
 *
 * @param {string} repositoryPath
 */
export function initSimpleRepository(repositoryPath) {
  mkdirSync(repositoryPath, { recursive: true })
  execFileSync('git', ['init', '--quiet', repositoryPath])
  git(repositoryPath, 'config', 'user.name', 'rdc E2E')
  git(repositoryPath, 'config', 'user.email', 'rdc-e2e@example.invalid')
  writeFileSync(path.join(repositoryPath, 'readme.txt'), 'second repository\n')
  git(repositoryPath, 'add', 'readme.txt')
  git(
    repositoryPath,
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'Initial commit'
  )
}

/**
 * Publishes the current branch to the bare `origin` with an upstream, and points the bare
 * repository's HEAD at it so it can be cloned.
 *
 * @param {{canonical: string, remote: string}} fixture
 * @returns {string} the published branch name
 */
export function publishCanonical(fixture) {
  const branch = git(fixture.canonical, 'branch', '--show-current')
  git(
    fixture.canonical,
    'push',
    '--set-upstream',
    'origin',
    `${branch}:${branch}`
  )
  gitBare(fixture.remote, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
  return branch
}

/**
 * Clones the bare remote into the `publisher` path — a second working tree standing in for
 * "somebody else pushed", so fetch and pull have something real to retrieve.
 *
 * @param {{remote: string, publisher: string}} fixture
 */
export function createPublisherClone(fixture) {
  execFileSync('git', ['clone', '--quiet', fixture.remote, fixture.publisher])
  git(fixture.publisher, 'config', 'user.name', 'rdc Remote E2E')
  git(
    fixture.publisher,
    'config',
    'user.email',
    'rdc-remote-e2e@example.invalid'
  )
}

/**
 * Commits a file in the publisher clone and pushes it to `origin`.
 *
 * @param {{publisher: string}} fixture
 * @param {string} branch
 * @param {string} fileName
 * @param {string} contents
 * @param {string} message
 */
export function publishCommit(fixture, branch, fileName, contents, message) {
  writeFileSync(path.join(fixture.publisher, fileName), contents)
  git(fixture.publisher, 'add', fileName)
  git(fixture.publisher, 'commit', '--quiet', '-m', message)
  git(fixture.publisher, 'push', '--quiet', 'origin', branch)
}

/**
 * True when the bare remote has the named branch.
 *
 * @param {string} gitDir
 * @param {string} branch
 */
export function remoteHasBranch(gitDir, branch) {
  try {
    execFileSync(
      'git',
      [
        '--git-dir',
        gitDir,
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ],
      { stdio: 'ignore' }
    )
    return true
  } catch {
    return false
  }
}

/**
 * The configured upstream of the current branch, or null when it has none.
 *
 * @param {string} repositoryPath
 * @returns {string | null}
 */
export function upstreamOf(repositoryPath) {
  try {
    return String(
      execFileSync(
        'git',
        [
          '-C',
          repositoryPath,
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

/**
 * Starts the packaged debug binary through `tauri-driver` and waits for the shell to render.
 *
 * @returns {Promise<import('selenium-webdriver').WebDriver>}
 */
export async function startApplication() {
  const capabilities = new Capabilities()
  capabilities.setBrowserName('wry')
  capabilities.set('tauri:options', { application })

  const applicationDriver = await new Builder()
    .usingServer('http://127.0.0.1:4444/')
    .withCapabilities(capabilities)
    .build()
  await applicationDriver.wait(
    until.elementLocated(
      By.css('main.application-shell [aria-label="Navigation"]')
    ),
    10_000
  )
  await pinZoomFactor(applicationDriver)
  return applicationDriver
}

/**
 * Forces the webview to 100% zoom for the duration of a spec.
 *
 * The container is Linux, where the zoom preference defaults to 1.15. That default is real product
 * behaviour and stays — but it makes this suite non-deterministic in two ways at once: every
 * absolute geometry assertion shifts by 15% (a 25.43px command bar measures 29.24px), and
 * WebDriver's synthetic *pointer* clicks stop landing on their targets, because the coordinates it
 * derives from an element rect no longer map to the same physical point. DOM clicks
 * (`executeScript(el => el.click())`) are unaffected, which is why the breakage looked arbitrary:
 * measured at 7 of 29 tests failing, and 29 of 29 passing with the default forced to 1.0.
 *
 * Both steps are needed. Writing the preference stops the frontend applying 1.15 after
 * `preferencesStore.load()`; the explicit command call also normalises a zoom already persisted
 * natively in `zoom-state.json`, which the frontend would *not* correct, since it only calls
 * `setWindowZoomFactor` when the preference differs from 1.0.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function pinZoomFactor(driver) {
  await driver.executeScript(storageKey => {
    let preferences = {}
    try {
      preferences = JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {}
    } catch {
      preferences = {}
    }
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ...preferences, zoomFactor: 1 })
    )
  }, PREFERENCES_STORAGE_KEY)
  await driver.navigate().refresh()
  await driver.wait(
    until.elementLocated(
      By.css('main.application-shell [aria-label="Navigation"]')
    ),
    10_000
  )
  await driver.executeAsyncScript(done => {
    window.__TAURI_INTERNALS__
      .invoke('set_window_zoom_factor', { zoomFactor: 1 })
      .then(
        () => done(true),
        error => done({ error: String(error) })
      )
  })
  await driver.wait(
    async () =>
      (await driver.executeAsyncScript(done => {
        window.__TAURI_INTERNALS__
          .invoke('get_current_window_zoom_factor')
          .then(done, () => done(null))
      })) === 1,
    5_000,
    'the webview did not settle at 100% zoom'
  )
}

/** Terminates the application out of band, as a user force-quitting it would. */
export function stopApplication() {
  execFileSync('pkill', ['-x', 'rdc'])
}

/**
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function waitForApplicationExit(driver) {
  await driver.wait(async () => {
    try {
      execFileSync('pgrep', ['-x', 'rdc'])
      return false
    } catch {
      return true
    }
  }, 5_000)
}

/**
 * @param {string} repositoryPath
 * @param {boolean} [selected] additionally require the row to be the current selection
 */
export function repositorySelector(repositoryPath, selected = false) {
  return By.css(
    `[data-repository-path="${repositoryPath}"]${
      selected ? '[aria-current="true"]' : ''
    }`
  )
}

/**
 * Presses keys through the X server rather than WebDriver, which is the only way to reach the
 * *native* application menu.
 *
 * @param {...string} keys `xdotool key` arguments
 */
export function sendNativeKeys(...keys) {
  execFileSync('xdotool', ['key', '--delay', '150', ...keys])
}

/**
 * Writes one repository record into the renderer's IndexedDB, creating the store if the
 * database does not exist yet.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string} repositoryPath
 */
export async function seedRepositoryFixture(driver, repositoryPath) {
  return driver.executeAsyncScript(
    (record, done) => {
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
        transaction.onerror = () => done({ error: String(transaction.error) })
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
    },
    {
      path: repositoryPath,
      gitDir: path.join(repositoryPath, '.git'),
      missing: false,
      alias: null,
      groupName: null,
      defaultBranch: null,
    }
  )
}

/**
 * Empties the renderer's repository store.
 *
 * Load-bearing for spec independence: the container sets one `XDG_DATA_HOME` for the whole
 * run and `tauri-driver` — not the test process — launches the application, so the webview's
 * IndexedDB survives every restart and is shared by all spec files. Without this, a file's
 * assertions depend on how many repositories earlier files happened to register (measured: a
 * spec expecting 1 record saw 264, and another lost its own row because the repository list
 * virtualizes above 100 items and windowed it out of the DOM).
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function resetRepositoryFixtures(driver) {
  return driver.executeAsyncScript(done => {
    const request = indexedDB.open('rdc-repositories')
    request.onerror = () => done({ error: String(request.error) })
    request.onupgradeneeded = () => {
      // A fresh database — create the store so the clear below has a target.
      const store = request.result.createObjectStore('repositories', {
        keyPath: 'id',
        autoIncrement: true,
      })
      store.createIndex('path', 'path', { unique: true })
    }
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('repositories')) {
        database.close()
        done({ cleared: true })
        return
      }
      const transaction = database.transaction('repositories', 'readwrite')
      transaction.objectStore('repositories').clear()
      transaction.onerror = () => done({ error: String(transaction.error) })
      transaction.oncomplete = () => {
        database.close()
        done({ cleared: true })
      }
    }
  })
}

/**
 * @param {import('selenium-webdriver').WebDriver} driver
 */
export async function readRepositoryFixtures(driver) {
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

/**
 * Seeds `count` absent repository records, to exercise the repository list at a size the
 * virtualized adapter has to window.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {number} count
 */
export async function seedRepositoryScaleFixture(driver, count) {
  const records = Array.from({ length: count }, (_, index) => {
    const repositoryPath = `/tmp/rdc-scale-repository-${String(index).padStart(
      4,
      '0'
    )}`
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
      transaction.onerror = () => done({ error: String(transaction.error) })
      transaction.oncomplete = () => {
        request.result.close()
        done({ count: fixtures.length })
      }
    }
  }, records)
}

/**
 * Expands one sidebar accordion panel, if it is not already the expanded one.
 *
 * **The sidebar deliberately starts with every panel collapsed** — a Phase 8b QA decision, since
 * the single expanded panel owns the sidebar's remaining height. That state lives in React, so it
 * resets on every application launch *and* on every `navigate().refresh()`. Any assertion about a
 * repository row, the Repositories list or the Branches controls therefore has to expand its panel
 * first; nothing in the sidebar is in the DOM until then.
 *
 * Idempotent, and it asserts the panel really opened rather than assuming the click landed.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {'repositories' | 'branches'} [section]
 */
export async function expandSidebarSection(driver, section = 'repositories') {
  const heading = await driver.wait(
    until.elementLocated(By.css(`#sidebar-${section}-heading`)),
    5_000,
    `the ${section} sidebar heading never rendered`
  )
  if ((await heading.getAttribute('aria-expanded')) !== 'true') {
    await driver.executeScript(element => element.click(), heading)
  }
  await driver.wait(
    async () => (await heading.getAttribute('aria-expanded')) === 'true',
    5_000,
    `the ${section} sidebar panel did not expand`
  )
}

/**
 * Seeds one repository, reloads so the store picks it up, and waits until it is the selected
 * repository.
 *
 * Readiness is the presence of the repository views nav, not a sidebar row: that nav renders only
 * when `selectedRepository !== null` (see `app-shell.tsx`), so it is both a stronger signal — the
 * repository is actually selected, not merely listed — and independent of which sidebar panel
 * happens to be expanded. Waiting on a sidebar row here would force every spec through a panel
 * expansion it may not want, and would leave the accordion in a state the spec did not choose.
 * Specs that assert on a sidebar row expand its panel themselves.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string} repositoryPath
 */
export async function openSeededRepository(driver, repositoryPath) {
  await resetRepositoryFixtures(driver)
  await seedRepositoryFixture(driver, repositoryPath)
  await driver.navigate().refresh()
  await driver.wait(
    until.elementLocated(By.css('[aria-label="Repository views"]')),
    5_000,
    `the seeded repository ${repositoryPath} did not become the selected repository`
  )
}

/**
 * Selects a repository row and waits for it to become the current selection. Needed where
 * more than one repository is registered, since the selection then decides which repository
 * the workspace is showing.
 *
 * Expands the Repositories panel first — the row cannot be clicked while it is collapsed.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {string} repositoryPath
 */
export async function selectRepository(driver, repositoryPath) {
  await expandSidebarSection(driver, 'repositories')
  const row = await driver.wait(
    until.elementLocated(repositorySelector(repositoryPath)),
    5_000
  )
  await driver.executeScript(element => element.click(), row)
  await driver.wait(
    until.elementLocated(repositorySelector(repositoryPath, true)),
    5_000,
    `repository ${repositoryPath} did not become the current selection`
  )
}
