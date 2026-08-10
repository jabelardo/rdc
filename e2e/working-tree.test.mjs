// Working tree: repository persistence into the real shell, the diff, file and line-level
// inclusion, and committing through an intercepted failing pre-commit hook.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key, until } from "selenium-webdriver";
import {
  createFixtureRoot,
  expandSidebarSection,
  git,
  gitRaw,
  initCanonicalRepository,
  readRepositoryFixtures,
  removeFixtureRoot,
  repositorySelector,
  resetRepositoryFixtures,
  seedRepositoryFixture,
  startApplication,
} from "./harness.mjs";

describe("working tree", () => {
  let driver;
  let fixture;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture, { failingPreCommitHook: true });
    driver = await startApplication();
    // This spec asserts the exact record count, so it needs the store empty regardless of
    // which spec files ran before it. See resetRepositoryFixtures.
    await resetRepositoryFixtures(driver);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("loads the persisted repository fixture into the real shell", async () => {
    const seeded = await seedRepositoryFixture(driver, fixture.canonical);
    assert.deepEqual(seeded, { count: 1 });
    await driver.navigate().refresh();
    const persisted = await readRepositoryFixtures(driver);
    assert.deepEqual(
      persisted.map((repository) => repository.path),
      [fixture.canonical],
    );
    await expandSidebarSection(driver, "repositories");
    await driver.wait(until.elementLocated(repositorySelector(fixture.canonical)), 5_000);
    const changedFile = await driver.wait(
      until.elementLocated(By.css('[data-changed-file-path="working-tree.txt"]')),
      5_000,
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, changedFile),
      /working-tree\.txt/,
    );
    assert.equal(
      await changedFile
        .findElement(By.css('[role="img"][aria-label="New"]'))
        .getAttribute("data-tooltip"),
      "New",
    );
    const diff = await driver.wait(
      until.elementLocated(By.css('[aria-label="File diff"] [role="table"]')),
      5_000,
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, diff),
      /\+committed line.*\+left for partial discard/s,
    );
  });

  it("includes and excludes the changed file and a single diff line", async () => {
    const includeFile = await driver.findElement(By.css('[aria-label="Include working-tree.txt"]'));
    assert.equal(await includeFile.isSelected(), true);
    await driver.executeScript((element) => element.click(), includeFile);
    await driver.wait(
      async () => !(await includeFile.isSelected()),
      5_000,
      "working-tree file did not become excluded",
    );
    await driver.executeScript((element) => element.click(), includeFile);
    await driver.wait(
      async () => await includeFile.isSelected(),
      5_000,
      "working-tree file did not become included",
    );
    const secondLine = await driver.findElement(
      By.css('[aria-label="Include diff line 2: left for partial discard"]'),
    );
    assert.equal(await secondLine.isSelected(), true);
    // WebKitGTK occasionally accepts WebDriver's synthetic pointer click
    // without dispatching the checkbox change event while branch facts finish
    // their independent initial load. DOM click exercises the same product
    // handler deterministically.
    await driver.executeScript((element) => element.click(), secondLine);
    await driver.wait(
      async () => !(await secondLine.isSelected()),
      5_000,
      "second diff line did not become excluded",
    );
  });

  it("commits the included selection after ignoring a failing pre-commit hook", async () => {
    const commitMessage = await driver.findElement(By.css("#commit-message"));
    await commitMessage.sendKeys("Commit from the real shell");
    const commitButton = await driver.findElement(By.css('.commit-form button[type="submit"]'));
    await commitMessage.sendKeys(Key.ENTER);
    await driver.wait(until.elementTextIs(commitButton, "Committing…"), 5_000);
    let hookResult;
    try {
      hookResult = await driver.wait(
        until.elementLocated(
          By.xpath(
            "//*[@role='alertdialog' and .//*[normalize-space()='Ignore and Continue']]",
          ),
        ),
        10_000,
      );
    } catch (error) {
      const body = await driver.findElement(By.css("body")).getText();
      throw new Error(
        `hook prompt did not surface; git status:\n${git(
          fixture.canonical,
          "status",
          "--short",
        )}\napplication:\n${body}`,
        { cause: error },
      );
    }
    assert.equal(
      await hookResult.getAttribute("role"),
      "alertdialog",
      `hook interception failed before prompting: ${await hookResult.getText()}`,
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, hookResult),
      /pre-commit.*hook says no/s,
    );
    await driver.findElement(By.xpath("//button[normalize-space()='Ignore and Continue']")).click();
    await driver.wait(() => {
      try {
        return git(fixture.canonical, "log", "-1", "--pretty=%s") === "Commit from the real shell";
      } catch {
        return false;
      }
    }, 10_000);
    assert.equal(git(fixture.canonical, "log", "-1", "--pretty=%s"), "Commit from the real shell");
    assert.equal(gitRaw(fixture.canonical, "show", "HEAD:working-tree.txt"), "committed line\n");
  });
});
