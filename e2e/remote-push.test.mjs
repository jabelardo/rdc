// Push: an unpublished local branch reaches the bare remote and gets its upstream configured.
import assert from "node:assert/strict";
import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  gitBare,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  remoteHasBranch,
  removeFixtureRoot,
  startApplication,
  upstreamOf,
} from "./harness.mjs";

const pushBranch = "phase-7d-push";

describe("remote push", () => {
  let driver;
  let fixture;
  let localHead;
  const pushReady = "/tmp/rdc-e2e-push-ready";
  const pushRelease = "/tmp/rdc-e2e-push-release";

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    const publishedBranch = publishCanonical(fixture);

    // A branch with no upstream, which is what makes Push the available action.
    git(
      fixture.canonical,
      "checkout",
      "--quiet",
      "--no-track",
      "-b",
      pushBranch,
      `origin/${publishedBranch}`,
    );
    writeFileSync(
      path.join(fixture.canonical, "pushed-by-rdc.txt"),
      "this commit was pushed through rdc\n",
    );
    git(fixture.canonical, "add", "pushed-by-rdc.txt");
    git(fixture.canonical, "commit", "--quiet", "--no-verify", "-m", "Push through rdc");
    localHead = git(fixture.canonical, "rev-parse", "HEAD");

    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    for (const marker of [pushReady, pushRelease]) {
      if (existsSync(marker)) unlinkSync(marker);
    }
    removeFixtureRoot(fixture);
  });

  it("pushes an unpublished branch to the local bare remote", async () => {
    assert.equal(remoteHasBranch(fixture.remote, pushBranch), false);

    const pushButton = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(
            By.xpath(
              "//section[@aria-label='Remote synchronization']//button[normalize-space()='Push']",
            ),
          );
          return (await button.isEnabled()) ? button : false;
        } catch {
          return false;
        }
      },
      10_000,
      "push did not become available for the new branch",
    );
    await driver.executeScript((element) => element.click(), pushButton);
    await driver.wait(
      () => remoteHasBranch(fixture.remote, pushBranch),
      10_000,
      "push did not create the branch in the bare remote",
    );
    assert.equal(gitBare(fixture.remote, "rev-parse", `refs/heads/${pushBranch}`), localHead);
    await driver.wait(
      () => upstreamOf(fixture.canonical) === `origin/${pushBranch}`,
      10_000,
      "push created the remote branch but did not configure its upstream",
    );
    assert.equal(upstreamOf(fixture.canonical), `origin/${pushBranch}`);
  });

  it("reports an unknown outcome when cancellation stops Push before remote acknowledgement", async () => {
    if (existsSync(pushReady)) unlinkSync(pushReady);
    if (existsSync(pushRelease)) unlinkSync(pushRelease);
    writeFileSync(
      path.join(fixture.canonical, ".git", "hooks", "pre-push"),
      `#!/bin/sh
: > '${pushReady}'
while [ ! -e '${pushRelease}' ]; do sleep 0.01; done
`,
    );
    chmodSync(path.join(fixture.canonical, ".git", "hooks", "pre-push"), 0o700);
    writeFileSync(path.join(fixture.canonical, "push-unknown.txt"), "unknown outcome\n");
    git(fixture.canonical, "add", "push-unknown.txt");
    git(fixture.canonical, "commit", "--quiet", "--no-verify", "-m", "Push unknown outcome");

    await driver.navigate().refresh();
    const pushButton = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(
            By.xpath(
              "//section[@aria-label='Remote synchronization']//button[normalize-space()='Push']",
            ),
          );
          return (await button.isEnabled()) ? button : false;
        } catch {
          return false;
        }
      },
      10_000,
      "Push did not become available for cancellation",
    );
    await driver.executeScript((element) => element.click(), pushButton);
    await driver.wait(() => existsSync(pushReady), 10_000, "Push did not reach its pre-push barrier");

    const operation = await driver.wait(
      async () =>
        driver.executeAsyncScript((repositoryPath, done) => {
          window.__TAURI_INTERNALS__
            .invoke("get_active_operation_for_repository", { repositoryPath })
            .then((active) => done(active?.operation === "push" ? active : false))
            .catch((error) => done({ error: String(error) }));
        }, fixture.canonical),
      5_000,
      "the Push operation was not registered",
    );
    const cancellation = await driver.executeAsyncScript((operationId, done) => {
      window.__TAURI_INTERNALS__
        .invoke("request_operation_cancellation", { operationId, confirmObserver: false })
        .then(done, (error) => done({ error: String(error) }));
    }, operation.id);
    assert.equal(cancellation.cancellation.kind, "requested");

    const terminal = await driver.wait(
      () =>
        driver.executeAsyncScript((operationId, done) => {
          window.__TAURI_INTERNALS__.invoke("get_latest_operation_event", { operationId }).then(
            (event) => done(event?.kind === "finished" ? event : false),
            (error) => done({ error: String(error) }),
          );
        }, operation.id),
      10_000,
      "cancelled Push did not publish a terminal event",
    );
    assert.equal(terminal.state, "cancelled");
    assert.equal(terminal.outcome, "unknown");
    assert.equal(terminal.error.kind, "cancelled");
    assert.match(terminal.error.message, /outcome is unknown/i);
    assert.equal(remoteHasBranch(fixture.remote, pushBranch), true);
  });
});
