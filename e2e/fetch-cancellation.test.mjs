// Slice 10 Fetch pilot: a blocked native Fetch survives owner-window loss, remains observable
// from a peer, can be cancelled after becoming unowned, and never blocks another repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  gitBare,
  initCanonicalRepository,
  initSimpleRepository,
  openRepositoryWindow,
  openSeededRepository,
  publishCanonical,
  removeFixtureRoot,
  seedRepositoryFixture,
  startApplication,
} from "./harness.mjs";

const FETCH_ACTION = 'section[aria-label="Remote synchronization"] button[aria-label="Fetch"]';

// Re-resolves the Fetch action on every use. The toolbar rerenders whenever an operation event
// lands, which replaces the button node and makes a held reference stale. Locating it once and
// then calling `isEnabled()` or clicking it races the very state changes this spec waits for.
async function fetchAction(driver) {
  return driver.wait(until.elementLocated(By.css(FETCH_ACTION)), 10_000);
}

// Enabled-state of the Fetch action, or null when it cannot be read right now. The toolbar can
// rerender between `findElements` and `isEnabled`, which invalidates the node mid-poll — that is
// "not settled yet", not a failure, so the caller's `wait` should simply poll again.
async function fetchActionEnabled(driver) {
  try {
    const buttons = await driver.findElements(By.css(FETCH_ACTION));
    if (buttons.length !== 1) {
      return null;
    }
    return await buttons[0].isEnabled();
  } catch (error) {
    if (error.name === "StaleElementReferenceError") {
      return null;
    }
    throw error;
  }
}

async function clickFetch(driver) {
  await driver.wait(
    async () => {
      try {
        const button = await fetchAction(driver);
        await driver.executeScript((element) => element.click(), button);
        return true;
      } catch (error) {
        if (error.name === "StaleElementReferenceError") {
          return false;
        }
        throw error;
      }
    },
    10_000,
    "the Fetch action could not be clicked",
  );
}

async function activeOperation(driver, repositoryPath) {
  return driver.executeAsyncScript((selectedPath, done) => {
    window.__TAURI_INTERNALS__
      .invoke("get_active_operation_for_repository", { repositoryPath: selectedPath })
      .then(done, (error) => done({ invokeError: String(error) }));
  }, repositoryPath);
}

