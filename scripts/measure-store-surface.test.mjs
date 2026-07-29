import { describe, expect, test } from 'vitest'
import {
  invokedTauriCommands,
  routedIpcChannels,
  upstreamIpcChannels,
} from './measure-store-surface.mjs'

describe('Phase 3 surface measurement', () => {
  test('counts only literal calls to Tauri invoke, including an aliased import', () => {
    const commands = invokedTauriCommands([
      {
        file: 'wrapper.ts',
        source: `
          import { invoke as callTauri } from '@tauri-apps/api/core'
          const decoy = 'only-mentioned'
          // callTauri('only-commented')
          export const wrapped = () => callTauri<void>('actually-wrapped')
          callTauri(dynamicCommand)
        `,
      },
      {
        file: 'unrelated.ts',
        source: `
          const invoke = (name: string) => name
          invoke('not-tauri')
        `,
      },
    ])

    expect([...commands]).toEqual(['actually-wrapped'])
  })

  test('extracts only top-level channels from both upstream contract types', () => {
    const channels = upstreamIpcChannels(`
      export type RequestChannels = {
        'simplex-channel': () => void
        unquoted: (value: { nested: string }) => void
      }
      export type RequestResponseChannels = {
        'duplex-channel': () => Promise<void>
      }
    `)

    expect(channels).toEqual({
      request: ['simplex-channel', 'unquoted'],
      requestResponse: ['duplex-channel'],
      all: ['simplex-channel', 'unquoted', 'duplex-channel'],
    })
  })

  test('extracts routes with their direction, only from the upstream-channel section', () => {
    const routes = routedIpcChannels(`
      ### 7.1 Upstream channels, routed
      | Channel | Direction | Tauri mechanism | Phase |
      |---|---|---|---|
      | \`first\` | renderer→main | command | 4 |
      | \`second\` | request/response | no IPC | 4 |

      ### 7.2 Git commands (no upstream channel)
      | \`not-an-upstream-channel\` | request/response | command | done |
    `)

    // The direction comes back too, so a row can be checked against the type that declares the
    // channel rather than being trusted.
    expect(routes).toEqual([
      { channel: 'first', direction: 'renderer→main' },
      { channel: 'second', direction: 'request/response' },
    ])
  })
})
