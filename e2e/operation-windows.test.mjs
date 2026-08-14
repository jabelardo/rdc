// Multi-window operation foundation: a second native window can hydrate the same repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  expandSidebarSection,
  git,
  initCanonicalRepository,
  initSimpleRepository,
  openRepositoryWindow,
  openSeededRepository,
  repositorySelector,
  removeFixtureRoot,
  seedRepositoryFixture,
  startApplication,
} from "./harness.mjs";

describe("operation windows", () => {
  let driver;
  let fixture;
  let secondRepository;
  let mainWindow;
  let sameRepositoryWindow;
  let differentRepositoryWindow;
  let linkedWorktree;
  let linkedWorktreeWindow;
  let peerCommitOperationId;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    secondRepository = path.join(fixture.root, "second");
    initSimpleRepository(secondRepository);
    const secondRemote = path.join(fixture.root, "second-remote.git");
    execFileSync("git", ["init", "--bare", "--quiet", secondRemote]);
    git(secondRepository, "remote", "add", "origin", secondRemote);
    const secondBranch = git(secondRepository, "branch", "--show-current");
    git(secondRepository, "push", "--quiet", "--set-upstream", "origin", secondBranch);
    linkedWorktree = path.join(fixture.root, "linked-worktree");
    git(fixture.canonical, "worktree", "add", "--quiet", "-b", "linked-window", linkedWorktree);
    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
    mainWindow = await driver.getWindowHandle();
    await seedRepositoryFixture(driver, secondRepository);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("opens a second native window with the same selected repository", async () => {
    const originalWindow = mainWindow;
    await openRepositoryWindow(driver, fixture.canonical);
    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length >= 2,
      10_000,
      "the second repository window did not open",
    );

    const secondWindow = (await driver.getAllWindowHandles()).find(
      (handle) => handle !== originalWindow,
    );
    assert.ok(secondWindow, "the second window should have a distinct handle");
    sameRepositoryWindow = secondWindow;
    await driver.switchTo().window(secondWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the second window did not hydrate the repository selection",
    );
    await expandSidebarSection(driver, "repositories");
    assert.equal(
      await driver.findElement(repositorySelector(fixture.canonical, true)).isDisplayed(),
      true,
    );
  });

  it("keeps a different repository independent in another native window", async () => {
    await driver.switchTo().window(mainWindow);
    await openRepositoryWindow(driver, secondRepository);
    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length >= 3,
      10_000,
      "the different-repository window did not open",
    );
    const handles = await driver.getAllWindowHandles();
    differentRepositoryWindow = handles.find(
      (handle) => handle !== mainWindow && handle !== sameRepositoryWindow,
    );
    assert.ok(differentRepositoryWindow, "the different-repository window should be distinct");
    await driver.switchTo().window(differentRepositoryWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the different-repository window did not hydrate its selection",
    );
    await expandSidebarSection(driver, "repositories");
    assert.equal(
      await driver.findElement(repositorySelector(secondRepository, true)).isDisplayed(),
      true,
    );
  });

  it("opens a linked worktree with a distinct path and the shared repository lock", async () => {
    await driver.switchTo().window(mainWindow);
    const scopes = await driver.executeAsyncScript(
      (mainPath, linkedPath, done) => {
        Promise.all(
          [mainPath, linkedPath].map((repositoryPath) =>
            window.__TAURI_INTERNALS__.invoke("get_operation_scope_for_repository", {
              repositoryPath,
            }),
          ),
        ).then(done, (error) => done({ error: String(error) }));
      },
      fixture.canonical,
      linkedWorktree,
    );
    assert.equal(scopes[0].lockKey, scopes[1].lockKey);
    assert.notEqual(scopes[0].repositoryPath, scopes[1].repositoryPath);

    await openRepositoryWindow(driver, linkedWorktree);
    await driver.wait(
      async () => (await driver.getAllWindowHandles()).length >= 4,
      10_000,
      "the linked-worktree window did not open",
    );
    linkedWorktreeWindow = (await driver.getAllWindowHandles()).find(
      (handle) =>
        handle !== mainWindow &&
        handle !== sameRepositoryWindow &&
        handle !== differentRepositoryWindow,
    );
    assert.ok(linkedWorktreeWindow, "the linked worktree should have a distinct window");
    await driver.switchTo().window(linkedWorktreeWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the linked-worktree window did not hydrate its selection",
    );
  });

  it("disables peer remote writes while the owner commits", async () => {
    const hook = path.join(fixture.canonical, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nsleep 5\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(fixture.canonical, "peer-lock.txt"), "lock coverage\n");

    await driver.switchTo().window(mainWindow);
    await driver.navigate().refresh();
    await driver.wait(until.elementLocated(By.css("#commit-message")), 10_000);
    await driver.findElement(By.css("#commit-message")).sendKeys("Peer lock coverage");
    await driver.findElement(By.css('.commit-form button[type="submit"]')).click();
    const ownerCommit = await driver.wait(
      async () => {
        const active = await driver.executeAsyncScript((repositoryPath, done) => {
          window.__TAURI_INTERNALS__
            .invoke("get_active_operation_for_repository", { repositoryPath })
            .then(done, (error) => done({ error: String(error) }));
        }, fixture.canonical);
        return active?.operation === "commit" ? active : false;
      },
      5_000,
      "the owner commit did not acquire its repository lock",
    );
    peerCommitOperationId = ownerCommit.id;

    await driver.switchTo().window(sameRepositoryWindow);
    const peerNativeOperation = await driver.executeAsyncScript((repositoryPath, done) => {
      window.__TAURI_INTERNALS__
        .invoke("get_active_operation_for_repository", { repositoryPath })
        .then(done, (error) => done({ error: String(error) }));
    }, fixture.canonical);
    assert.equal(
      peerNativeOperation?.operation,
      "commit",
      "the native registry must expose the owner commit to the peer window",
    );
    await driver.wait(
      async () => {
        const buttons = await driver.findElements(
          By.xpath(
            "//section[@aria-label='Remote synchronization']//button[normalize-space()='Fetch']",
          ),
        );
        return buttons.length === 1 && !(await buttons[0].isEnabled());
      },
      5_000,
      "the peer Fetch action remained enabled during the owner commit",
    );

    await driver.switchTo().window(linkedWorktreeWindow);
    await driver.wait(
      async () => {
        const buttons = await driver.findElements(
          By.xpath(
            "//section[@aria-label='Remote synchronization']//button[normalize-space()='Fetch']",
          ),
        );
        return buttons.length === 1 && !(await buttons[0].isEnabled());
      },
      5_000,
      "the linked-worktree Fetch action remained enabled during the owner commit",
    );

    await driver.switchTo().window(differentRepositoryWindow);
    const independentFetchButton = await driver.wait(
      until.elementLocated(
        By.xpath(
          "//section[@aria-label='Remote synchronization']//button[normalize-space()='Fetch']",
        ),
      ),
      10_000,
    );
    assert.equal(
      await independentFetchButton.isEnabled(),
      true,
      "a different repository must not be disabled by the owner commit",
    );

    await driver.switchTo().window(mainWindow);
    await driver.wait(
      async () => {
        const active = await driver.executeAsyncScript((repositoryPath, done) => {
          window.__TAURI_INTERNALS__
            .invoke("get_active_operation_for_repository", { repositoryPath })
            .then(done, (error) => done({ error: String(error) }));
        }, fixture.canonical);
        return active === null;
      },
      15_000,
      "the owner commit did not finish",
    );
    await driver.switchTo().window(sameRepositoryWindow);
    const peerTerminalEvent = await driver.executeAsyncScript((operationId, done) => {
      window.__TAURI_INTERNALS__
        .invoke("get_latest_operation_event", { operationId })
        .then(done, (error) => done({ error: String(error) }));
    }, peerCommitOperationId);
    assert.equal(
      peerTerminalEvent?.kind,
      "finished",
      "the matching repository window did not observe the terminal operation event",
    );
    await driver.switchTo().window(mainWindow);
  });

  it("keeps the commit running when its owner window closes", async () => {
    const hook = path.join(fixture.canonical, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nsleep 5\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(fixture.canonical, "owner-loss.txt"), "owner loss\n");

    await driver.switchTo().window(mainWindow);
    await driver.navigate().refresh();
    await driver.wait(until.elementLocated(By.css("#commit-message")), 10_000);
    await driver.findElement(By.css("#commit-message")).sendKeys("Owner loss coverage");
    await driver.findElement(By.css('.commit-form button[type="submit"]')).click();
    await driver.wait(
      async () => {
        const active = await driver.executeAsyncScript((repositoryPath, done) => {
          window.__TAURI_INTERNALS__
            .invoke("get_active_operation_for_repository", { repositoryPath })
            .then(done, (error) => done({ error: String(error) }));
        }, fixture.canonical);
        return active?.operation === "commit";
      },
      5_000,
      "the owner-loss commit did not acquire its repository lock",
    );

    await driver.close();
    mainWindow = sameRepositoryWindow;
    await driver.switchTo().window(sameRepositoryWindow);
    await driver.wait(
      until.elementLocated(By.css('[aria-label="Repository views"]')),
      10_000,
      "the peer window closed with the owner window",
    );
    await driver.wait(
      () => git(fixture.canonical, "log", "-1", "--pretty=%s") === "Owner loss coverage",
      15_000,
      "the commit did not finish after its owner window closed",
    );
    const ownerLossHead = git(fixture.canonical, "rev-parse", "HEAD");
    const historyView = await driver.findElement(
      By.xpath("//nav[@aria-label='Repository views']//button[normalize-space()='History']"),
    );
    await driver.executeScript((element) => element.click(), historyView);
    const refreshedCommit = await driver.wait(
      until.elementLocated(By.css(`[data-commit-sha="${ownerLossHead}"]`)),
      10_000,
      "the peer history did not refresh after the owner operation finished",
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, refreshedCommit),
      /Owner loss coverage/,
    );

    // The other half of the contract: a terminal event must reach every *matching* window and no
    // other. The unrelated repository's window must never see this operation, and its history must
    // not acquire the commit that just landed somewhere else.
    await driver.switchTo().window(differentRepositoryWindow);
    const unrelatedOperation = await driver.executeAsyncScript((repositoryPath, done) => {
      window.__TAURI_INTERNALS__
        .invoke("get_active_operation_for_repository", { repositoryPath })
        .then(done, (error) => done({ error: String(error) }));
    }, secondRepository);
    assert.equal(
      unrelatedOperation,
      null,
      "the unrelated repository window observed another repository's operation",
    );
    const unrelatedHistory = await driver.findElement(
      By.xpath("//nav[@aria-label='Repository views']//button[normalize-space()='History']"),
    );
    await driver.executeScript((element) => element.click(), unrelatedHistory);
    await driver.wait(
      until.elementLocated(By.css("[data-commit-sha]")),
      10_000,
      "the unrelated repository history did not render",
    );
    assert.equal(
      (await driver.findElements(By.css(`[data-commit-sha="${ownerLossHead}"]`))).length,
      0,
      "the unrelated repository window refreshed with another repository's commit",
    );
  });
});
