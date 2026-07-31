// Visual layer: the shared typography/colour tokens and the compact workspace breakpoint.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
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
    writeFileSync(
      path.join(fixture.canonical, 'gate-c-layout.txt'),
      'Gate C layout fixture\n'
    )
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
      const selectedView = document.querySelector(
        '.repository-view-navigation [aria-current="page"]'
      )
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
        selectedView: selectedView.getAttribute('aria-label'),
        selectedViewHasTreatment:
          getComputedStyle(selectedView).backgroundColor !==
          'rgba(0, 0, 0, 0)',
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
    assert.equal(normal.toolbarButtons, 9)
    assert.equal(normal.selectedView, 'Changes')
    assert.equal(normal.selectedViewHasTreatment, true)

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
          const viewLabels = [
            ...document.querySelectorAll('.repository-view-label'),
          ]
          return {
            shellColumns:
              getComputedStyle(shell).gridTemplateColumns.split(' ').length,
            workspaceColumns: getComputedStyle(
              document.querySelector('.changes-workspace')
            ).gridTemplateColumns.split(' ').length,
            toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth,
            viewLabelsHidden: viewLabels.every(
              label => getComputedStyle(label).display === 'none'
            ),
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
          workspaceColumns: 2,
          toolbarFits: true,
          viewLabelsHidden: true,
        },
        collapsed: {
          shellColumns: 2,
          workspaceColumns: 2,
          toolbarFits: true,
          viewLabelsHidden: true,
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

  it('keeps every Changes region bounded and reachable at compact width', async () => {
    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({ width: 620, height: 600 })
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => matchMedia('(max-width: 52rem)').matches
          ),
        5_000,
        'compact Changes breakpoint did not activate'
      )
      const layout = await driver.executeScript(() => {
        const workspace = document.querySelector('.changes-workspace')
        const files = document.querySelector('.working-tree')
        const diff = document.querySelector('.working-tree-diff')
        const commit = document.querySelector('.commit-form')
        const workspaceRect = workspace.getBoundingClientRect()
        const regions = [files, diff, commit].map(element => {
          const rect = element.getBoundingClientRect()
          return {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          }
        })
        return {
          workspaceOwnsOverflow:
            getComputedStyle(workspace).overflowY === 'hidden',
          workspaceFits: workspace.scrollHeight <= workspace.clientHeight,
          regionsFit: regions.every(
            rect =>
              rect.top >= workspaceRect.top - 1 &&
              rect.right <= workspaceRect.right + 1 &&
              rect.bottom <= workspaceRect.bottom + 1 &&
              rect.left >= workspaceRect.left - 1
          ),
          filesStayLeftOfDiff: regions[0].right <= regions[1].left + 1,
          commitStaysLeftOfDiff: regions[2].right <= regions[1].left + 1,
          commitStaysBelowFiles: regions[0].bottom <= regions[2].top + 1,
          filesScrollIndependently:
            getComputedStyle(files.querySelector('.virtual-list-viewport'))
              .overflowY === 'auto',
          diffScrollsIndependently:
            getComputedStyle(diff.querySelector('.working-tree-diff-content'))
              .overflowY === 'auto',
          commitPresent: commit !== null,
        }
      })
      assert.deepEqual(layout, {
        workspaceOwnsOverflow: true,
        workspaceFits: true,
        regionsFit: true,
        filesStayLeftOfDiff: true,
        commitStaysLeftOfDiff: true,
        commitStaysBelowFiles: true,
        filesScrollIndependently: true,
        diffScrollsIndependently: true,
        commitPresent: true,
      })
    } finally {
      await driver.manage().window().setRect(originalRect)
    }
  })

  it('keeps History side by side with independently bounded regions', async () => {
    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({ width: 620, height: 600 })
      await driver.executeScript(() =>
        document
          .querySelector('.repository-view-navigation [aria-label="History"]')
          .click()
      )
      await driver.wait(
        async () =>
          await driver.executeScript(() => {
            const history = document.querySelector('.history')
            return history !== null && !history.hidden
          }),
        5_000,
        'History did not become visible'
      )
      await driver.wait(
        async () =>
          await driver.executeScript(
            () =>
              document.querySelector(
                '.history-files [aria-current="true"]'
              ) !== null &&
              document.querySelector('.history-diff-content') !== null
          ),
        5_000,
        'History details did not finish loading'
      )

      const snapshot = () =>
        driver.executeScript(() => {
          const history = document.querySelector('.history')
          const commits = history.querySelector('.history-list-pane')
          const details = history.querySelector('.history-details')
          const metadata = history.querySelector('.history-details-header')
          const fileSection = history.querySelector('.history-file-section')
          const files = history.querySelector('.history-files')
          const diffRegion = history.querySelector('.history-diff')
          const diff = history.querySelector('.history-diff-content')
          const selectedCommit = history.querySelector(
            '.history-commits [aria-current="true"]'
          )
          const selectedFile = history.querySelector(
            '.history-files [aria-current="true"]'
          )
          const historyRect = history.getBoundingClientRect()
          const commitRect = commits.getBoundingClientRect()
          const detailsRect = details.getBoundingClientRect()
          const regionFits = element => {
            const rect = element.getBoundingClientRect()
            return (
              rect.top >= historyRect.top - 1 &&
              rect.right <= historyRect.right + 1 &&
              rect.bottom <= historyRect.bottom + 1 &&
              rect.left >= historyRect.left - 1
            )
          }

          return {
            columns: getComputedStyle(history).gridTemplateColumns.split(' ')
              .length,
            historyOwnsOverflow:
              getComputedStyle(history).overflowY === 'hidden',
            historyFits: history.scrollHeight <= history.clientHeight,
            listStaysLeftOfDetails: commitRect.right <= detailsRect.left + 1,
            filesStayLeftOfDiff:
              fileSection.getBoundingClientRect().right <=
              diffRegion.getBoundingClientRect().left + 1,
            regionsFit: [
              commits,
              details,
              metadata,
              fileSection,
              files,
              diffRegion,
              diff,
            ].every(regionFits),
            commitListScrollsIndependently:
              getComputedStyle(commits).overflowY === 'auto',
            fileListScrollsIndependently:
              getComputedStyle(files).overflowY === 'auto',
            diffScrollsIndependently:
              getComputedStyle(diff).overflowY === 'auto',
            selectedCommit: selectedCommit?.getAttribute('data-commit-sha'),
            selectedFile: selectedFile?.getAttribute('aria-label'),
          }
        })

      const beforeSwitch = await snapshot()
      assert.deepEqual(
        {
          columns: beforeSwitch.columns,
          historyOwnsOverflow: beforeSwitch.historyOwnsOverflow,
          historyFits: beforeSwitch.historyFits,
          listStaysLeftOfDetails: beforeSwitch.listStaysLeftOfDetails,
          filesStayLeftOfDiff: beforeSwitch.filesStayLeftOfDiff,
          regionsFit: beforeSwitch.regionsFit,
          commitListScrollsIndependently:
            beforeSwitch.commitListScrollsIndependently,
          fileListScrollsIndependently:
            beforeSwitch.fileListScrollsIndependently,
          diffScrollsIndependently: beforeSwitch.diffScrollsIndependently,
        },
        {
          columns: 2,
          historyOwnsOverflow: true,
          historyFits: true,
          listStaysLeftOfDetails: true,
          filesStayLeftOfDiff: true,
          regionsFit: true,
          commitListScrollsIndependently: true,
          fileListScrollsIndependently: true,
          diffScrollsIndependently: true,
        }
      )
      assert.ok(beforeSwitch.selectedCommit)
      assert.ok(beforeSwitch.selectedFile)

      await driver.executeScript(() =>
        document
          .querySelector('.repository-view-navigation [aria-label="Changes"]')
          .click()
      )
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => !document.querySelector('.changes-workspace').hidden
          ),
        5_000,
        'Changes did not become visible'
      )
      await driver.executeScript(() =>
        document
          .querySelector('.repository-view-navigation [aria-label="History"]')
          .click()
      )
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => !document.querySelector('.history').hidden
          ),
        5_000,
        'History did not become visible after switching back'
      )
      await driver.wait(
        async () =>
          await driver.executeScript(
            () =>
              document.querySelector(
                '.history-files [aria-current="true"]'
              ) !== null &&
              document.querySelector('.history-diff-content') !== null
          ),
        5_000,
        'History details did not restore after switching back'
      )
      const afterSwitch = await snapshot()
      assert.equal(afterSwitch.selectedCommit, beforeSwitch.selectedCommit)
      assert.equal(afterSwitch.selectedFile, beforeSwitch.selectedFile)
    } finally {
      await driver.executeScript(() =>
        document
          .querySelector('.repository-view-navigation [aria-label="Changes"]')
          .click()
      )
      await driver.manage().window().setRect(originalRect)
    }
  })

  it('gives one sidebar panel the remaining height without hiding sibling headers', async () => {
    const snapshot = () =>
      driver.executeScript(() => {
        const panels = document.querySelector('.sidebar-panels')
        const repositoriesHeading = document.querySelector(
          '#sidebar-repositories-heading'
        )
        const branchesHeading = document.querySelector(
          '#sidebar-branches-heading'
        )
        const repositories = document.querySelector('#sidebar-repositories')
        const branches = document.querySelector('#sidebar-branches')
        const panelsRect = panels.getBoundingClientRect()
        const repositoriesHeadingRect =
          repositoriesHeading.getBoundingClientRect()
        const branchesHeadingRect = branchesHeading.getBoundingClientRect()
        return {
          repositoriesExpanded:
            repositoriesHeading.getAttribute('aria-expanded') === 'true',
          branchesExpanded:
            branchesHeading.getAttribute('aria-expanded') === 'true',
          repositoriesRegionPresent: repositories !== null,
          branchesRegionPresent: branches !== null,
          repositoriesHeadingVisible:
            repositoriesHeadingRect.top >= panelsRect.top &&
            repositoriesHeadingRect.bottom <= panelsRect.bottom,
          branchesHeadingVisible:
            branchesHeadingRect.top >= panelsRect.top &&
            branchesHeadingRect.bottom <= panelsRect.bottom,
          expandedRegionHeight:
            (repositories ?? branches)?.getBoundingClientRect().height ?? 0,
        }
      })

    const repositories = await snapshot()
    assert.deepEqual(
      {
        repositoriesExpanded: repositories.repositoriesExpanded,
        branchesExpanded: repositories.branchesExpanded,
        repositoriesRegionPresent: repositories.repositoriesRegionPresent,
        branchesRegionPresent: repositories.branchesRegionPresent,
        repositoriesHeadingVisible: repositories.repositoriesHeadingVisible,
        branchesHeadingVisible: repositories.branchesHeadingVisible,
      },
      {
        repositoriesExpanded: true,
        branchesExpanded: false,
        repositoriesRegionPresent: true,
        branchesRegionPresent: false,
        repositoriesHeadingVisible: true,
        branchesHeadingVisible: true,
      }
    )
    assert.ok(
      repositories.expandedRegionHeight > 100,
      'the repository panel did not receive the available sidebar height'
    )

    await driver.executeScript(() =>
      document.querySelector('#sidebar-branches-heading').click()
    )
    const branches = await snapshot()
    assert.deepEqual(
      {
        repositoriesExpanded: branches.repositoriesExpanded,
        branchesExpanded: branches.branchesExpanded,
        repositoriesRegionPresent: branches.repositoriesRegionPresent,
        branchesRegionPresent: branches.branchesRegionPresent,
        repositoriesHeadingVisible: branches.repositoriesHeadingVisible,
        branchesHeadingVisible: branches.branchesHeadingVisible,
      },
      {
        repositoriesExpanded: false,
        branchesExpanded: true,
        repositoriesRegionPresent: false,
        branchesRegionPresent: true,
        repositoriesHeadingVisible: true,
        branchesHeadingVisible: true,
      }
    )
    assert.ok(
      branches.expandedRegionHeight > 100,
      'the branch panel did not receive the available sidebar height'
    )

    // Leave the shared application session in its default state for future
    // visual checks added to this file.
    await driver.executeScript(() =>
      document.querySelector('#sidebar-repositories-heading').click()
    )
  })
})
