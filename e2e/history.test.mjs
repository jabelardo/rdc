// History: the commit list, the selected-commit details and its diff.
//
// The commit under test is created by CLI rather than through the commit form — that path is
// covered by working-tree.test.mjs, and this spec only needs the commit to exist.
import assert from "node:assert/strict";
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
} from "./harness.mjs";

describe("history", () => {
  let driver;
  let fixture;
  let head;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    head = commitWorkingTreeBaseline(fixture);
    git(
      fixture.canonical,
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-verify",
      "-m",
      "History operation middle",
    );
    git(
      fixture.canonical,
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-verify",
      "-m",
      "History operation newest",
    );
    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("shows the commit, its details and its diff", async () => {
    const historyView = await driver.findElement(
      By.xpath("//nav[@aria-label='Repository views']//button[normalize-space()='History']"),
    );
    await driver.executeScript((element) => element.click(), historyView);

    const committedHistoryItem = await driver.wait(
      until.elementLocated(By.css(`[data-commit-sha="${head}"]`)),
      10_000,
    );
    await driver.executeScript((element) => element.click(), committedHistoryItem);
    assert.match(
      await driver.executeScript((element) => element.textContent, committedHistoryItem),
      /Commit from the real shell.*rdc E2E/s,
    );

    const selectedCommitDetails = await driver.wait(
      until.elementLocated(By.css('[aria-label="Selected commit details"]')),
      10_000,
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, selectedCommitDetails),
      /Commit from the real shell.*1 changed file.*working-tree\.txt/s,
    );

    const copyCommitHash = await driver.findElement(By.css('[aria-label="Copy full commit hash"]'));
    assert.equal(await copyCommitHash.getAttribute("data-tooltip"), head);
    await driver.executeScript((element) => element.focus(), copyCommitHash);
    await driver.wait(
      async () =>
        await driver.executeScript(() => {
          const tooltip = document.querySelector(".app-tooltip");
          return (
            tooltip?.textContent.length === 40 &&
            tooltip.scrollWidth <= tooltip.clientWidth &&
            getComputedStyle(tooltip).opacity === "1"
          );
        }),
      2_000,
      "the full hash did not fit inside its tooltip",
    );
    await driver.executeScript(() => {
      window.__rdcCopiedCommitHash = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText(value) {
            window.__rdcCopiedCommitHash = value;
            return Promise.resolve();
          },
        },
      });
    });
    await driver.executeScript((element) => element.click(), copyCommitHash);
    await driver.wait(
      async () => (await driver.executeScript(() => window.__rdcCopiedCommitHash)) === head,
      2_000,
      "clicking the short hash did not copy the complete commit hash",
    );

    const commitDiff = await driver.wait(
      until.elementLocated(By.css('[aria-label="Diff for working-tree.txt"]')),
      10_000,
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, commitDiff),
      /\+committed line/,
    );
  });

  // The return trip matters on its own: `repositoryView` gates the changes workspace, so a
  // regression that leaves it stuck on 'history' would otherwise go unseen — no other spec
  // opens History and comes back.
  it("returns to the changes workspace from history", async () => {
    const changesView = await driver.findElement(
      By.xpath("//nav[@aria-label='Repository views']//button[normalize-space()='Changes']"),
    );
    await driver.executeScript((element) => element.click(), changesView);
    await driver.wait(
      until.elementLocated(By.xpath("//p[normalize-space()='No local changes.']")),
      5_000,
      "the changes workspace did not come back after leaving history",
    );
  });

  it("exposes the interactive history controls for a contiguous selection", async () => {
    const historyView = await driver.findElement(
      By.xpath("//nav[@aria-label='Repository views']//button[normalize-space()='History']"),
    );
    await driver.executeScript((element) => element.click(), historyView);

    await driver.wait(
      until.elementLocated(By.css('[aria-label="Select History operation newest"]')),
      10_000,
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.css('[aria-label="Select History operation newest"]')),
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.css('[aria-label="Select History operation middle"]')),
    );

    const squash = await driver.findElement(
      By.xpath("//button[normalize-space()='Squash selected']"),
    );
    assert.equal(await squash.getText(), "Squash selected");

    const reorderTarget = await driver.findElement(By.css('[aria-label="Move selected before"]'));
    const options = await reorderTarget.findElements(By.css("option"));
    assert.equal(await options[0].getText(), "End of history");
    assert.match(await options[1].getText(), /Before Commit from the real shell/);
    assert.equal(
      await driver
        .findElement(By.xpath("//button[normalize-space()='Reorder selected']"))
        .isEnabled(),
      true,
    );

    await driver.executeScript(() => {
      window.confirm = () => true;
    });
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.css('[aria-label="Select History operation middle"]')),
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.css('[aria-label="Select Commit from the real shell"]')),
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.xpath("//button[normalize-space()='Reorder selected']")),
    );
    await driver.wait(
      () =>
        git(fixture.canonical, "log", "-3", "--pretty=%s") ===
        "History operation newest\nCommit from the real shell\nHistory operation middle",
      10_000,
      "reorder did not move the selected commits to the end",
    );

    await driver.wait(
      until.elementLocated(By.css('[aria-label="Select History operation newest"]')),
      10_000,
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.css('[aria-label="Select History operation newest"]')),
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.css('[aria-label="Select Commit from the real shell"]')),
    );
    await driver.executeScript(
      (element) => element.click(),
      await driver.findElement(By.xpath("//button[normalize-space()='Squash selected']")),
    );
    await driver.wait(
      () => git(fixture.canonical, "rev-list", "--count", "HEAD") === "2",
      10_000,
      "squash did not reduce the history to two commits",
    );
  });
});
