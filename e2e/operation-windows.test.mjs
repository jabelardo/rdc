// Multi-window operation foundation: a second native window can hydrate the same repository.
import assert from "node:assert/strict";
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

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    secondRepository = path.join(fixture.root, "second");
    initSimpleRepository(secondRepository);
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
    const differentRepositoryWindow = handles.find(
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
    await driver.wait(
      until.elementTextIs(
        await driver.findElement(By.css('.commit-form button[type="submit"]')),
        "Committing…",
      ),
      5_000,
    );

    await driver.switchTo().window(sameRepositoryWindow);
    const fetchButton = await driver.wait(
      until.elementLocated(
        By.xpath("//section[@aria-label='Remote synchronization']//button[normalize-space()='Fetch']"),
      ),
      10_000,
    );
    await driver.wait(
      async () => (await fetchButton.isEnabled()) === false,
      5_000,
      "the peer Fetch action remained enabled during the owner commit",
    );

    await driver.switchTo().window(mainWindow);
    await driver.wait(
      until.elementTextIs(
        await driver.findElement(By.css('.commit-form button[type="submit"]')),
        "Commit changes",
      ),
      15_000,
      "the owner commit did not finish",
    );
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
      until.elementTextIs(
        await driver.findElement(By.css('.commit-form button[type="submit"]')),
        "Committing…",
      ),
      5_000,
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
  });
});
