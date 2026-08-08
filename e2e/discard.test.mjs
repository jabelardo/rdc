// Discard: a line-level discard of a selection, and a whole-file discard.
//
// The retry loops are deliberate and were carried over verbatim: the working-tree and branch
// stores refresh independently, so React can replace a row, button or dialog once while a
// refresh settles. Each loop reacquires the live element rather than holding a stale handle.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
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

describe("discard", () => {
  let driver;
  let fixture;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    // Reinstate the uncommitted second line, which is what the former suite was left holding
    // after committing only the first line through the commit form.
    writeFileSync(
      path.join(fixture.canonical, "working-tree.txt"),
      "committed line\nleft for partial discard\n",
    );
    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("discards a selected diff line", async () => {
    await driver.wait(
      until.elementLocated(By.css('[data-changed-file-path="working-tree.txt"]')),
      5_000,
    );
    await driver.wait(
      async () => {
        try {
          const remainingLine = await driver.findElement(
            By.css('[aria-label$="left for partial discard"]'),
          );
          if (!(await remainingLine.isSelected())) {
            await driver.executeScript((element) => element.click(), remainingLine);
          }
          return await remainingLine.isSelected();
        } catch {
          return false;
        }
      },
      5_000,
      "remaining diff line did not become selected for discard",
    );
    await driver.wait(
      async () => {
        try {
          const discardSelectedLines = await driver.findElement(
            By.xpath("//button[normalize-space()='Discard selected lines']"),
          );
          if (!(await discardSelectedLines.isEnabled())) {
            return false;
          }
          await driver.executeScript((element) => element.click(), discardSelectedLines);
          return true;
        } catch {
          return false;
        }
      },
      5_000,
      "discard selected lines did not accept the click",
    );
    await driver.wait(until.elementLocated(By.css('[role="alertdialog"]')), 5_000);
    await driver.wait(
      async () => {
        try {
          const discardChanges = await driver.findElement(
            By.xpath("//button[normalize-space()='Discard changes']"),
          );
          await driver.executeScript((element) => element.click(), discardChanges);
          return true;
        } catch {
          return false;
        }
      },
      5_000,
      "discard confirmation did not accept the click",
    );
    try {
      await driver.wait(
        () => git(fixture.canonical, "status", "--porcelain") === "",
        10_000,
        "discarded selection remained in the working tree",
      );
    } catch (error) {
      const body = await driver.findElement(By.css("body")).getText();
      throw new Error(
        `discarded selection remained in the working tree; git status:\n${git(
          fixture.canonical,
          "status",
          "--short",
        )}\ndiff:\n${git(
          fixture.canonical,
          "diff",
          "--",
          "working-tree.txt",
        )}\napplication:\n${body}`,
        { cause: error },
      );
    }
    await driver.navigate().refresh();
    await driver.wait(
      until.elementLocated(By.xpath("//p[normalize-space()='No local changes.']")),
      5_000,
    );
  });

  it("discards a whole file", async () => {
    const discardedPath = path.join(fixture.canonical, "discard-me.txt");
    writeFileSync(discardedPath, "recoverable change\n");
    await driver.navigate().refresh();
    await driver.wait(
      until.elementLocated(By.css('[data-changed-file-path="discard-me.txt"]')),
      5_000,
    );
    const discardFile = await driver.findElement(By.css('[aria-label="Discard discard-me.txt"]'));
    await driver.executeScript((element) => element.click(), discardFile);
    await driver.wait(until.elementLocated(By.css('[role="alertdialog"]')), 5_000);

    // Geometry that only a real browser can confirm, and that both regressed once:
    // the dialog stretched to the full window width because AlertDialogContent had `w-full` with
    // no max-width, and the checkbox rendered as a rectangle because rdc's base `button` padding
    // reached into the Radix primitive. Neither is visible to tsc or a jsdom test.
    const geometry = await driver.executeScript(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      const checkbox = dialog?.querySelector('[data-slot="checkbox"]');
      return {
        dialogWidth: dialog?.getBoundingClientRect().width ?? 0,
        dialogTop: dialog?.getBoundingClientRect().top ?? 0,
        dialogBottom: dialog?.getBoundingClientRect().bottom ?? 0,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        checkbox:
          checkbox === null || checkbox === undefined
            ? null
            : {
                width: Math.round(checkbox.getBoundingClientRect().width),
                height: Math.round(checkbox.getBoundingClientRect().height),
              },
      };
    });
    // Lower bounds matter as much as upper ones: a zero-width dialog would satisfy "narrower than
    // the window", and a 0x0 checkbox would satisfy "square".
    assert.ok(
      geometry.dialogWidth > 200 && geometry.dialogWidth < geometry.windowWidth * 0.9,
      `confirmation dialog width ${geometry.dialogWidth} of window ${geometry.windowWidth}`,
    );
    // A centred dialog taller than the viewport overflows equally above and below, sliding its top
    // off-screen — under the native title bar on macOS, which web content cannot paint over.
    assert.ok(
      geometry.dialogTop >= 0 && geometry.dialogBottom <= geometry.windowHeight,
      `dialog escapes the viewport vertically: ${geometry.dialogTop}..${geometry.dialogBottom} of ${geometry.windowHeight}`,
    );
    assert.notEqual(geometry.checkbox, null, "the discard opt-out checkbox is missing");
    assert.ok(
      geometry.checkbox.width >= 12,
      `opt-out checkbox is too small to be real: ${geometry.checkbox.width}px`,
    );
    assert.equal(
      geometry.checkbox.width,
      geometry.checkbox.height,
      `opt-out checkbox is not square: ${geometry.checkbox.width}x${geometry.checkbox.height}`,
    );

    await driver.findElement(By.xpath("//button[normalize-space()='Discard changes']")).click();
    await driver.wait(() => !existsSync(discardedPath), 10_000, "discarded file remained on disk");
    await driver.navigate().refresh();
    await driver.wait(
      until.elementLocated(By.xpath("//p[normalize-space()='No local changes.']")),
      5_000,
    );
    assert.equal(existsSync(discardedPath), false);
  });
});
