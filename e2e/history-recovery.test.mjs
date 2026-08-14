import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  startApplication,
  writeQaDriverState,
} from "./harness.mjs";

async function activeOperation(driver, repositoryPath) {
  return driver.executeAsyncScript((path, done) => {
    window.__TAURI_INTERNALS__
      .invoke("get_active_operation_for_repository", { repositoryPath: path })
      .then(done, (error) => done({ invokeError: String(error) }));
  }, repositoryPath);
}

describe("history recovery", () => {
  let driver;
  let fixture;
  let mainBranch;
  let incomingCommit;
  let mainConflictCommit;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    mainBranch = git(fixture.canonical, "branch", "--show-current");

    git(fixture.canonical, "switch", "--quiet", "-c", "incoming");
    writeFileSync(`${fixture.canonical}/working-tree.txt`, "incoming line\n");
    git(fixture.canonical, "add", "working-tree.txt");
    git(fixture.canonical, "commit", "--quiet", "--no-verify", "-m", "Incoming conflict");
    incomingCommit = git(fixture.canonical, "rev-parse", "HEAD");

    git(fixture.canonical, "switch", "--quiet", mainBranch);
    writeFileSync(`${fixture.canonical}/working-tree.txt`, "main line\n");
    git(fixture.canonical, "add", "working-tree.txt");
    git(fixture.canonical, "commit", "--quiet", "--no-verify", "-m", "Main conflict");
    mainConflictCommit = git(fixture.canonical, "rev-parse", "HEAD");

    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("starts Cherry-pick through the native QA seam and aborts its recovery", async () => {
    writeQaDriverState({
      repository: fixture.canonical,
      view: "changes",
      historyOperation: {
        kind: "cherryPick",
        commit: incomingCommit,
        summary: "Incoming conflict",
        parentCount: null,
      },
    });

    await driver.wait(
      async () => {
        const operation = await activeOperation(driver, fixture.canonical);
        return operation?.operation === "cherryPick" && operation.state === "recovering";
      },
      10_000,
      "Cherry-pick did not reach native recovery",
    );

    const recovery = await driver.wait(
      until.elementLocated(By.css('[aria-label="Cherry-pick recovery"]')),
      10_000,
    );
    assert.match(await recovery.getText(), /conflict|Incoming conflict/i);
    assert.equal(
      await driver
        .findElement(By.xpath("//button[normalize-space()='Continue cherry-pick']"))
        .isEnabled(),
      false,
    );

    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.xpath("//button[normalize-space()='Abort cherry-pick']")),
    );
    await driver.wait(
      () => !existsSync(`${fixture.canonical}/.git/CHERRY_PICK_HEAD`),
      10_000,
      "aborting Cherry-pick did not clear the sequencer marker",
    );
    assert.equal(git(fixture.canonical, "branch", "--show-current"), mainBranch);

    await driver.executeScript(
      (element) => element.click(),
      await driver.wait(
        until.elementLocated(By.xpath("//button[normalize-space()='Close']")),
        10_000,
      ),
    );
  });

  it("starts Revert through the native QA seam and exposes abort-only recovery", async () => {
    writeFileSync(`${fixture.canonical}/working-tree.txt`, "follow-up line\n");
    git(fixture.canonical, "add", "working-tree.txt");
    git(fixture.canonical, "commit", "--quiet", "--no-verify", "-m", "Follow-up conflict");
    const followUpCommit = git(fixture.canonical, "rev-parse", "HEAD");

    writeQaDriverState({
      repository: fixture.canonical,
      view: "changes",
      historyOperation: {
        kind: "revert",
        commit: mainConflictCommit,
        summary: "Main conflict",
        parentCount: 1,
      },
    });

    await driver.wait(
      async () => {
        const operation = await activeOperation(driver, fixture.canonical);
        return operation?.operation === "revert" && operation.state === "recovering";
      },
      10_000,
      "Revert did not reach native recovery",
    );

    const recovery = await driver.wait(
      until.elementLocated(By.css('[aria-label="Revert recovery"]')),
      10_000,
    );
    assert.match(await recovery.getText(), /abort/i);
    assert.equal(
      (await driver.findElements(By.xpath("//button[normalize-space()='Continue cherry-pick']")))
        .length,
      0,
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.xpath("//button[normalize-space()='Abort revert']")),
    );
    await driver.wait(
      () => !existsSync(`${fixture.canonical}/.git/REVERT_HEAD`),
      10_000,
      "aborting Revert did not clear the revert marker",
    );
    assert.equal(git(fixture.canonical, "rev-parse", "HEAD"), followUpCommit);
  });
});
