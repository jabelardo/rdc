// Fails if `src/` violates the dependency direction PROJECT_STRUCTURE.md establishes.
//
// The rule is: shared -> features -> app. A feature may not import another feature; shared code may
// not import a feature or the app; and only the app composes. `import/no-restricted-paths` would
// express this, and oxlint does not implement it — checked against its schema, which has
// `import/no-cycle` and `import/no-relative-parent-imports` and nothing that describes a zone. So
// this script owns the layer rule and oxlint owns the import form.
//
// It also owns the half of the import convention no lint rule catches. `import/no-relative-parent-
// imports` bans `../`, but `./lib/platform/files` starts with `./` while leaving the directory, and
// that is the same boundary crossing wearing a different prefix.
//
// Usage, from the repository root:
//
//   node scripts/check-module-boundaries.mjs
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { assertNodeVersion } from "./check-node-version.mjs";

/**
 * Layers that compose. `app/` is the composition root; `testing/` is a second one, because
 * injecting stub state into every feature's store is what the debug injectors are *for* — treating
 * it as shared would make its whole purpose a violation.
 */
const COMPOSING = new Set(["app", "testing"]);

/** Everything a feature is allowed to depend on. */
const SHARED = new Set(["components", "hooks", "lib", "models", "platform", "styles", "utils"]);

function layerOf(relative) {
  const [first, second] = relative.split("/");
  if (first === "features") return { kind: "feature", name: second };
  if (COMPOSING.has(first)) return { kind: "app", name: first };
  if (SHARED.has(first)) return { kind: "shared", name: first };
  return { kind: "root", name: first };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Specifiers, with the line each was written on.
 *
 * A regex is enough here and is not enough in `check-bundle-boundary.mjs`, and the difference is
 * worth knowing: that check must distinguish a type-only import (erased, so it never reaches the
 * bundle) from a runtime one. This check must not. Importing a type across a boundary couples the
 * two modules just as firmly, and is exactly how `api.ts` stayed alive inside a "dead" cluster.
 */
function specifiers(file) {
  const source = readFileSync(file, "utf8");
  const found = [];
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bvi\.(?:do)?mock\s*\(\s*['"]([^'"]+)['"]/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(0, match.index);
      found.push({ specifier: match[1], line: before.split("\n").length });
    }
  }
  return found;
}

export function checkModuleBoundaries() {
  const violations = [];

  for (const file of walk("src")) {
    const relative = path.relative("src", file).split(path.sep).join("/");
    // Tests may compose whatever a scenario needs — building one is composition, and a test is
    // allowed to be its own composition root. The structure is a claim about shipped code.
    const isTest = /\.test\.tsx?$/.test(relative);
    const from = layerOf(relative);

    for (const { specifier, line } of specifiers(file)) {
      const at = `src/${relative}:${line}`;

      if (specifier.startsWith(".") && specifier.slice(2).includes("/")) {
        violations.push(`${at} relative import leaves its directory: '${specifier}' — use '@/'`);
        continue;
      }
      if (!specifier.startsWith("@/")) continue;

      const to = layerOf(specifier.slice(2));
      if (isTest) continue;

      if (from.kind === "feature" && to.kind === "feature" && from.name !== to.name) {
        violations.push(`${at} feature '${from.name}' imports feature '${to.name}'`);
      }
      if (from.kind === "shared" && to.kind === "feature") {
        violations.push(`${at} shared '${from.name}/' imports feature '${to.name}'`);
      }
      if (from.kind === "shared" && to.kind === "app") {
        violations.push(`${at} shared '${from.name}/' imports '${to.name}/'`);
      }
      if (from.kind === "feature" && to.kind === "app") {
        violations.push(`${at} feature '${from.name}' imports '${to.name}/'`);
      }
    }
  }

  // A re-export-only module makes every consumer of one symbol look like a consumer of all of them,
  // which is precisely what check-bundle-boundary.mjs walks the graph to avoid.
  for (const file of walk("src")) {
    const relative = path.relative("src", file).split(path.sep).join("/");
    if (!/(^|\/)index\.tsx?$/.test(relative)) continue;
    if (relative.startsWith("components/ui/")) continue;
    const body = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    if (body.every((l) => /^\s*export\s+(\*|type\s*\{|\{)/.test(l) || /^\s*import\b/.test(l))) {
      violations.push(`src/${relative} is a barrel file — import the module directly`);
    }
  }

  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertNodeVersion();
  const violations = checkModuleBoundaries();
  if (violations.length > 0) {
    console.error(`module boundaries: ${violations.length} violation(s)\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      [
        "",
        "See PROJECT_STRUCTURE.md. Dependencies point one way: shared -> features -> app.",
        "Two features needing the same thing means it is shared — promote it, do not import sideways.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("module boundaries clean");
}
