import { describe, expect, it } from 'vitest'
import snapshot from '../__generated__/wire-snapshot.json'
import type { IMenu } from '../../models/app-menu'
import type { SerializableContextMenuItem } from '../../models/context-menu'

describe('native application menu wire contract', () => {
  it('matches the Rust serializer for frontend-owned menu data', () => {
    const menu: IMenu = {
      type: 'menu',
      items: [
        {
          id: 'pull',
          type: 'menuItem',
          label: 'Pull',
          enabled: true,
          visible: true,
          accessKey: null,
          action: { type: 'menu-event', event: 'pull' },
        },
      ],
    }

    expect(snapshot.appMenu).toEqual(menu)
  })

  it('matches the Rust serializer for contextual menu input', () => {
    const menu: ReadonlyArray<SerializableContextMenuItem> = [
      {
        label: 'Parent',
        submenu: [
          {
            label: 'Chosen',
            type: 'checkbox',
            checked: true,
            enabled: false,
          },
        ],
      },
      { type: 'separator' },
    ]

    expect(snapshot.contextMenu).toEqual(menu)
  })
})
