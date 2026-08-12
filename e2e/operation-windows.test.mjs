// Multi-window operation foundation: a second native window can hydrate the same repository.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  expandSidebarSection,
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
});
