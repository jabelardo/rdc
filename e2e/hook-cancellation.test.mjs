// Slice 12: stop a live intercepted pre-commit hook, then preserve the existing Abort/Ignore
// decision instead of treating hook cancellation as a commit cancellation.
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, until } from "selenium-webdriver";
import {
  createFixtureRoot,
  commitWorkingTreeBaseline,
  git,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  resetRepositoryFixtures,
  startApplication,
} from "./harness.mjs";

describe("hook cancellation", () => {
  let driver;
  let fixture;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    const hook = `${fixture.canonical}/.git/hooks/pre-commit`;
    writeFileSync(hook, "#!/bin/sh\nprintf '%s\\n' 'hook started' >&2\nsleep 30\n");
    chmodSync(hook, 0o755);
    writeFileSync(`${fixture.canonical}/working-tree.txt`, "hook cancellation change\n");

    driver = await startApplication();
    await resetRepositoryFixtures(driver);
    await openSeededRepository(driver, fixture.canonical);
    await driver.wait(until.elementLocated(By.css("#commit-message")), 10_000);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("stops a running hook and reaches the existing Abort/Ignore decision", async () => {
    await driver.findElement(By.css("#commit-message")).sendKeys("Stopped hook commit");
    await driver.findElement(By.css('.commit-form button[type="submit"]')).click();

    const stopHook = await driver.wait(
      until.elementLocated(
        By.xpath("//button[starts-with(normalize-space(), 'Stop pre-commit hook')]"),
      ),
      10_000,
      "the running hook did not expose Stop hook",
    );
    assert.equal(await stopHook.isEnabled(), true);
    await stopHook.click();

    const hookFailure = await driver.wait(
      until.elementLocated(
        By.xpath("//*[@role='alertdialog' and .//*[normalize-space()='Ignore and Continue'] ]"),
      ),
      10_000,
      "stopping the hook did not reach the Abort/Ignore decision",
    );
    assert.match(
      await driver.executeScript((element) => element.textContent, hookFailure),
      /pre-commit|hook/i,
    );
    const abort = await driver.findElement(By.xpath("//button[normalize-space()='Abort']"));
    const ignore = await driver.findElement(
      By.xpath("//button[normalize-space()='Ignore and Continue']"),
    );
    await driver.wait(
      until.elementIsVisible(abort),
      5_000,
      "the Abort action did not become visible",
    );
    await driver.wait(
      until.elementIsVisible(ignore),
      5_000,
      "the Ignore and Continue action did not become visible",
    );

    await abort.click();
    await driver.wait(
      async () =>
        (
          await driver.findElements(
            By.xpath("//button[starts-with(normalize-space(), 'Stop pre-commit hook')]"),
          )
        ).length === 0,
      10_000,
      "the stopped hook did not finish the commit flow",
    );
    assert.notEqual(git(fixture.canonical, "log", "-1", "--pretty=%s"), "Stopped hook commit");
  });
});
