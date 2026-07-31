// Visual layer: the shared typography/colour tokens and the compact workspace breakpoint.
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  commitWorkingTreeBaseline,
  createFixtureRoot,
  initCanonicalRepository,
  openSeededRepository,
  removeFixtureRoot,
  startApplication,
} from './harness.mjs'

describe('visual layout', () => {
  let driver
  let fixture

  before(async () => {
    fixture = createFixtureRoot()
    initCanonicalRepository(fixture)
    commitWorkingTreeBaseline(fixture)
    driver = await startApplication()
    // The toolbar and workspace grids only exist once a repository is selected.
    await openSeededRepository(driver, fixture.canonical)
  })

  after(async () => {
    await driver?.quit().catch(() => undefined)
    removeFixtureRoot(fixture)
  })

  it('keeps the repository command bar aligned and usable at compact width', async () => {
    const normal = await driver.executeScript(() => {
      const root = getComputedStyle(document.documentElement)
      const toolbarElement = document.querySelector('.repository-toolbar')
      const sidebar = document.querySelector('.repository-sidebar')
      const sidebarCommandBar = document.querySelector('.sidebar-command-bar')
      const collapseButton = document.querySelector('.sidebar-collapse')
      const remoteControls = document.querySelector('.remote-controls')
      const toolbar = getComputedStyle(toolbarElement)
      const seam = getComputedStyle(toolbarElement, '::before')
      return {
        fontSize: root.fontSize,
        fontFamily: root.fontFamily,
        canvas: root.getPropertyValue('--color-canvas').trim(),
        toolbar: toolbar.backgroundColor,
        sidebar: getComputedStyle(sidebar).backgroundColor,
        toolbarHeight: toolbarElement.getBoundingClientRect().height,
        sidebarCommandBarHeight:
          sidebarCommandBar.getBoundingClientRect().height,
        collapseButtonHeight: collapseButton.getBoundingClientRect().height,
        remoteControlsHeight: remoteControls.getBoundingClientRect().height,
        seamHeight: Number.parseFloat(seam.height),
        seamWidth: Number.parseFloat(seam.width),
        seamColor: seam.backgroundColor,
        toolbarButtons: toolbarElement.querySelectorAll('button').length,
      }
    })
    assert.equal(normal.fontSize, '13px')
    assert.match(normal.fontFamily, /system-ui/)
    assert.notEqual(normal.toolbar, normal.canvas)
    assert.equal(normal.toolbar, normal.sidebar)
    assert.equal(normal.toolbarHeight, normal.sidebarCommandBarHeight)
    assert.equal(normal.seamHeight, normal.collapseButtonHeight)
    assert.equal(normal.seamHeight, normal.remoteControlsHeight)
    assert.equal(normal.seamWidth, 1)
    assert.notEqual(normal.seamColor, 'rgba(0, 0, 0, 0)')
    assert.equal(normal.toolbarButtons, 7)

    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({ width: 620, height: 720 })
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => matchMedia('(max-width: 52rem)').matches
          ),
        5_000,
        'compact workspace breakpoint did not activate'
      )
      const compactSnapshot = async () =>
        await driver.executeScript(() => {
          const shell = document.querySelector('.application-shell')
          const toolbar = document.querySelector('.repository-toolbar')
          return {
            shellColumns:
              getComputedStyle(shell).gridTemplateColumns.split(' ').length,
            workspaceColumns: getComputedStyle(
              document.querySelector('.changes-workspace')
            ).gridTemplateColumns.split(' ').length,
            toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth,
          }
        })
      const expanded = await compactSnapshot()
      await driver.executeScript(() =>
        document.querySelector('.sidebar-collapse').click()
      )
      await driver.wait(
        async () =>
          await driver.executeScript(() =>
            document
              .querySelector('.application-shell')
              .classList.contains('sidebar-collapsed')
          ),
        5_000,
        'sidebar did not collapse'
      )
      const collapsed = await compactSnapshot()
      const compact = { expanded, collapsed }
      assert.deepEqual(compact, {
        expanded: {
          shellColumns: 2,
          workspaceColumns: 1,
          toolbarFits: true,
        },
        collapsed: {
          shellColumns: 2,
          workspaceColumns: 1,
          toolbarFits: true,
        },
      })
    } finally {
      await driver.executeScript(() => {
        const shell = document.querySelector('.application-shell')
        if (shell.classList.contains('sidebar-collapsed')) {
          document.querySelector('.sidebar-collapse').click()
        }
      })
      await driver.manage().window().setRect(originalRect)
    }
  })
})
