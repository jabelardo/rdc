// Clone: the clone dialog produces a real repository, registers it and selects it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  expandSidebarSection,
  git,
  gitBare,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  removeFixtureRoot,
  sendNativeKeys,
  startApplication,
} from "./harness.mjs";

describe("clone", () => {
  let driver;
  let fixture;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    // The bare remote needs a HEAD and a branch before it can be cloned.
    publishCanonical(fixture);
    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("clones the local bare remote and selects the persisted repository", async () => {
    sendNativeKeys("ctrl+shift+o");
    const cloneDialog = await driver.wait(
      until.elementLocated(
        By.xpath("//*[@role='dialog' and .//*[normalize-space()='Clone a repository'] ]"),
      ),
      5_000,
    );
    await cloneDialog.findElement(By.css("#clone-url")).sendKeys(fixture.remote);
    await cloneDialog.findElement(By.css("#clone-path")).sendKeys(fixture.clone);
    await cloneDialog
      .findElement(By.xpath(".//button[@type='submit' and normalize-space()='Clone']"))
      .click();

    // CloneStore finishes the native operation before AppStore persists and selects the new
    // repository. Wait for the dialog to leave the DOM so the sidebar assertion starts after that
    // entire hand-off, rather than racing the intermediate progress state.
    await driver.wait(until.stalenessOf(cloneDialog), 10_000);

    // The cloned repository is asserted through its sidebar row, so its panel has to be open.
    await expandSidebarSection(driver, "repositories");
    const clonedRepository = await driver.wait(
      until.elementLocated(By.css(`[data-repository-path="${fixture.clone}"]`)),
      10_000,
      "the cloned repository was not added to the repository list",
    );
    await driver.wait(
      async () => (await clonedRepository.getAttribute("aria-current")) === "true",
      5_000,
      "the cloned repository was not selected",
    );
    assert.equal(git(fixture.clone, "remote", "get-url", "origin"), fixture.remote);
    assert.equal(
      git(fixture.clone, "rev-parse", "HEAD"),
      gitBare(fixture.remote, "rev-parse", "HEAD"),
    );
  });
});
