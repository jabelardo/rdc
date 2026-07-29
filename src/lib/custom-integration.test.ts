import { describe, expect, it } from 'vitest'
import { migratedCustomIntegration } from './custom-integration'

describe('migratedCustomIntegration', () => {
  it('does nothing for an absent or already-current integration', () => {
    expect(migratedCustomIntegration(null)).toBeNull()
    expect(
      migratedCustomIntegration({
        path: '/usr/bin/code',
        arguments: '--wait "%TARGET_PATH%"',
      })
    ).toBeNull()
  })

  it('joins legacy argument arrays without changing the stored integration', () => {
    const legacy = {
      path: '/Applications/Custom.app',
      arguments: ['--wait', '"%TARGET_PATH%"'],
      bundleID: 'com.example.Custom',
    }

    expect(migratedCustomIntegration(legacy)).toEqual({
      path: '/Applications/Custom.app',
      arguments: '--wait "%TARGET_PATH%"',
      bundleID: 'com.example.Custom',
    })
    expect(legacy.arguments).toEqual(['--wait', '"%TARGET_PATH%"'])
  })

  it('migrates an empty legacy argument list to an empty string', () => {
    expect(
      migratedCustomIntegration({
        path: '/usr/bin/editor',
        arguments: [],
      })
    ).toEqual({
      path: '/usr/bin/editor',
      arguments: '',
    })
  })
})
