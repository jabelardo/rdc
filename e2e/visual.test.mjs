// Visual layer: the shared typography/colour tokens and the compact workspace breakpoint.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { By, Key } from 'selenium-webdriver'
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
        tooltipDelayMs: (() => {
          const value = toolbar.getPropertyValue('--tooltip-delay').trim()
          return value.endsWith('ms')
            ? Number.parseFloat(value)
            : Number.parseFloat(value) * 1_000
        })(),
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
          getComputedStyle(selectedView).backgroundColor !== 'rgba(0, 0, 0, 0)',
      }
    })
    assert.equal(normal.fontSize, '13px')
    assert.match(normal.fontFamily, /system-ui/)
    assert.notEqual(normal.toolbar, normal.canvas)
    assert.equal(normal.tooltipDelayMs, 250)
    assert.equal(normal.toolbar, normal.sidebar)
    assert.equal(normal.toolbarHeight, normal.sidebarCommandBarHeight)
    assert.equal(normal.seamHeight, normal.collapseButtonHeight)
    assert.equal(normal.seamHeight, normal.remoteControlsHeight)
    assert.equal(normal.seamWidth, 1)
    assert.notEqual(normal.seamColor, 'rgba(0, 0, 0, 0)')
    assert.equal(normal.toolbarButtons, 11)
    assert.equal(normal.selectedView, 'Changes')
    assert.equal(normal.selectedViewHasTreatment, true)

    const newRepositoryButton = await driver.findElement(
      By.css('.repository-toolbar [aria-label="New repository"]')
    )
    await driver.executeScript(element => element.focus(), newRepositoryButton)
    await driver.wait(
      async () =>
        await driver.executeScript(() => {
          const tooltip = document.querySelector('.app-tooltip')
          return tooltip !== null && getComputedStyle(tooltip).opacity === '1'
        }),
      2_000,
      'the shared tooltip did not appear after its configured delay'
    )
    const toolbarTooltip = await driver.executeScript(() => {
      const tooltip = document.querySelector('.app-tooltip')
      const toolbar = document.querySelector('.repository-toolbar')
      const expectedSurface = document.createElement('span')
      expectedSurface.style.background = 'var(--color-surface-raised)'
      document.body.append(expectedSurface)
      const snapshot = {
        label: tooltip.textContent,
        background: getComputedStyle(tooltip).backgroundColor,
        expectedBackground: getComputedStyle(expectedSurface).backgroundColor,
        zIndex: Number.parseInt(getComputedStyle(tooltip).zIndex, 10),
        top: tooltip.getBoundingClientRect().top,
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
      }
      expectedSurface.remove()
      return snapshot
    })
    assert.equal(toolbarTooltip.label, 'New repository')
    assert.equal(toolbarTooltip.background, toolbarTooltip.expectedBackground)
    assert.ok(toolbarTooltip.zIndex >= 10_000)
    assert.ok(toolbarTooltip.top >= toolbarTooltip.toolbarBottom)

    const collapseButton = await driver.findElement(By.css('.sidebar-collapse'))
    await driver.executeScript(element => element.focus(), collapseButton)
    await driver.wait(
      async () =>
        (await driver.findElement(By.css('.app-tooltip')).getText()) ===
        'Collapse sidebar',
      2_000,
      'the sidebar did not use the shared tooltip layer'
    )
    await driver.executeScript(element => element.blur(), collapseButton)

    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({ width: 600, height: 300 })
      const minimumRect = await driver.manage().window().getRect()
      assert.ok(
        minimumRect.width >= 715,
        'window width escaped its 715px floor'
      )
      assert.ok(
        minimumRect.height >= 356,
        'window height escaped its 356px floor'
      )
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => matchMedia('(max-width: 46rem)').matches
          ),
        5_000,
        'compact workspace breakpoint did not activate'
      )
      const compactSnapshot = async () =>
        await driver.executeScript(() => {
          const shell = document.querySelector('.application-shell')
          const toolbar = document.querySelector('.repository-toolbar')
          const sidebarResizer = document.querySelector('.sidebar-resizer')
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
            sidebarResizerLabel: sidebarResizer.getAttribute('aria-label'),
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
          sidebarResizerLabel: 'Resize navigation sidebar',
          viewLabelsHidden: true,
        },
        collapsed: {
          shellColumns: 2,
          workspaceColumns: 2,
          toolbarFits: true,
          sidebarResizerLabel: 'Expand navigation sidebar',
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

  it('keeps compact controls and file statuses visually semantic in Dark', async () => {
    await driver.executeScript(() => {
      document.documentElement.dataset.theme = 'dark'
      const branches = document.querySelector(
        '[aria-controls="sidebar-branches"]'
      )
      if (branches?.getAttribute('aria-expanded') !== 'true') {
        branches?.click()
      }
    })
    await driver.wait(
      async () =>
        await driver.executeScript(
          () => document.querySelector('.new-branch-button') !== null
        ),
      5_000,
      'the Branches panel did not expose its compact actions'
    )

    const snapshot = await driver.executeScript(() => {
      const styles = selector =>
        getComputedStyle(document.querySelector(selector))
      const resolveColor = value => {
        const probe = document.createElement('span')
        probe.style.color = value
        document.body.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }
      const transparent = 'rgba(0, 0, 0, 0)'
      const status = document.querySelector('.working-tree-file-status')
      const statusStyles = getComputedStyle(status)
      return {
        transparent,
        toolbarButton: styles(
          '.repository-toolbar [aria-label="New repository"]'
        ).backgroundColor,
        collapseButton: styles('.sidebar-collapse').backgroundColor,
        newBranchButton: styles('.new-branch-button').backgroundColor,
        newBranchIcon: document
          .querySelector('.new-branch-button svg')
          ?.getAttribute('data-icon'),
        currentBranch: styles('.branch-list-selection[aria-current="true"]')
          .backgroundColor,
        statusKind: [...status.classList].find(name =>
          name.startsWith('status-')
        ),
        statusColor: statusStyles.color,
        semanticSuccess: resolveColor('var(--color-success)'),
        semanticDanger: resolveColor('var(--color-danger)'),
        discardBackground: styles('.discard-selected-lines').backgroundColor,
        discardColor: styles('.discard-selected-lines').color,
      }
    })
    assert.equal(snapshot.toolbarButton, snapshot.transparent)
    assert.equal(snapshot.collapseButton, snapshot.transparent)
    assert.equal(snapshot.newBranchButton, snapshot.transparent)
    assert.equal(snapshot.newBranchIcon, 'arrows-split-up-and-left')
    assert.notEqual(snapshot.currentBranch, snapshot.transparent)
    assert.match(snapshot.statusKind, /^status-(new|untracked|copied)$/)
    assert.equal(snapshot.statusColor, snapshot.semanticSuccess)
    assert.equal(snapshot.discardBackground, snapshot.transparent)
    assert.equal(snapshot.discardColor, snapshot.semanticDanger)

    await driver.executeScript(() =>
      document
        .querySelector('.repository-view-navigation [aria-label="History"]')
        .click()
    )
    await driver.wait(
      async () =>
        await driver.executeScript(
          () => document.querySelector('.history-file-status') !== null
        ),
      5_000,
      'History did not expose its shared semantic file-status icon'
    )
    const historyStatus = await driver.executeScript(() => {
      const status = document.querySelector('.history-file-status')
      const probe = document.createElement('span')
      probe.style.color = 'var(--color-success)'
      document.body.append(probe)
      const snapshot = {
        kind: [...status.classList].find(name => name.startsWith('status-')),
        color: getComputedStyle(status).color,
        semanticSuccess: getComputedStyle(probe).color,
      }
      probe.remove()
      return snapshot
    })
    assert.equal(historyStatus.kind, 'status-new')
    assert.equal(historyStatus.color, historyStatus.semanticSuccess)

    await driver.executeScript(() => {
      document
        .querySelector('.repository-view-navigation [aria-label="Changes"]')
        .click()
      const repositories = document.querySelector(
        '[aria-controls="sidebar-repositories"]'
      )
      if (repositories?.getAttribute('aria-expanded') !== 'true') {
        repositories?.click()
      }
      delete document.documentElement.dataset.theme
    })
  })

  it('keeps every Changes region bounded and reachable at compact width', async () => {
    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({ width: 715, height: 356 })
      await driver.wait(
        async () =>
          await driver.executeScript(
            () => matchMedia('(max-width: 46rem)').matches
          ),
        5_000,
        'compact Changes breakpoint did not activate'
      )
      const layout = await driver.executeScript(() => {
        const workspace = document.querySelector('.changes-workspace')
        const sidebar = document.querySelector('.repository-sidebar')
        const files = document.querySelector('.working-tree')
        const diff = document.querySelector('.working-tree-diff')
        const commit = document.querySelector('.commit-form')
        const separators = [
          ...document.querySelectorAll('.horizontal-resizer'),
        ].filter(separator => separator.getBoundingClientRect().height > 0)
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
          sidebarMeetsMinimum: sidebar.getBoundingClientRect().width >= 125 - 1,
          filesMeetMinimum: regions[0].right - regions[0].left >= 190 - 1,
          diffMeetsMinimum: regions[1].right - regions[1].left >= 300 - 1,
          resizersPresent: separators.length === 2,
          resizersUseColumnCursor: separators.every(
            separator => getComputedStyle(separator).cursor === 'col-resize'
          ),
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
        sidebarMeetsMinimum: true,
        filesMeetMinimum: true,
        diffMeetsMinimum: true,
        resizersPresent: true,
        resizersUseColumnCursor: true,
      })
    } finally {
      await driver.manage().window().setRect(originalRect)
    }
  })

  it('keeps History side by side with independently bounded regions', async () => {
    const originalRect = await driver.manage().window().getRect()
    try {
      await driver.manage().window().setRect({ width: 715, height: 356 })
      const sidebarWidthBeforeViewSwitch = await driver.executeScript(
        () =>
          document.querySelector('.repository-sidebar').getBoundingClientRect()
            .width
      )
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
              document.querySelector('.history-files [aria-current="true"]') !==
                null && document.querySelector('.history-diff-content') !== null
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
          const separators = [
            ...document.querySelectorAll('.horizontal-resizer'),
          ].filter(separator => separator.getBoundingClientRect().height > 0)
          const historyRect = history.getBoundingClientRect()
          const commitRect = commits.getBoundingClientRect()
          const detailsRect = details.getBoundingClientRect()
          const fileSectionRect = fileSection.getBoundingClientRect()
          const diffRegionRect = diffRegion.getBoundingClientRect()
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
            columns:
              getComputedStyle(history).gridTemplateColumns.split(' ').length,
            historyOwnsOverflow:
              getComputedStyle(history).overflowY === 'hidden',
            historyFits: history.scrollHeight <= history.clientHeight,
            listStaysLeftOfDetails: commitRect.right <= detailsRect.left + 1,
            filesStayLeftOfDiff:
              fileSectionRect.right <= diffRegionRect.left + 1,
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
            commitListMeetsMinimum: commitRect.width >= 190 - 1,
            changedFilesMeetMinimum: fileSectionRect.width >= 150 - 1,
            diffMeetsMinimum: diffRegionRect.width >= 220 - 1,
            resizersPresent: separators.length === 3,
            resizersUseColumnCursor: separators.every(
              separator => getComputedStyle(separator).cursor === 'col-resize'
            ),
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
          commitListMeetsMinimum: beforeSwitch.commitListMeetsMinimum,
          changedFilesMeetMinimum: beforeSwitch.changedFilesMeetMinimum,
          diffMeetsMinimum: beforeSwitch.diffMeetsMinimum,
          resizersPresent: beforeSwitch.resizersPresent,
          resizersUseColumnCursor: beforeSwitch.resizersUseColumnCursor,
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
          commitListMeetsMinimum: true,
          changedFilesMeetMinimum: true,
          diffMeetsMinimum: true,
          resizersPresent: true,
          resizersUseColumnCursor: true,
        }
      )
      assert.ok(beforeSwitch.selectedCommit)
      assert.ok(beforeSwitch.selectedFile)
      const sidebarWidthAfterViewSwitch = await driver.executeScript(
        () =>
          document.querySelector('.repository-sidebar').getBoundingClientRect()
            .width
      )
      assert.ok(
        Math.abs(sidebarWidthAfterViewSwitch - sidebarWidthBeforeViewSwitch) <=
          1,
        'sidebar width changed while switching from Changes to History'
      )

      // Exercise the application wiring as well as the shared resizer's unit contract. The wider
      // window gives both History seams room to move; returning to the native floor below proves
      // their remembered values are clamped by the layout rather than forcing horizontal overflow.
      await driver.manage().window().setRect({ width: 900, height: 356 })
      const commitListResizer = await driver.findElement(
        By.css('[aria-label="Resize History commit list"]')
      )
      await commitListResizer.sendKeys(Key.HOME, Key.ARROW_RIGHT)
      const changedFilesResizer = await driver.findElement(
        By.css('[aria-label="Resize History changed files"]')
      )
      await changedFilesResizer.sendKeys(Key.HOME, Key.ARROW_RIGHT)
      const resizedWidths = await driver.executeScript(() => ({
        commits: document
          .querySelector('.history-list-pane')
          .getBoundingClientRect().width,
        files: document
          .querySelector('.history-file-section')
          .getBoundingClientRect().width,
      }))
      assert.ok(Math.abs(resizedWidths.commits - 200) <= 1)
      assert.ok(Math.abs(resizedWidths.files - 160) <= 1)
      await driver.manage().window().setRect({ width: 715, height: 356 })

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
              document.querySelector('.history-files [aria-current="true"]') !==
                null && document.querySelector('.history-diff-content') !== null
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

  it('keeps the settled frames stable through continuous resize and restore', async () => {
    const originalRect = await driver.manage().window().getRect()
    const widths = [1100, 900, 740, 736, 730, 715, 730, 736, 740, 900, 1100]

    const selectView = async view => {
      await driver.executeScript(selectedView => {
        document
          .querySelector(
            `.repository-view-navigation [aria-label="${selectedView}"]`
          )
          .click()
      }, view)
      await driver.wait(
        async () =>
          await driver.executeScript(selectedView => {
            const selector =
              selectedView === 'Changes' ? '.changes-workspace' : '.history'
            const workspace = document.querySelector(selector)
            return workspace !== null && !workspace.hidden
          }, view),
        5_000,
        `${view} did not become visible during the resize loop`
      )
    }

    const setSidebarCollapsed = async collapsed => {
      const needsToggle = await driver.executeScript(
        expected =>
          document
            .querySelector('.application-shell')
            .classList.contains('sidebar-collapsed') !== expected,
        collapsed
      )
      if (needsToggle) {
        await driver.executeScript(() =>
          document.querySelector('.sidebar-collapse').click()
        )
      }
      await driver.wait(
        async () =>
          await driver.executeScript(
            expected =>
              document
                .querySelector('.application-shell')
                .classList.contains('sidebar-collapsed') === expected,
            collapsed
          ),
        5_000,
        `sidebar did not become ${collapsed ? 'collapsed' : 'expanded'}`
      )
    }

    const snapshot = () =>
      driver.executeScript(() => {
        const shell = document.querySelector('.application-shell')
        const dragRegion = document.querySelector('.window-drag-region')
        const toolbar = document.querySelector('.repository-toolbar')
        const selectedView = document
          .querySelector('.repository-view-navigation [aria-current="page"]')
          .getAttribute('aria-label')
        const workspace =
          selectedView === 'Changes'
            ? document.querySelector('.changes-workspace')
            : document.querySelector('.history')
        const shellRect = shell.getBoundingClientRect()
        const toolbarRect = toolbar.getBoundingClientRect()
        const workspaceRect = workspace.getBoundingClientRect()
        const visibleToolbarButtons = [...toolbar.querySelectorAll('button')]
          .filter(button => getComputedStyle(button).display !== 'none')
          .map(button => button.getBoundingClientRect())

        const common = {
          selectedView,
          documentFits:
            document.documentElement.scrollWidth <= window.innerWidth &&
            document.documentElement.scrollHeight <= window.innerHeight &&
            document.body.scrollWidth <= window.innerWidth &&
            document.body.scrollHeight <= window.innerHeight,
          shellFitsViewport:
            shellRect.left >= -1 &&
            shellRect.top >= -1 &&
            shellRect.right <= window.innerWidth + 1 &&
            shellRect.bottom <= window.innerHeight + 1,
          toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth,
          toolbarButtonsReachable: visibleToolbarButtons.every(
            rect =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.left >= toolbarRect.left - 1 &&
              rect.right <= toolbarRect.right + 1 &&
              rect.top >= toolbarRect.top - 1 &&
              rect.bottom <= toolbarRect.bottom + 1
          ),
          workspaceStartsBelowToolbar:
            Math.abs(workspaceRect.top - toolbarRect.bottom) <= 1,
          dragRegionFits:
            dragRegion === null ||
            (dragRegion.getBoundingClientRect().left >= -1 &&
              dragRegion.getBoundingClientRect().right <=
                window.innerWidth + 1),
        }

        if (selectedView === 'Changes') {
          const files = workspace.querySelector('.working-tree')
          const diff = workspace.querySelector('.working-tree-diff')
          const commit = workspace.querySelector('.commit-form')
          const filesRect = files.getBoundingClientRect()
          const diffRect = diff.getBoundingClientRect()
          const commitRect = commit.getBoundingClientRect()
          return {
            ...common,
            paneDirectionStable:
              filesRect.right <= diffRect.left + 1 &&
              commitRect.right <= diffRect.left + 1 &&
              filesRect.bottom <= commitRect.top + 1,
            workspaceFits:
              workspace.scrollWidth <= workspace.clientWidth &&
              workspace.scrollHeight <= workspace.clientHeight,
            paneMinimumsHold:
              filesRect.width >= 190 - 1 && diffRect.width >= 300 - 1,
            selectedCommit: null,
            selectedFile: workspace
              .querySelector('.working-tree-files [aria-current="true"]')
              ?.closest('[data-changed-file-path]')
              ?.getAttribute('data-changed-file-path'),
          }
        }

        const commits = workspace.querySelector('.history-list-pane')
        const details = workspace.querySelector('.history-details')
        const files = workspace.querySelector('.history-file-section')
        const diff = workspace.querySelector('.history-diff')
        const commitsRect = commits.getBoundingClientRect()
        const filesRect = files.getBoundingClientRect()
        const diffRect = diff.getBoundingClientRect()
        return {
          ...common,
          paneDirectionStable:
            commits.getBoundingClientRect().right <=
              details.getBoundingClientRect().left + 1 &&
            files.getBoundingClientRect().right <=
              diff.getBoundingClientRect().left + 1,
          workspaceFits:
            workspace.scrollWidth <= workspace.clientWidth &&
            workspace.scrollHeight <= workspace.clientHeight,
          paneMinimumsHold:
            commitsRect.width >= 190 - 1 &&
            filesRect.width >= 150 - 1 &&
            diffRect.width >= 220 - 1,
          selectedCommit: workspace
            .querySelector('.history-commits [aria-current="true"]')
            ?.getAttribute('data-commit-sha'),
          selectedFile: workspace
            .querySelector('.history-files [aria-current="true"]')
            ?.getAttribute('aria-label'),
        }
      })

    try {
      const selections = new Map()
      for (const view of ['Changes', 'History']) {
        await selectView(view)
        if (view === 'Changes') {
          const hasSelection = await driver.executeScript(
            () =>
              document.querySelector(
                '.working-tree-files [aria-current="true"]'
              ) !== null
          )
          if (!hasSelection) {
            await driver.executeScript(() =>
              document.querySelector('.working-tree-file-selection').click()
            )
          }
          await driver.wait(
            async () =>
              await driver.executeScript(
                () =>
                  document.querySelector(
                    '.working-tree-files [aria-current="true"]'
                  ) !== null
              ),
            5_000,
            'Changes selection did not load before the resize loop'
          )
        } else {
          await driver.wait(
            async () =>
              await driver.executeScript(
                () =>
                  document.querySelector(
                    '.history-files [aria-current="true"]'
                  ) !== null
              ),
            5_000,
            'History selection did not load before the resize loop'
          )
        }

        for (const collapsed of [false, true]) {
          await setSidebarCollapsed(collapsed)
          for (const width of widths) {
            await driver.manage().window().setRect({ width, height: 720 })
            const state = await snapshot()
            assert.deepEqual(
              {
                documentFits: state.documentFits,
                shellFitsViewport: state.shellFitsViewport,
                toolbarFits: state.toolbarFits,
                toolbarButtonsReachable: state.toolbarButtonsReachable,
                workspaceStartsBelowToolbar: state.workspaceStartsBelowToolbar,
                dragRegionFits: state.dragRegionFits,
                paneDirectionStable: state.paneDirectionStable,
                workspaceFits: state.workspaceFits,
                paneMinimumsHold: state.paneMinimumsHold,
              },
              {
                documentFits: true,
                shellFitsViewport: true,
                toolbarFits: true,
                toolbarButtonsReachable: true,
                workspaceStartsBelowToolbar: true,
                dragRegionFits: true,
                paneDirectionStable: true,
                workspaceFits: true,
                paneMinimumsHold: true,
              },
              `${view}, sidebar ${collapsed ? 'collapsed' : 'expanded'}, ${width}px`
            )

            const selectionKey = `${view}-${collapsed}`
            const currentSelection = `${state.selectedCommit ?? ''}|${
              state.selectedFile ?? ''
            }`
            if (selections.has(selectionKey)) {
              assert.equal(
                currentSelection,
                selections.get(selectionKey),
                `${view} selection changed while resizing at ${width}px`
              )
            } else {
              assert.notEqual(
                currentSelection,
                '|',
                `${view} had no selection before resizing`
              )
              selections.set(selectionKey, currentSelection)
            }
          }
        }
      }

      await driver.manage().window().maximize()
      const maximized = await snapshot()
      assert.equal(maximized.documentFits, true)
      assert.equal(maximized.paneDirectionStable, true)

      await driver.manage().window().setRect({ width: 800, height: 600 })
      const restored = await snapshot()
      assert.equal(restored.documentFits, true)
      assert.equal(restored.paneDirectionStable, true)
      assert.equal(
        `${restored.selectedCommit ?? ''}|${restored.selectedFile ?? ''}`,
        selections.get('History-true'),
        'History selection changed through maximize and restore'
      )
    } finally {
      await selectView('Changes')
      await setSidebarCollapsed(false)
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