describe("fetch cancellation", () => {
  let driver;
  let fixture;
  let ownerWindow;
  let peerWindow;
  let independentWindow;
  let independentRepository;
  let independentRemote;
  let independentPublisher;
  let independentBranch;
  let readyPath;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    publishCanonical(fixture);

    const releasePath = path.join(fixture.root, "release-fetch");
    readyPath = path.join(fixture.root, "ready-fetch");
    const blockingSsh = path.join(fixture.root, "blocking-ssh");
    writeFileSync(
      blockingSsh,
      `#!/bin/sh
printf '%s\\n' 'remote: Counting objects: 50% (1/2)' >&2
: > '${readyPath}'
while [ ! -e '${releasePath}' ]; do
  sleep 0.01
done
exec git-upload-pack '${fixture.remote}'
`,
    );
    chmodSync(blockingSsh, 0o700);
    git(fixture.canonical, "remote", "set-url", "origin", "ssh://fixture/repository");
    git(fixture.canonical, "config", "core.sshCommand", blockingSsh);
    // Without an explicit variant Git first runs the command with `-G` to probe its SSH shape.
    // This fixture intentionally blocks on every invocation, so identify it up front just as the
    // native fixture does through GIT_SSH_VARIANT.
    git(fixture.canonical, "config", "ssh.variant", "ssh");

    independentRepository = path.join(fixture.root, "independent");
    independentRemote = path.join(fixture.root, "independent-remote.git");
    independentPublisher = path.join(fixture.root, "independent-publisher");
    initSimpleRepository(independentRepository);
    execFileSync("git", ["init", "--bare", "--quiet", independentRemote]);
    git(independentRepository, "remote", "add", "origin", independentRemote);
    independentBranch = git(independentRepository, "branch", "--show-current");
    git(independentRepository, "push", "--quiet", "--set-upstream", "origin", independentBranch);
    gitBare(independentRemote, "symbolic-ref", "HEAD", `refs/heads/${independentBranch}`);
    execFileSync("git", ["clone", "--quiet", independentRemote, independentPublisher]);
    git(independentPublisher, "config", "user.name", "rdc E2E");
    git(independentPublisher, "config", "user.email", "rdc-e2e@example.invalid");

    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
    ownerWindow = await driver.getWindowHandle();
    await seedRepositoryFixture(driver, independentRepository);

    await openRepositoryWindow(driver, fixture.canonical);
    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length >= 2,
      10_000,
      "the same-repository peer window did not open",
    );
    peerWindow = (await driver.getAllWindowHandles()).find((handle) => handle !== ownerWindow);
    assert.ok(peerWindow, "the peer window should have a distinct handle");
    await driver.switchTo().window(peerWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the peer window did not hydrate the selected repository",
    );

    await driver.switchTo().window(ownerWindow);
    await openRepositoryWindow(driver, independentRepository);
    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length >= 3,
      10_000,
      "the independent repository window did not open",
    );
    independentWindow = (await driver.getAllWindowHandles()).find(
      (handle) => handle !== ownerWindow && handle !== peerWindow,
    );
    assert.ok(independentWindow, "the independent window should have a distinct handle");
    await driver.switchTo().window(independentWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the independent window did not hydrate the selected repository",
    );
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("cancels an unowned Fetch while another repository fetches independently", async () => {
    await driver.switchTo().window(ownerWindow);
    await clickFetch(driver);
    await driver.wait(
      () => existsSync(readyPath),
      10_000,
      "Fetch did not reach its blocking transport",
    );

    const ownerOperation = await driver.wait(
      async () => {
        const operation = await activeOperation(driver, fixture.canonical);
        return operation?.operation === "fetch" && operation.progress?.description
          ? operation
          : false;
      },
      5_000,
      "the blocked Fetch did not publish progress",
    );
    assert.match(ownerOperation.progress.description, /Counting objects/);

    await driver.switchTo().window(peerWindow);
    const peerOperation = await activeOperation(driver, fixture.canonical);
    assert.equal(peerOperation?.id, ownerOperation.id);
    assert.match(peerOperation.progress.description, /Counting objects/);
    await driver.wait(
      async () => (await fetchActionEnabled(driver)) === false,
      5_000,
      "the peer window did not disable writes for the owner Fetch",
    );

    // A window opened *after* the Fetch started has no event history to replay, so anything it
    // shows had to come from the registry snapshot. The transport is blocked on a file barrier
    // rather than a timer, so this is a hydration check and not a race.
    const windowsBeforeHydration = await driver.getAllWindowHandles();
    await openRepositoryWindow(driver, fixture.canonical);
    const hydratedWindow = await driver.wait(
      async () => {
        const handles = await driver.getAllWindowHandles();
        return handles.find((handle) => !windowsBeforeHydration.includes(handle)) ?? false;
      },
      10_000,
      "the mid-operation window did not open",
    );
    await driver.switchTo().window(hydratedWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the mid-operation window did not hydrate the selected repository",
    );
    const hydratedOperation = await driver.wait(
      async () => {
        const operation = await activeOperation(driver, fixture.canonical);
        return operation?.id === ownerOperation.id && operation.progress?.description
          ? operation
          : false;
      },
      5_000,
      "the mid-operation window did not hydrate the running Fetch",
    );
    assert.match(hydratedOperation.progress.description, /Counting objects/);
    await driver.wait(
      async () => (await fetchActionEnabled(driver)) === false,
      5_000,
      "the mid-operation window did not disable writes from the hydrated snapshot",
    );
    await driver.close();
    await driver.switchTo().window(peerWindow);

    writeFileSync(path.join(independentPublisher, "concurrent.txt"), "concurrent fetch\n");
    git(independentPublisher, "add", "concurrent.txt");
    git(independentPublisher, "commit", "--quiet", "-m", "Concurrent remote update");
    git(independentPublisher, "push", "--quiet", "origin", independentBranch);
    const independentHead = gitBare(
      independentRemote,
      "rev-parse",
      `refs/heads/${independentBranch}`,
    );

    await driver.switchTo().window(independentWindow);
    await driver.wait(
      async () => (await fetchActionEnabled(driver)) === true,
      5_000,
      "a different repository must not be disabled by the blocked Fetch",
    );
    await clickFetch(driver);
    await driver.wait(
      () =>
        git(independentRepository, "rev-parse", `refs/remotes/origin/${independentBranch}`) ===
        independentHead,
      10_000,
      "the independent Fetch did not complete while the first repository was blocked",
    );
    assert.equal((await activeOperation(driver, fixture.canonical))?.id, ownerOperation.id);

    await driver.switchTo().window(peerWindow);
    const ownerDestroyed = await driver.executeAsyncScript((ownerLabel, done) => {
      window.__TAURI_INTERNALS__.invoke("plugin:window|destroy", { label: ownerLabel }).then(
        () => done(true),
        (error) => done({ invokeError: String(error) }),
      );
    }, ownerOperation.ownerWindow);
    assert.equal(ownerDestroyed, true);
    const unownedOperation = await driver.wait(
      async () => {
        const operation = await activeOperation(driver, fixture.canonical);
        return operation?.id === ownerOperation.id && operation.ownerWindow === null
          ? operation
          : false;
      },
      5_000,
      "the Fetch did not survive owner-window closure as an unowned operation",
    );
    assert.equal(unownedOperation.state, "running");

    const cancellation = await driver.executeAsyncScript((operationId, done) => {
      window.__TAURI_INTERNALS__
        .invoke("request_operation_cancellation", {
          operationId,
          confirmObserver: false,
        })
        .then(done, (error) => done({ invokeError: String(error) }));
    }, ownerOperation.id);
    assert.equal(cancellation.state, "cancelling");
    assert.equal(cancellation.cancellation.kind, "requested");

    const terminal = await driver.wait(
      () =>
        driver.executeAsyncScript((operationId, done) => {
          window.__TAURI_INTERNALS__.invoke("get_latest_operation_event", { operationId }).then(
            (event) => done(event?.kind === "finished" ? event : false),
            (error) => done({ invokeError: String(error) }),
          );
        }, ownerOperation.id),
      10_000,
      "the peer did not observe terminal Fetch cancellation",
    );
    assert.equal(terminal.state, "cancelled");
    assert.equal(terminal.outcome, "unchanged");
    assert.equal(terminal.error.kind, "cancelled");
    assert.equal(await activeOperation(driver, fixture.canonical), null);
    await driver.wait(
      async () => (await fetchActionEnabled(driver)) === true,
      5_000,
      "the peer Fetch action remained disabled after the native lock cleared",
    );
  });
});
