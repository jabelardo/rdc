import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPhase8bFixture, parsePhase8bFixtureTarget } from "./create-phase8b-fixture.mjs";

function git(repository, ...arguments_) {
  return String(
    execFileSync("git", ["-C", repository, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
}

test("accepts pnpm and direct invocation without treating -- as the target", () => {
  assert.equal(parsePhase8bFixtureTarget(["--", "/tmp/rdc-phase8b-qa"]), "/tmp/rdc-phase8b-qa");
  assert.equal(parsePhase8bFixtureTarget(["/tmp/rdc-phase8b-qa"]), "/tmp/rdc-phase8b-qa");
  assert.equal(parsePhase8bFixtureTarget(["--"]), undefined);
  assert.equal(parsePhase8bFixtureTarget(["one", "two"]), undefined);
});

test("creates independent deterministic scenarios for every mutable QA journey", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rdc-phase8b-fixture-test-"));
  const target = path.join(root, "fixture");
  try {
    const manifest = createPhase8bFixture(target);
    const { scenarios } = manifest;

    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(Object.keys(scenarios), [
      "clean",
      "populated",
      "branch",
      "lineDiscard",
      "wholeFileDiscard",
      "discardAll",
      "discardMany99",
      "discardMany1000",
      "mergeStates",
      "commitHook",
      "mergeConflict",
      "remoteFetchPull",
      "remotePush",
      "remoteClone",
      "delayedPush",
      "unreachableRemote",
    ]);
    assert.equal(manifest.primary, scenarios.populated.repository);
    const repositoryPaths = Object.values(scenarios)
      .map((scenario) => scenario.repository)
      .filter(Boolean);
    assert.equal(
      new Set(repositoryPaths).size,
      repositoryPaths.length,
      "every repository-backed journey must own a distinct working tree",
    );

    assert.equal(git(scenarios.clean.repository, "status", "--short"), "");
    assert.equal(
      git(scenarios.clean.repository, "rev-parse", "HEAD"),
      scenarios.clean.expectedHead,
    );
    assert.equal(
      git(scenarios.branch.repository, "branch", "--show-current"),
      scenarios.branch.initialBranch,
    );
    assert.equal(git(scenarios.populated.repository, "branch", "--show-current"), "main");
    assert.equal(
      git(scenarios.populated.repository, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"),
      "origin/main",
    );
    assert.match(
      git(scenarios.populated.repository, "status", "--short"),
      /modified\.txt.*untracked\.txt/s,
    );
    assert.equal(
      git(scenarios.populated.repository, "ls-remote", "--heads", "origin", "main").split(
        /\s/,
      )[0] === git(scenarios.populated.repository, "rev-parse", "HEAD"),
      false,
    );
    assert.equal(
      git(
        scenarios.populated.remote,
        "rev-list",
        "--count",
        `${git(scenarios.populated.repository, "rev-parse", "HEAD")}..refs/heads/main`,
      ),
      String(scenarios.populated.expectedRemoteAhead),
    );

    assert.equal(
      readFileSync(path.join(scenarios.lineDiscard.repository, scenarios.lineDiscard.file), "utf8"),
      scenarios.lineDiscard.modifiedContent,
    );
    assert.equal(
      git(scenarios.lineDiscard.repository, "diff", "--numstat"),
      `2\t2\t${scenarios.lineDiscard.file}`,
    );
    assert.match(
      git(scenarios.wholeFileDiscard.repository, "status", "--short"),
      /whole-file-discard\.txt/,
    );
    const discardAllStatus = git(scenarios.discardAll.repository, "status", "--short");
    assert.match(discardAllStatus, new RegExp(scenarios.discardAll.trackedFile));
    assert.match(discardAllStatus, new RegExp(scenarios.discardAll.untrackedFile));

    // The counts are the whole point of these two scenarios: the dialog states a number, and a
    // fixture that produced 98 or 1001 would quietly invalidate the check it exists for. 99 stays
    // under VirtualList's threshold of 100 and 1000 crosses it, so they exercise different paths.
    for (const scenario of [scenarios.discardMany99, scenarios.discardMany1000]) {
      const changed = git(scenario.repository, "status", "--porcelain", "--untracked-files=all")
        .split("\n")
        .filter((line) => line.trim() !== "");
      assert.equal(
        changed.length,
        scenario.fileCount,
        `${scenario.repository} reported ${changed.length} changed files, expected ${scenario.fileCount}`,
      );
      assert.equal(scenario.trackedCount + scenario.untrackedCount, scenario.fileCount);
      assert.match(changed.join("\n"), new RegExp(scenario.sampleTrackedFile));
      assert.match(changed.join("\n"), new RegExp(scenario.sampleUntrackedFile));
    }
    assert.equal(scenarios.discardMany99.virtualized, false);
    assert.equal(scenarios.discardMany1000.virtualized, true);

    git(scenarios.commitHook.repository, "add", scenarios.commitHook.file);
    assert.throws(
      () =>
        execFileSync(
          "git",
          [
            "-C",
            scenarios.commitHook.repository,
            "commit",
            "-m",
            scenarios.commitHook.commitSummary,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      (error) => {
        assert.equal(error.status, scenarios.commitHook.expectedGitExitCode);
        assert.match(String(error.stderr), new RegExp(scenarios.commitHook.expectedHookMessage));
        return true;
      },
    );

    assert.equal(
      git(scenarios.mergeConflict.repository, "diff", "--name-only", "--diff-filter=U"),
      scenarios.mergeConflict.file,
    );
    assert.equal(
      existsSync(path.join(scenarios.mergeConflict.repository, ".git", "MERGE_HEAD")),
      true,
    );

    assert.equal(
      git(scenarios.remoteFetchPull.repository, "rev-parse", "HEAD"),
      scenarios.remoteFetchPull.localHeadBeforeFetch,
    );
    assert.notEqual(
      scenarios.remoteFetchPull.localHeadBeforeFetch,
      scenarios.remoteFetchPull.remoteHead,
    );
    assert.equal(
      git(scenarios.remoteFetchPull.repository, "rev-parse", "refs/remotes/origin/main"),
      scenarios.remoteFetchPull.localHeadBeforeFetch,
    );
    assert.equal(
      git(scenarios.remotePush.repository, "branch", "--show-current"),
      scenarios.remotePush.unpublishedBranch,
    );
    assert.throws(() =>
      git(
        scenarios.remotePush.repository,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ),
    );
    assert.equal(existsSync(scenarios.remoteClone.destination), false);
    assert.equal(
      git(scenarios.remoteClone.remote, "rev-parse", "refs/heads/main"),
      scenarios.remoteClone.expectedHead,
    );

    const delayHook = path.join(scenarios.delayedPush.remote, "hooks", "pre-receive");
    assert.match(readFileSync(delayHook, "utf8"), /sleep 3/);
    assert.notEqual(statSync(delayHook).mode & 0o111, 0);
    assert.equal(
      git(scenarios.unreachableRemote.repository, "remote", "get-url", "origin"),
      scenarios.unreachableRemote.remoteUrl,
    );

    assert.deepEqual(
      JSON.parse(readFileSync(path.join(target, "fixture-manifest.json"), "utf8")),
      manifest,
    );
    assert.throws(
      () => createPhase8bFixture(target),
      /Refusing to replace existing fixture target/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
