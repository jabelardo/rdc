import { describe, expect, it, vi } from 'vitest'
import { AppMenu, type IMenu } from '../../models/app-menu'
import type { Keybinding, MenuKeybindings } from '../../models/keybinding'
import {
  findMenuItemForKeybinding,
  friendlyKeybindingText,
  installKeybindingDispatcher,
  matchesKeybinding,
} from './keybindings'

function keyboardEvent(
  code: string,
  modifiers: Partial<
    Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>
  > = {}
) {
  return {
    code,
    key: code === 'KeyQ' ? 'a' : code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

const binding: Keybinding = {
  modifiers: ['control', 'shift'],
  key: 'KeyQ',
}

describe('structured keybinding matching', () => {
  it('matches physical code and every modifier exactly', () => {
    expect(
      matchesKeybinding(
        keyboardEvent('KeyQ', { ctrlKey: true, shiftKey: true }),
        binding
      )
    ).toBe(true)
    expect(
      matchesKeybinding(
        keyboardEvent('KeyQ', {
          altKey: true,
          ctrlKey: true,
          shiftKey: true,
        }),
        binding
      )
    ).toBe(false)
    expect(
      matchesKeybinding(
        keyboardEvent('KeyA', { ctrlKey: true, shiftKey: true }),
        binding
      )
    ).toBe(false)
  })

  it('uses code rather than the layout-dependent key value', () => {
    const event = keyboardEvent('KeyQ', { ctrlKey: true, shiftKey: true })
    expect(event.key).toBe('a')
    expect(matchesKeybinding(event, binding)).toBe(true)
  })

  it('returns only executable, enabled, visible menu items', () => {
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
        {
          id: 'push',
          type: 'menuItem',
          label: 'Push',
          enabled: false,
          visible: true,
          accessKey: null,
          action: { type: 'menu-event', event: 'push' },
        },
      ],
    }
    const bindings: MenuKeybindings = {
      pull: binding,
      push: { modifiers: ['control'], key: 'KeyP' },
    }
    const appMenu = AppMenu.fromMenu(menu)

    expect(
      findMenuItemForKeybinding(
        keyboardEvent('KeyQ', { ctrlKey: true, shiftKey: true }),
        appMenu,
        bindings
      )?.id
    ).toBe('pull')
    expect(
      findMenuItemForKeybinding(
        keyboardEvent('KeyP', { ctrlKey: true }),
        appMenu,
        bindings
      )
    ).toBeUndefined()
  })

  it('installs a capture-phase dispatcher and returns its cleanup', () => {
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
    const appMenu = AppMenu.fromMenu(menu)
    const bindings: MenuKeybindings = { pull: binding }
    const execute = vi.fn()
    const cleanup = installKeybindingDispatcher(
      window,
      () => ({ menu: appMenu, bindings }),
      execute
    )
    const first = new KeyboardEvent('keydown', {
      code: 'KeyQ',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    })

    window.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pull' })
    )

    cleanup()
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'KeyQ',
        ctrlKey: true,
        shiftKey: true,
      })
    )
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('friendly keybinding text', () => {
  it('renders platform modifier names from structured data', () => {
    expect(friendlyKeybindingText(binding, 'windows')).toBe('Ctrl+Shift+Q')
    expect(
      friendlyKeybindingText(
        { modifiers: ['alt', 'meta'], key: 'KeyI' },
        'macos'
      )
    ).toBe('⌥⌘I')
  })

  it('renders physical punctuation and named keys', () => {
    expect(
      friendlyKeybindingText({ modifiers: ['control'], key: 'Comma' }, 'linux')
    ).toBe('Ctrl+,')
    expect(
      friendlyKeybindingText({ modifiers: ['meta'], key: 'Backspace' }, 'macos')
    ).toBe('⌘⌫')
  })
})
