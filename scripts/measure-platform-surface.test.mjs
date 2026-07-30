import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  PHASE_4B_PROXY_EXPORTS,
  PHASE_4B_SUBSCRIPTIONS,
  exportedValues,
  isSubscriptionImplemented,
  routedChannelPhases,
  subscribedChannels,
} from './measure-platform-surface.mjs'

describe('measure-platform-surface', () => {
  it('pins the independent Phase 4b surface', () => {
    assert.equal(PHASE_4B_PROXY_EXPORTS.size, 19)
    assert.equal(PHASE_4B_SUBSCRIPTIONS.size, 8)
    assert.equal(PHASE_4B_PROXY_EXPORTS.has('openRepositoryInNewWindow'), false)
    assert.equal(PHASE_4B_SUBSCRIPTIONS.has('app-menu'), false)
  })

  it('reads exported runtime values without counting types', () => {
    const names = exportedValues(
      'module.ts',
      `
        export type Shape = { value: string }
        export interface Contract { value: string }
        export const first = 1, second = 2
        export function run() {}
        export class Service {}
        export enum Mode { One }
        const local = 3
      `
    )

    assert.deepEqual(names, ['first', 'second', 'run', 'Service', 'Mode'])
  })

  it('finds literal subscriptions through aliased namespace imports only', () => {
    const channels = subscribedChannels([
      {
        file: 'one.ts',
        source: `
          import * as renderer from './ipc-renderer'
          renderer.on('focus', () => {})
          renderer.on(\`blur\`, () => {})
          unrelated.on('not-a-channel', () => {})
        `,
      },
      {
        file: 'two.ts',
        source: `
          import * as ipcRenderer from '../lib/ipc-renderer'
          ipcRenderer.on('focus', () => {})
        `,
      },
    ])

    assert.deepEqual([...channels].sort(), ['blur', 'focus'])
  })

  it('reads the phase from routed channel rows and rejects duplicates', () => {
    const map = `
### 7.1 Upstream channels, routed
| Channel | Direction | Tauri mechanism | Phase |
|---|---|---|---|
| \`focus\` | main→renderer | frontend listener | 4 |
| \`certificate-error\` | main→renderer | design work | 5 |
### 7.2 Git commands
`
    assert.deepEqual([...routedChannelPhases(map)], [
      ['focus', 4],
      ['certificate-error', 5],
    ])

    assert.throws(
      () =>
        routedChannelPhases(
          map.replace(
            '### 7.2 Git commands',
            '| `focus` | main→renderer | duplicate | 4 |\n### 7.2 Git commands'
          )
        ),
      /routed more than once/
    )
  })

  it('maps raw Electron subscription channels to typed platform adapters', () => {
    const exports = new Set([
      'ApplicationMenuController',
      'onNativeMenuAction',
      'onWindowFocusChanged',
      'onWindowStateChanged',
      'onWindowZoomFactorChanged',
    ])
    const commands = new Set()

    assert.equal(isSubscriptionImplemented('focus', exports, commands), true)
    assert.equal(isSubscriptionImplemented('blur', exports, commands), true)
    assert.equal(isSubscriptionImplemented('menu-event', exports, commands), true)
    assert.equal(isSubscriptionImplemented('app-menu', exports, commands), true)
    assert.equal(
      isSubscriptionImplemented('window-state-changed', exports, commands),
      true
    )
    assert.equal(
      isSubscriptionImplemented('zoom-factor-changed', exports, commands),
      true
    )
    assert.equal(isSubscriptionImplemented('url-action', exports, commands), false)
  })
})
