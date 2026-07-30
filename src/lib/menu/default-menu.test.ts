import { describe, expect, it } from 'vitest'
import type { MenuItem } from '../../models/app-menu'
import type { MenuLabelsEvent } from '../../models/menu-labels'
import {
  buildDefaultMenu,
  type MenuPlatform,
} from './default-menu'

const baseParams: MenuLabelsEvent = {
  selectedShell: null,
  selectedExternalEditor: null,
  askForConfirmationOnForcePush: false,
  askForConfirmationOnRepositoryRemoval: false,
  gitHubRepositoryType: null,
}

function allItems(items: ReadonlyArray<MenuItem>): ReadonlyArray<MenuItem> {
  return items.flatMap(item =>
    item.type === 'submenuItem'
      ? [item, ...allItems(item.menu.items)]
      : [item]
  )
}

function labelById(items: ReadonlyArray<MenuItem>, id: string) {
  const item = items.find(candidate => candidate.id === id)
  return item?.type === 'separator' ? undefined : item?.label
}

function duplicateAccessKeys(
  items: ReadonlyArray<MenuItem>,
  duplicates: string[] = []
): ReadonlyArray<string> {
  const seen = new Set<string>()
  for (const item of items) {
    if (item.type === 'separator' || !item.visible) {
      continue
    }
    if (item.accessKey !== null) {
      const key = item.accessKey.toLowerCase()
      if (seen.has(key)) {
        duplicates.push(key)
      }
      seen.add(key)
    }
    if (item.type === 'submenuItem') {
      duplicateAccessKeys(item.menu.items, duplicates)
    }
  }
  return duplicates
}

describe.each<MenuPlatform>(['macos', 'windows', 'linux'])(
  '%s default menu',
  platform => {
    it('assigns a unique stable id to every item', () => {
      const first = allItems(buildDefaultMenu(baseParams, platform).items)
      const second = allItems(buildDefaultMenu(baseParams, platform).items)

      expect(new Set(first.map(item => item.id)).size).toBe(first.length)
      expect(second.map(item => item.id)).toEqual(first.map(item => item.id))
    })

    it('has no duplicate visible access keys in any state-derived label combination', () => {
      const variantKeys = [
        'isStashedChangesVisible',
        'isChangesFilterVisible',
        'hasCurrentPullRequest',
        'askForConfirmationOnRepositoryRemoval',
        'askForConfirmationWhenStashingAllChanges',
        'isForcePushForCurrentRepository',
        'askForConfirmationOnForcePush',
      ] as const

      for (let bits = 0; bits < 1 << variantKeys.length; bits++) {
        const variants = Object.fromEntries(
          variantKeys.map((key, index) => [
            key,
            Boolean(bits & (1 << index)),
          ])
        )
        const menu = buildDefaultMenu(
          { ...baseParams, ...variants },
          platform
        )
        expect(duplicateAccessKeys(menu.items)).toEqual([])
      }
    })
  }
)

describe('platform and state-derived menu structure', () => {
  it('keeps accelerators out of the frontend-owned structure', () => {
    const items = allItems(buildDefaultMenu(baseParams, 'linux').items)
    expect(items.every(item => !('accelerator' in item))).toBe(true)
  })

  it('preserves platform labels and actions', () => {
    const windows = buildDefaultMenu(baseParams, 'windows')
    const mac = buildDefaultMenu(baseParams, 'macos')

    expect(windows.items[0]).toMatchObject({ label: '&File' })
    expect(mac.items[0]).toMatchObject({ label: 'rdc' })

    const macItems = allItems(mac.items)
    expect(macItems.find(item => item.id === 'about')).toMatchObject({
      label: 'About rdc',
      action: { type: 'menu-event', event: 'show-about' },
    })
    expect(macItems.find(item => item.id === 'preferences')).toMatchObject({
      label: 'Settings…',
      action: { type: 'menu-event', event: 'show-preferences' },
    })
    expect(macItems.find(item => item.id === 'quit')).toMatchObject({
      role: 'quit',
    })
  })

  it('uses only rdc-owned Help destinations and product identity', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const items = allItems(buildDefaultMenu(baseParams, platform).items)
      const urls = items.flatMap(item =>
        item.type !== 'separator' &&
        item.type !== 'submenuItem' &&
        item.action?.type === 'open-external'
          ? [item.action.url]
          : []
      )

      expect(urls).toEqual([
        'https://github.com/jabelardo/rdc/issues/new',
        'https://github.com/jabelardo/rdc',
      ])
      expect(
        items.some(
          item =>
            item.type !== 'separator' &&
            item.label.includes('Keyboard Shortcuts')
        )
      ).toBe(false)
      if (platform !== 'macos') {
        expect(items.find(item => item.id === 'about')).toMatchObject({
          label: '&About rdc',
        })
      }
    }
  })

  it('truncates the contribution target and derives repository labels', () => {
    const menu = buildDefaultMenu(
      {
        ...baseParams,
        contributionTargetDefaultBranch: 'a-very-long-contribution-target-branch',
        gitHubRepositoryType: 'gitlab',
        isForcePushForCurrentRepository: true,
        askForConfirmationOnForcePush: true,
      },
      'linux'
    )
    const items = allItems(menu.items)

    expect(
      labelById(items, 'update-branch-with-contribution-target-branch')
    ).toBe('&Update from a-very-long-contribution-…')
    expect(items.find(item => item.id === 'push')).toMatchObject({
      label: 'Force P&ush…',
      action: { type: 'menu-event', event: 'force-push' },
    })
    expect(labelById(items, 'view-repository-on-github')).toBe(
      '&View on GitLab'
    )
  })
})
