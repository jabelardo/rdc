// Fails fast, and legibly, when the active Node major is not the pinned one.
//
// This exists because the wrong Node does not produce a version error — it produces a
// *plausible application failure*. Node 26 ships an experimental built-in `localStorage`
// global that is `undefined` unless `--localstorage-file` is passed, and it shadows jsdom's
// implementation. Every web-storage-dependent test then fails with
// `Cannot read properties of undefined`, which reads as a broken store layer rather than a
// wrong runtime. Measured: 26 failures on Node 26 versus 937/937 passing on Node 24.
//
// `AGENTS.md` and `DEVELOPMENT.md` already say "Node 24, via nvm. Not 22, not 26." That prose
// is necessary and insufficient: a fresh shell, a CI-less script or an agent that never opens
// AGENTS.md all reach for whatever `node` resolves to. Hence a mechanical gate.
//
// Two entry points, one source of truth (`engines.node` in package.json):
//   - imported by `vite.config.ts`, so every vite/vitest run is covered, including a bare
//     `npx vitest` that skips package scripts entirely;
//   - run directly (`node scripts/check-node-version.mjs`) as the `pretest` hook and by hand.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import semver from "semver";

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

/**
 * @returns {string} the `engines.node` range this repository pins.
 */
function pinnedRange() {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const range = manifest.engines?.node;
  if (typeof range !== "string") {
    throw new Error(
      `package.json has no engines.node range; ${packageJsonPath} is the source of truth for the Node pin`,
    );
  }
  return range;
}

/**
 * Throws when the running Node does not satisfy `engines.node`.
 *
 * @param {string} [version] the Node version to check; defaults to the running one.
 */
export function assertNodeVersion(version = process.versions.node) {
  const range = pinnedRange();
  if (semver.satisfies(version, range)) {
    return;
  }

  throw new Error(
    [
      `rdc requires Node ${range}, but this process is Node ${version}.`,
      "",
      "Run `nvm use` (the repository has a .nvmrc) and try again.",
      "Do not unpin the version to make something pass: Node 26 silently shadows",
      "jsdom's localStorage, so the failures you get instead look like broken",
      "application code. See AGENTS.md.",
    ].join("\n"),
  );
}

// `realpathSync`, not `path.resolve`: Node realpaths the entry specifier before setting
// `import.meta.url`, so comparing an unresolved `argv[1]` fails whenever the repository is reached
// through a symlink (`~/src -> /Volumes/dev/src`, a git worktree link, or a checkout under macOS
// `/tmp`, which is itself `/private/tmp`). It then failed *silently* — exit 0, no output — which is
// the exact mode this script exists to prevent.
const invokedDirectly = (() => {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    assertNodeVersion();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
