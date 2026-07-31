import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const GitEnvironment = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

function git(arguments_, cwd) {
  return execFileSync('git', arguments_, {
    cwd,
    env: GitEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function configureIdentity(repository) {
  git(['config', 'user.name', 'rdc Phase 8b QA'], repository)
  git(['config', 'user.email', 'rdc-phase8b@example.invalid'], repository)
}

/**
 * Create fresh local-only Git state for human QA without relying on the
 * developer's identity, default branch, network, or existing repositories.
 */
export function createPhase8bFixture(requestedTarget) {
  const target = path.resolve(requestedTarget)
  if (existsSync(target)) {
    throw new Error(`Refusing to replace existing fixture target: ${target}`)
  }
  mkdirSync(target, { recursive: true })

  const primary = path.join(target, 'primary')
  const remote = path.join(target, 'remote.git')
  const publisher = path.join(target, 'publisher')

  git(['init', '--bare', '--quiet', remote])
  git(['init', '--quiet', '--initial-branch=main', primary])
  configureIdentity(primary)
  writeFileSync(path.join(primary, 'modified.txt'), 'base line\n')
  writeFileSync(path.join(primary, 'stable.txt'), 'stable line\n')
  git(['add', '.'], primary)
  git(['commit', '--quiet', '-m', 'Initial QA state'], primary)
  git(['remote', 'add', 'origin', remote], primary)
  git(['push', '--quiet', '--set-upstream', 'origin', 'main'], primary)
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])

  git(['clone', '--quiet', remote, publisher])
  configureIdentity(publisher)
  writeFileSync(
    path.join(publisher, 'remote-ahead.txt'),
    'arrived from the fixture publisher\n'
  )
  git(['add', 'remote-ahead.txt'], publisher)
  git(['commit', '--quiet', '-m', 'Advance fixture remote'], publisher)
  git(['push', '--quiet', 'origin', 'main'], publisher)

  git(['fetch', '--quiet', 'origin'], primary)
  writeFileSync(
    path.join(primary, 'modified.txt'),
    'base line\nlocal modification\n'
  )
  writeFileSync(path.join(primary, 'untracked.txt'), 'untracked QA file\n')
  git(['branch', 'publish-me'], primary)

  const manifest = {
    target,
    primary,
    remote,
    publisher,
    initialBranch: 'main',
    unpublishedBranch: 'publish-me',
    expectedWorkingTreeFiles: ['modified.txt', 'untracked.txt'],
    expectedRemoteAhead: 1,
  }
  writeFileSync(
    path.join(target, 'fixture-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  return manifest
}

/**
 * pnpm 11 preserves the conventional `--` separator in a script's argv. Accept
 * both the documented `pnpm fixture:phase8b -- <target>` form and direct Node
 * invocation without ever mistaking the separator for a directory name.
 */
export function parsePhase8bFixtureTarget(arguments_) {
  const positionals = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  return positionals.length === 1 && positionals[0] !== ''
    ? positionals[0]
    : undefined
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const target = parsePhase8bFixtureTarget(process.argv.slice(2))
  if (target === undefined) {
    console.error(
      'Usage: node scripts/create-phase8b-fixture.mjs <new-target-directory>'
    )
    process.exitCode = 2
  } else {
    console.log(JSON.stringify(createPhase8bFixture(target), null, 2))
  }
}
