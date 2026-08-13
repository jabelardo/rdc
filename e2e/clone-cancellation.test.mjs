// Slice 11: a blocked Clone is cancelled through the native destination operation and leaves no
// user-visible destination or app-owned staging directory.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  removeFixtureRoot,
  sendNativeKeys,
  startApplication,
} from "./harness.mjs";

describe("clone cancellation", () => {
  let driver;
  let fixture;
  let readyPath;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    publishCanonical(fixture);

    readyPath = "/tmp/rdc-e2e-clone-cancellation-ready";
    writeFileSync("/tmp/rdc-e2e-clone-cancellation-remote", fixture.remote);
    chmodSync("e2e/blocking-clone-ssh.sh", 0o700);

    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("cancels a blocked clone and removes only its staging directory", async () => {
    sendNativeKeys("ctrl+shift+o");
    const cloneDialog = await driver.wait(
      until.elementLocated(
        By.xpath("//*[@role='dialog' and .//*[normalize-space()='Clone a repository'] ]"),
      ),
      5_000,
    );
    await cloneDialog.findElement(By.css("#clone-url")).sendKeys("ssh://fixture/repository");
    await cloneDialog.findElement(By.css("#clone-path")).sendKeys(fixture.clone);
    await cloneDialog
      .findElement(By.xpath(".//button[@type='submit' and normalize-space()='Clone']"))
      .click();

    await driver.wait(() => existsSync(readyPath), 10_000, "Clone did not reach its SSH barrier");
    const operation = await driver.wait(
      () =>
        driver.executeAsyncScript((destinationPath, done) => {
          window.__TAURI_INTERNALS__
            .invoke("get_active_operation_for_clone_destination", { destinationPath })
            .then(done, (error) => done({ invokeError: String(error) }));
        }, fixture.clone),
      5_000,
      "the clone destination operation was not registered",
    );
    assert.equal(operation.operation, "clone");
    assert.equal(operation.cancellation.kind, "available");

    const cancellation = await driver.executeAsyncScript((operationId, done) => {
      window.__TAURI_INTERNALS__
        .invoke("request_operation_cancellation", {
          operationId,
          confirmObserver: false,
        })
        .then(done, (error) => done({ invokeError: String(error) }));
    }, operation.id);
    assert.equal(cancellation.cancellation.kind, "requested");

    const terminal = await driver.wait(
      () =>
        driver.executeAsyncScript((operationId, done) => {
          window.__TAURI_INTERNALS__.invoke("get_latest_operation_event", { operationId }).then(
            (event) => done(event?.kind === "finished" ? event : false),
            (error) => done({ invokeError: String(error) }),
          );
        }, operation.id),
      10_000,
      "the cancelled Clone did not publish a terminal event",
    );
    assert.equal(terminal.state, "cancelled");
    assert.equal(terminal.outcome, "unchanged");
    assert.equal(terminal.error.kind, "cancelled");
    assert.equal(existsSync(fixture.clone), false);
    assert.deepEqual(
      readdirSync(fixture.root).filter((entry) => entry.startsWith(".rdc-clone-")),
      [],
      "cancelled Clone left app-owned staging data behind",
    );
  });
});
