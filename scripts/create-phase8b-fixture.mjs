import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GitEnvironment = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
  GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(arguments_, cwd) {
  return execFileSync("git", arguments_, {
    cwd,
    env: GitEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(arguments_, cwd) {
  return String(git(arguments_, cwd)).trim();
}

function configureIdentity(repository) {
  git(["config", "user.name", "rdc Phase 8b QA"], repository);
  git(["config", "user.email", "rdc-phase8b@example.invalid"], repository);
}

function initializeRepository(repository, files = { "stable.txt": "stable line\n" }) {
  git(["init", "--quiet", "--initial-branch=main", repository]);
  configureIdentity(repository);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(repository, name), contents);
  }
  git(["add", "."], repository);
  git(["commit", "--quiet", "-m", "Initial QA state"], repository);
  return gitText(["rev-parse", "HEAD"], repository);
}

function createBareRemote(remote) {
  git(["init", "--bare", "--quiet", remote]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
}

function publishMain(repository, remote) {
  git(["remote", "add", "origin", remote], repository);
  git(["push", "--quiet", "--set-upstream", "origin", "main"], repository);
  // `push --set-upstream` records the tracking branch but not the remote's HEAD symref. The branch
  // sidebar deliberately refuses to guess a default branch, so every QA repository with a known
  // remote default must record the same fact a successful application fetch records.
  git(["remote", "set-head", "-a", "origin"], repository);
}

function createPublisher(remote, publisher) {
  git(["clone", "--quiet", remote, publisher]);
  configureIdentity(publisher);
}

function writeExecutable(file, contents) {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function createPopulatedScenario(target) {
  const repository = path.join(target, "populated");
  const remote = path.join(target, "populated-remote.git");
  const publisher = path.join(target, "populated-publisher");
  createBareRemote(remote);
  initializeRepository(repository, {
    "modified.txt": "base line\n",
    "stable.txt": "stable line\n",
    "a-very-long-file-name-for-visual-truncation-and-density-review.txt": "long-name fixture\n",
  });
  publishMain(repository, remote);
  createPublisher(remote, publisher);
  writeFileSync(path.join(publisher, "remote-ahead.txt"), "arrived from the fixture publisher\n");
  git(["add", "remote-ahead.txt"], publisher);
  git(["commit", "--quiet", "-m", "Advance fixture remote"], publisher);
  git(["push", "--quiet", "origin", "main"], publisher);

  writeFileSync(path.join(repository, "modified.txt"), "base line\nlocal modification\n");
  writeFileSync(path.join(repository, "untracked.txt"), "untracked QA file\n");
  git(["branch", "publish-me"], repository);
  git(["branch", "qa/a-very-long-branch-name-for-sidebar-truncation-review"], repository);

  return {
    repository,
    remote,
    publisher,
    initialBranch: "main",
    unpublishedBranch: "publish-me",
    expectedWorkingTreeFiles: ["modified.txt", "untracked.txt"],
    expectedRemoteAhead: 1,
  };
}

function createCleanScenario(target) {
  const repository = path.join(target, "clean");
  const head = initializeRepository(repository);
  return { repository, initialBranch: "main", expectedHead: head };
}

function createBranchScenario(target) {
  const repository = path.join(target, "branch");
  initializeRepository(repository);
  return {
    repository,
    initialBranch: "main",
    branchToCreate: "qa-created-branch",
  };
}

function createLineDiscardScenario(target) {
  const repository = path.join(target, "discard-line");
  const file = "line-discard.txt";
  const baselineLines = [
    "first original",
    ...Array.from({ length: 12 }, (_, index) => `unchanged ${index + 1}`),
    "last original",
  ];
  const baselineContent = `${baselineLines.join("\n")}\n`;
  initializeRepository(repository, { [file]: baselineContent });
  const modifiedLines = [...baselineLines];
  modifiedLines[0] = "first changed — discard this hunk";
  modifiedLines[modifiedLines.length - 1] = "last changed — keep this hunk";
  const modifiedContent = `${modifiedLines.join("\n")}\n`;
  writeFileSync(path.join(repository, file), modifiedContent);

  return {
    repository,
    file,
    instruction: "Discard the first hunk and keep the last hunk.",
    baselineContent,
    modifiedContent,
    expectedContent: `${[baselineLines[0], ...modifiedLines.slice(1)].join("\n")}\n`,
  };
}

function createWholeFileDiscardScenario(target) {
  const repository = path.join(target, "discard-file");
  const file = "whole-file-discard.txt";
  const expectedContent = "whole-file baseline\n";
  initializeRepository(repository, { [file]: expectedContent });
  writeFileSync(path.join(repository, file), "discard this entire replacement\n");
  return { repository, file, expectedContent };
}

function createDiscardAllScenario(target) {
  const repository = path.join(target, "discard-all");
  const trackedFile = "discard-all-tracked.txt";
  const untrackedFile = "discard-all-untracked.txt";
  const expectedTrackedContent = "discard-all tracked baseline\n";
  initializeRepository(repository, { [trackedFile]: expectedTrackedContent });
  writeFileSync(path.join(repository, trackedFile), "discard-all tracked modification\n");
  writeFileSync(path.join(repository, untrackedFile), "discard-all untracked file\n");
  return {
    repository,
    trackedFile,
    untrackedFile,
    expectedTrackedContent,
  };
}

/**
 * A discard-all scenario at a scale where the confirmation dialog's list must earn its keep.
 *
 * Two counts, because they exercise different code paths rather than the same one twice:
 * 99 stays under `VirtualList`'s virtualization threshold of 100, so every row is really in the DOM;
 * 1000 crosses it, so the list is windowed and the scroll region has to stay bounded. A mix of
 * tracked modifications and untracked files keeps the recoverable/unrecoverable asymmetry in view at
 * scale, and nested directories make the wrapping of long paths observable.
 */
function createDiscardManyScenario(target, name, fileCount) {
  const repository = path.join(target, name);
  const trackedCount = Math.floor(fileCount / 2);
  const untrackedCount = fileCount - trackedCount;
  const trackedFiles = [];
  const untrackedFiles = [];

  initializeRepository(repository);

  // Committed in a second commit rather than through initializeRepository, which writes its files
  // without creating parent directories. The nesting is deliberate: long paths are what make the
  // dialog's wrapping and its bounded scroll region worth looking at.
  for (let index = 0; index < trackedCount; index += 1) {
    const file = `src/module-${String(index).padStart(4, "0")}/tracked-file-with-a-long-name.txt`;
    const absolute = path.join(repository, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `tracked baseline ${index}\n`);
    trackedFiles.push(file);
  }
  git(["add", "."], repository);
  git(["commit", "--quiet", "-m", `Baseline for ${fileCount} changed files`], repository);

  for (const [index, file] of trackedFiles.entries()) {
    writeFileSync(path.join(repository, file), `tracked modification ${index}\n`);
  }
  for (let index = 0; index < untrackedCount; index += 1) {
    const file = `generated/deeply/nested/output-${String(index).padStart(4, "0")}.log`;
    const absolute = path.join(repository, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `untracked ${index}\n`);
    untrackedFiles.push(file);
  }

  return {
    repository,
    fileCount,
    trackedCount,
    untrackedCount,
    // The count the dialog must state; this is what the human check asserts against.
    expectedDialogFileCount: fileCount,
    virtualized: fileCount > 100,
    sampleTrackedFile: trackedFiles[0],
    sampleUntrackedFile: untrackedFiles[0],
  };
}

function createCommitHookScenario(target) {
  const repository = path.join(target, "commit-hook");
  initializeRepository(repository);
  const file = "commit-me.txt";
  writeFileSync(path.join(repository, file), "commit after reviewing hook output\n");
  const hook = path.join(repository, ".git", "hooks", "pre-commit");
  writeExecutable(hook, '#!/bin/sh\necho "rdc Phase 8b hook says no" >&2\nexit 7\n');
  return {
    repository,
    file,
    hookExitCode: 7,
    expectedGitExitCode: 1,
    expectedHookMessage: "rdc Phase 8b hook says no",
    commitSummary: "Phase 8b hook-bypass commit",
  };
}

function createMergeConflictScenario(target) {
  const repository = path.join(target, "merge-conflict");
  const file = "merge-conflict.txt";
  initializeRepository(repository, { [file]: "common value\n" });
  git(["checkout", "--quiet", "-b", "conflict-side"], repository);
  writeFileSync(path.join(repository, file), "conflict-side value\n");
  git(["add", file], repository);
  git(["commit", "--quiet", "-m", "Change value on conflict side"], repository);
  git(["checkout", "--quiet", "main"], repository);
  writeFileSync(path.join(repository, file), "main-side value\n");
  git(["add", file], repository);
  git(["commit", "--quiet", "-m", "Change value on main"], repository);
  try {
    git(["merge", "--quiet", "conflict-side"], repository);
    throw new Error("Expected the QA merge to conflict");
  } catch (error) {
    if (error instanceof Error && error.message === "Expected the QA merge to conflict") {
      throw error;
    }
  }
  if (gitText(["diff", "--name-only", "--diff-filter=U"], repository) !== file) {
    throw new Error("The generated QA merge did not leave the expected conflict");
  }
  return {
    repository,
    file,
    initialBranch: "main",
    mergedBranch: "conflict-side",
    expectedResolution: "resolved during rdc Phase 8b QA\n",
  };
}

function createFetchPullScenario(target) {
  const repository = path.join(target, "remote-fetch-pull");
  const remote = path.join(target, "remote-fetch-pull.git");
  const publisher = path.join(target, "remote-fetch-pull-publisher");
  createBareRemote(remote);
  const localHead = initializeRepository(repository);
  publishMain(repository, remote);
  createPublisher(remote, publisher);
  const file = "pulled-from-publisher.txt";
  const expectedContent = "remote fetch/pull QA content\n";
  writeFileSync(path.join(publisher, file), expectedContent);
  git(["add", file], publisher);
  git(["commit", "--quiet", "-m", "Advance fetch/pull remote"], publisher);
  git(["push", "--quiet", "origin", "main"], publisher);
  return {
    repository,
    remote,
    publisher,
    initialBranch: "main",
    localHeadBeforeFetch: localHead,
    remoteHead: gitText(["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    expectedPulledFile: file,
    expectedPulledContent: expectedContent,
  };
}

function createPushScenario(target, name, delaySeconds = 0) {
  const repository = path.join(target, name);
  const remote = path.join(target, `${name}.git`);
  createBareRemote(remote);
  initializeRepository(repository);
  publishMain(repository, remote);
  git(["checkout", "--quiet", "-b", "publish-me"], repository);
  const file = "push-me.txt";
  writeFileSync(path.join(repository, file), `${name} QA content\n`);
  git(["add", file], repository);
  git(["commit", "--quiet", "-m", `Prepare ${name}`], repository);

  if (delaySeconds > 0) {
    writeExecutable(
      path.join(remote, "hooks", "pre-receive"),
      `#!/bin/sh\nsleep ${delaySeconds}\n`,
    );
  }

  return {
    repository,
    remote,
    unpublishedBranch: "publish-me",
    localHead: gitText(["rev-parse", "HEAD"], repository),
    ...(delaySeconds > 0 ? { delaySeconds } : {}),
  };
}

function createCloneScenario(target) {
  const source = path.join(target, "clone-source");
  const remote = path.join(target, "clone-source.git");
  const destination = path.join(target, "clone-destination");
  createBareRemote(remote);
  const expectedHead = initializeRepository(source, {
    "cloned-content.txt": "content expected in the QA clone\n",
  });
  publishMain(source, remote);
  return { source, remote, destination, expectedHead };
}

function createUnreachableRemoteScenario(target) {
  const repository = path.join(target, "unreachable-remote");
  initializeRepository(repository);
  const remoteUrl = "http://127.0.0.1:9/rdc-phase8b-unreachable.git";
  git(["remote", "add", "origin", remoteUrl], repository);
  return { repository, remoteUrl, expectedOperation: "fetch" };
}

/**
 * Create named, independent Git states for human QA without relying on the
 * developer's identity, default branch, network, or existing repositories.
 */
export function createPhase8bFixture(requestedTarget) {
  const target = path.resolve(requestedTarget);
  if (existsSync(target)) {
    throw new Error(`Refusing to replace existing fixture target: ${target}`);
  }
  mkdirSync(target, { recursive: true });

  try {
    const scenarios = {
      clean: createCleanScenario(target),
      populated: createPopulatedScenario(target),
      branch: createBranchScenario(target),
      lineDiscard: createLineDiscardScenario(target),
      wholeFileDiscard: createWholeFileDiscardScenario(target),
      discardAll: createDiscardAllScenario(target),
      discardMany99: createDiscardManyScenario(target, "discard-many-99", 99),
      discardMany1000: createDiscardManyScenario(target, "discard-many-1000", 1000),
      commitHook: createCommitHookScenario(target),
      mergeConflict: createMergeConflictScenario(target),
      remoteFetchPull: createFetchPullScenario(target),
      remotePush: createPushScenario(target, "remote-push"),
      remoteClone: createCloneScenario(target),
      delayedPush: createPushScenario(target, "delayed-push", 3),
      unreachableRemote: createUnreachableRemoteScenario(target),
    };
    const populated = scenarios.populated;
    const manifest = {
      schemaVersion: 2,
      target,
      scenarios,
      // Transitional aliases keep the accepted foundation checklist and any
      // local notes from the original single-repository fixture valid.
      primary: populated.repository,
      remote: populated.remote,
      publisher: populated.publisher,
      initialBranch: populated.initialBranch,
      unpublishedBranch: populated.unpublishedBranch,
      expectedWorkingTreeFiles: populated.expectedWorkingTreeFiles,
      expectedRemoteAhead: populated.expectedRemoteAhead,
    };
    writeFileSync(
      path.join(target, "fixture-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

/**
 * pnpm 11 preserves the conventional `--` separator in a script's argv. Accept
 * both the documented `pnpm fixture:phase8b -- <target>` form and direct Node
 * invocation without ever mistaking the separator for a directory name.
 */
export function parsePhase8bFixtureTarget(arguments_) {
  const positionals = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  return positionals.length === 1 && positionals[0] !== "" ? positionals[0] : undefined;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const target = parsePhase8bFixtureTarget(process.argv.slice(2));
  if (target === undefined) {
    console.error("Usage: node scripts/create-phase8b-fixture.mjs <new-target-directory>");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(createPhase8bFixture(target), null, 2));
  }
}
