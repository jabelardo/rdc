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

  it('applies the visual tokens and compact workspace breakpoint', async () => {
    const normal = await driver.executeScript(() => {
      const root = getComputedStyle(document.documentElement)
      const toolbar = getComputedStyle(
        document.querySelector('.repository-toolbar')
      )
      return {
        fontSize: root.fontSize,
        fontFamily: root.fontFamily,
        canvas: root.getPropertyValue('--color-canvas').trim(),
        toolbar: toolbar.backgroundColor,
      }
    })
    assert.equal(normal.fontSize, '13px')
    assert.match(normal.fontFamily, /system-ui/)
    assert.notEqual(normal.toolbar, normal.canvas)

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
      const compact = await driver.executeScript(() => ({
        shellColumns: getComputedStyle(
          document.querySelector('.application-shell')
        ).gridTemplateColumns.split(' ').length,
        workspaceColumns: getComputedStyle(
          document.querySelector('.changes-workspace')
        ).gridTemplateColumns.split(' ').length,
      }))
      assert.deepEqual(compact, { shellColumns: 1, workspaceColumns: 1 })
    } finally {
      await driver.manage().window().setRect(originalRect)
    }
  })
})
