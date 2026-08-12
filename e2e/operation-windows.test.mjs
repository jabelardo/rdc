// Multi-window operation foundation: a second native window can hydrate the same repository.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  expandSidebarSection,
  initCanonicalRepository,
  openRepositoryWindow,
  openSeededRepository,
  repositorySelector,
  removeFixtureRoot,
  startApplication,
} from "./harness.mjs";

describe("operation windows", () => {
  let driver;
  let fixture;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("opens a second native window with the same selected repository", async () => {
    const originalWindow = await driver.getWindowHandle();
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
});
