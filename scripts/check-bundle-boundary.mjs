// Fails if any module that actually reaches the browser bundle imports a Node builtin.
//
// `MIGRATION_MAP.md` §8 records legacy `url.parse()` (8 sites) and Node `path` in
// `lib/repository-matching.ts` as carried debt that "must be settled before entering the app
// bundle". That sentence is the whole safeguard, and a sentence cannot fail a build. Today the
// boundary genuinely holds — every module carrying that debt is post-MVP (GitHub API, accounts,
// deep links, PAC parsing) and none is reachable from `src/main.tsx`. This makes that a checked
// fact, so the deferral stays deliberate instead of becoming an accident the day a Phase 5b or
// Phase 9 slice wires one of them into the UI.
//
// Type-only imports are skipped, and that distinction is the reason this uses the TypeScript AST
// rather than a regex: `import type { IAPIEmail } from './api'` is erased at build time and does
// not pull `api.ts` into the bundle, while `import { getHTMLURL } from './api'` does. A regex
// cannot tell those apart and would report the boundary as broken when it is intact.
//
// Usage, from the repository root:
//
//   node scripts/check-bundle-boundary.mjs
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { assertNodeVersion } from './check-node-version.mjs'

const ENTRY = 'src/main.tsx'

/**
 * Node builtins a webview cannot provide. `url` and `path` are the two this repository actually
 * carries debt for; the rest are here so a new one is caught the first time it appears.
 */
const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'zlib',
])

function isNodeBuiltin(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  return NODE_BUILTINS.has(bare)
}

/**
 * Resolve a relative specifier the way the bundler will.
 *
 * Each candidate must be a *file*: `./lib/stores` names a real directory, so an `existsSync` check
 * alone matches the directory itself and the caller then tries to read it.
 */
function resolveRelative(fromFile, specifier) {
  const base = path.join(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]
  return candidates.find(candidate => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Every import in a file that survives to runtime.
 *
 * Uses TypeScript's own emit as the oracle rather than reading the AST directly, because the
 * distinction that matters here is not "was `type` written" but "does this import survive
 * erasure". `models/owner.ts` has a plain `import { GitHubAccountType } from '../lib/api'` whose
 * binding is a `type` alias used only in a type position: TypeScript drops the import entirely, so
 * `api.ts` never reaches the bundle. An AST-only check reports that as a violation — verified, it
 * did — and the false positive is worse than no check, because the honest answer is that the
 * boundary holds.
 *
 * @param {string} file
 * @returns {Array<{specifier: string, line: number}>}
 */
function runtimeImports(file) {
  const source = readFileSync(file, 'utf8')
  const emitted = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.Preserve,
      verbatimModuleSyntax: false,
    },
  }).outputText

  const specifiers = new Set()
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of emitted.matchAll(pattern)) {
      specifiers.add(match[1])
    }
  }

  // Line numbers come from the original source, since the emitted text's lines mean nothing to a
  // reader. Falls back to line 1 for a specifier written differently than it is emitted.
  const lines = source.split('\n')
  return [...specifiers].map(specifier => {
    const index = lines.findIndex(
      line => line.includes(`'${specifier}'`) || line.includes(`"${specifier}"`)
    )
    return { specifier, line: index === -1 ? 1 : index + 1 }
  })
}

/** Walk the runtime import graph from the entry point. */
function collectViolations() {
  const seen = new Set()
  const stack = [ENTRY]
  const violations = []

  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) {
      continue
    }
    seen.add(file)

    for (const { specifier, line } of runtimeImports(file)) {
      if (isNodeBuiltin(specifier)) {
        violations.push({ file, line, specifier })
        continue
      }
      if (!specifier.startsWith('.')) {
        continue
      }
      const resolved = resolveRelative(file, specifier)
      if (resolved !== undefined) {
        stack.push(resolved)
      }
    }
  }

  return { violations, moduleCount: seen.size }
}

export function checkBundleBoundary() {
  if (!existsSync(ENTRY)) {
    throw new Error(
      `entry point ${ENTRY} not found; run from the repository root`
    )
  }
  return collectViolations()
}

const invokedDirectly = (() => {
  if (process.argv[1] === undefined) {
    return false
  }
  try {
    // Realpaths, for the same reason as check-node-version.mjs: Node realpaths the entry specifier
    // before setting `import.meta.url`, so a symlinked checkout would otherwise skip the check.
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  assertNodeVersion()
  const { violations, moduleCount } = checkBundleBoundary()

  if (violations.length > 0) {
    console.error(
      `\n${violations.length} module(s) reachable from ${ENTRY} import a Node builtin, which a webview cannot provide:\n`
    )
    for (const { file, line, specifier } of violations) {
      console.error(`  ${file}:${line} imports '${specifier}'`)
    }
    console.error(
      [
        '',
        'Either keep the module out of the bundle, or settle its Node dependency first —',
        'legacy `url.parse()` becomes WHATWG `URL`, Node `path` becomes browser-safe string work.',
        'See MIGRATION_MAP.md §8 and REMAINING.md.',
        '',
      ].join('\n')
    )
    process.exit(1)
  }

  console.log(
    `bundle boundary clean: ${moduleCount} modules reachable from ${ENTRY}, none importing a Node builtin`
  )
}
