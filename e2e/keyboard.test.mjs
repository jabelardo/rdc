// Keyboard-only journey: stage, commit, resolve the hook prompt and reach history without any
// pointer input. This is the accessibility contract for the MVP workflow.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  startApplication,
} from "./harness.mjs";

describe("keyboard-only journey", () => {
  let driver;
  let fixture;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture, { failingPreCommitHook: true });
    commitWorkingTreeBaseline(fixture);
    writeFileSync(
      path.join(fixture.canonical, "keyboard-only.txt"),
      "committed without pointer input\n",
    );
    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("completes a local repository journey using only the keyboard", async () => {
    const changedFile = await driver.wait(
      until.elementLocated(By.css('[data-changed-file-path="keyboard-only.txt"]')),
      5_000,
    );
    const selection = await changedFile.findElement(By.css("[data-keyboard-list-item]"));
    await selection.sendKeys(Key.ENTER);
    await driver.wait(
      until.elementLocated(
        By.css(
          '[aria-label="Diff for keyboard-only.txt"], [aria-label="File diff"] [role="table"]',
        ),
      ),
      5_000,
    );

    const refreshedChangedFile = await driver.findElement(
      By.css('[data-changed-file-path="keyboard-only.txt"]'),
    );
    const include = await refreshedChangedFile.findElement(
      By.css('[aria-label="Include keyboard-only.txt"]'),
    );
    assert.equal(await include.isSelected(), true);
    await include.sendKeys(Key.SPACE);
    await driver.wait(
      async () => !(await include.isSelected()),
      5_000,
      "Space did not exclude the changed file",
    );
    await include.sendKeys(Key.SPACE);
    await driver.wait(
      async () => await include.isSelected(),
      5_000,
      "Space did not include the changed file",
    );

    const message = "Keyboard-only MVP journey";
    const commitMessage = await driver.findElement(By.css("#commit-message"));
    await commitMessage.sendKeys(message);
    await driver.findElement(By.css('.commit-form button[type="submit"]')).sendKeys(Key.ENTER);
    const hookDialog = await driver.wait(
      until.elementLocated(By.css('[role="alertdialog"]')),
      10_000,
    );
    assert.match(await hookDialog.getText(), /pre-commit.*hook says no/s);

    await driver.switchTo().activeElement().sendKeys(Key.ESCAPE);
    assert.equal(await hookDialog.isDisplayed(), true);
    assert.equal(await driver.switchTo().activeElement().getText(), "Abort");
    await driver.switchTo().activeElement().sendKeys(Key.TAB);
    assert.equal(await driver.switchTo().activeElement().getText(), "Ignore and Continue");
    await driver.switchTo().activeElement().sendKeys(Key.ENTER);

    await driver.wait(
      () => git(fixture.canonical, "log", "-1", "--pretty=%s") === message,
      10_000,
      "keyboard-submitted commit did not complete",
    );
    const history = await driver.findElement(
      By.xpath("//nav[@aria-label='Repository views']//button[normalize-space()='History']"),
    );
    await history.sendKeys(Key.ENTER);
    await driver.wait(
      until.elementLocated(
        By.xpath(`//section[@aria-label='History']//strong[normalize-space()='${message}']`),
      ),
      10_000,
    );
  });
});
