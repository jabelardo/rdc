import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  createPhase8bFixture,
  parsePhase8bFixtureTarget,
} from './create-phase8b-fixture.mjs'

test('accepts pnpm and direct invocation without treating -- as the target', () => {
  assert.equal(
    parsePhase8bFixtureTarget(['--', '/tmp/rdc-phase8b-qa']),
    '/tmp/rdc-phase8b-qa'
  )
  assert.equal(
    parsePhase8bFixtureTarget(['/tmp/rdc-phase8b-qa']),
    '/tmp/rdc-phase8b-qa'
  )
  assert.equal(parsePhase8bFixtureTarget(['--']), undefined)
  assert.equal(parsePhase8bFixtureTarget(['one', 'two']), undefined)
})

test('creates a deterministic local, remote, and publisher QA topology', () => {
  const root = mkdtempSync('/tmp/rdc-phase8b-fixture-test-')
  const target = path.join(root, 'fixture')
  try {
    const manifest = createPhase8bFixture(target)

    assert.equal(manifest.primary, path.join(target, 'primary'))
    assert.equal(manifest.remote, path.join(target, 'remote.git'))
    assert.equal(manifest.publisher, path.join(target, 'publisher'))
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          manifest.primary,
          'branch',
          '--show-current',
        ])
      ).trim(),
      'main'
    )
    assert.match(
      String(
        execFileSync('git', ['-C', manifest.primary, 'status', '--short'])
      ),
      /modified\.txt.*untracked\.txt/s
    )
    assert.equal(
      String(
        execFileSync('git', [
          '-C',
          manifest.primary,
          'rev-list',
          '--count',
          'HEAD..origin/main',
        ])
      ).trim(),
      '1'
    )
    assert.equal(
      JSON.parse(
        readFileSync(path.join(target, 'fixture-manifest.json'), 'utf8')
      ).primary,
      manifest.primary
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
