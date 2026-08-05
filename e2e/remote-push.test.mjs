// Push: an unpublished local branch reaches the bare remote and gets its upstream configured.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  git,
  gitBare,
  initCanonicalRepository,
  openSeededRepository,
  publishCanonical,
  remoteHasBranch,
  removeFixtureRoot,
  startApplication,
  upstreamOf,
} from "./harness.mjs";

const pushBranch = "phase-7d-push";

describe("remote push", () => {
  let driver;
  let fixture;
  let localHead;

  before(async () => {
    fixture = createFixtureRoot();
    initCanonicalRepository(fixture);
    commitWorkingTreeBaseline(fixture);
    const publishedBranch = publishCanonical(fixture);

    // A branch with no upstream, which is what makes Push the available action.
    git(
      fixture.canonical,
      "checkout",
      "--quiet",
      "--no-track",
      "-b",
      pushBranch,
      `origin/${publishedBranch}`,
    );
    writeFileSync(
      path.join(fixture.canonical, "pushed-by-rdc.txt"),
      "this commit was pushed through rdc\n",
    );
    git(fixture.canonical, "add", "pushed-by-rdc.txt");
    git(fixture.canonical, "commit", "--quiet", "--no-verify", "-m", "Push through rdc");
    localHead = git(fixture.canonical, "rev-parse", "HEAD");

    driver = await startApplication();
    await openSeededRepository(driver, fixture.canonical);
  });

  after(async () => {
    await driver?.quit().catch(() => undefined);
    removeFixtureRoot(fixture);
  });

  it("pushes an unpublished branch to the local bare remote", async () => {
    assert.equal(remoteHasBranch(fixture.remote, pushBranch), false);

    const pushButton = await driver.wait(
      async () => {
        try {
          const button = await driver.findElement(
            By.xpath(
              "//section[@aria-label='Remote synchronization']//button[normalize-space()='Push']",
            ),
          );
          return (await button.isEnabled()) ? button : false;
        } catch {
          return false;
        }
      },
      10_000,
      "push did not become available for the new branch",
    );
    await driver.executeScript((element) => element.click(), pushButton);
    await driver.wait(
      () => remoteHasBranch(fixture.remote, pushBranch),
      10_000,
      "push did not create the branch in the bare remote",
    );
    assert.equal(gitBare(fixture.remote, "rev-parse", `refs/heads/${pushBranch}`), localHead);
    await driver.wait(
      () => upstreamOf(fixture.canonical) === `origin/${pushBranch}`,
      10_000,
      "push created the remote branch but did not configure its upstream",
    );
    assert.equal(upstreamOf(fixture.canonical), `origin/${pushBranch}`);
  });
});
