import { useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowsSplitUpAndLeft,
  faChevronLeft,
  faChevronRight,
  faCodeBranch,
  faFolderTree,
  faMagnifyingGlass,
  faPlus,
  faXmark,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { BranchType, type Branch } from '../../../models/branch'
import type { Repository } from '../../../models/repository'
import type { AppStoreState } from '../../stores/app-store'
import type { BranchState, BranchStore } from '../../stores/branch-store'
import type { ConflictState } from '../../stores/conflict-store'
import { BranchListRow, RepositoryListRow } from '../mvp-list-rows'
import {
  MvpSidebarCapabilities,
  type SidebarSectionID,
  visibleSidebarSections,
} from '../sidebar-sections'
import { VirtualList } from '../virtual-list'
import { Tooltip } from '../tooltip'

const mvpSidebarSections = visibleSidebarSections(MvpSidebarCapabilities)
type BranchGroup = 'default' | 'recent' | 'other'
type BranchListEntry = {
  readonly branch: Branch
  readonly group: BranchGroup
}
const branchGroupLabels: Readonly<Record<BranchGroup, string>> = {
  default: 'Default Branch',
  recent: 'Recent Branches',
  other: 'Other Branches',
}
const sidebarIcons: Readonly<Record<SidebarSectionID, IconDefinition | null>> =
  {
    repositories: faFolderTree,
    branches: faCodeBranch,
    tags: null,
    stashes: null,
    submodules: null,
    subtrees: null,
  }

type RepositorySidebarProps = {
  readonly collapsed: boolean
  readonly expandedSections: ReadonlySet<SidebarSectionID>
  readonly appState: AppStoreState
  readonly branchState: BranchState
  readonly branchStore: BranchStore
  readonly conflictState: ConflictState
  readonly newBranchName: string
  readonly onToggleCollapsed: () => void
  readonly onToggleSection: (section: SidebarSectionID) => void
  readonly onActivateSection: (section: SidebarSectionID) => void
  readonly onSelectRepository: (repository: Repository) => void
  readonly onRepositoryContextMenu: (repository: Repository) => void
  readonly onBranchNameChange: (name: string) => void
  readonly onBranchChange: (operation: () => Promise<boolean>) => Promise<void>
}

/** Repository navigation and branch controls, independent of the active workspace view. */
export function RepositorySidebar({
  collapsed,
  expandedSections,
  appState,
  branchState,
  branchStore,
  conflictState,
  newBranchName,
  onToggleCollapsed,
  onToggleSection,
  onActivateSection,
  onSelectRepository,
  onRepositoryContextMenu,
  onBranchNameChange,
  onBranchChange,
}: RepositorySidebarProps) {
  const [repositoryFilter, setRepositoryFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('')
  const [showBranchCreation, setShowBranchCreation] = useState(false)
  const filteredRepositories = useMemo(() => {
    const query = repositoryFilter.trim().toLocaleLowerCase()
    if (query === '') {
      return appState.repositories
    }
    return appState.repositories.filter(repository =>
      `${repository.name}\n${repository.path}`
        .toLocaleLowerCase()
        .includes(query)
    )
  }, [appState.repositories, repositoryFilter])
  const branchListEntries = useMemo(() => {
    const query = branchFilter.trim().toLocaleLowerCase()
    const localBranches = branchState.branches.filter(
      branch => branch.type === BranchType.Local
    )
    const byName = new Map(localBranches.map(branch => [branch.name, branch]))
    const assigned = new Set<string>()
    const entries = new Array<BranchListEntry>()
    const defaultBranch =
      branchState.defaultBranch === null
        ? undefined
        : byName.get(branchState.defaultBranch)
    if (defaultBranch !== undefined) {
      entries.push({ branch: defaultBranch, group: 'default' })
      assigned.add(defaultBranch.name)
    }
    for (const name of branchState.recentBranches) {
      const branch = byName.get(name)
      if (branch !== undefined && !assigned.has(branch.name)) {
        entries.push({ branch, group: 'recent' })
        assigned.add(branch.name)
      }
    }
    for (const branch of localBranches
      .filter(branch => !assigned.has(branch.name))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      entries.push({ branch, group: 'other' })
    }
    return entries.filter(entry =>
      entry.branch.name.toLocaleLowerCase().includes(query)
    )
  }, [
    branchFilter,
    branchState.branches,
    branchState.defaultBranch,
    branchState.recentBranches,
  ])
  const filteredBranches = branchListEntries.map(entry => entry.branch)
  const branchActionsDisabled =
    branchState.operation !== null || conflictState.mergeInProgress

  const activateSection = (section: SidebarSectionID) => {
    onActivateSection(section)
    requestAnimationFrame(() => {
      document.getElementById(`sidebar-${section}-heading`)?.focus()
    })
  }

  return (
    <aside
      className={`repository-sidebar box-border grid min-w-0 bg-[var(--color-surface-subtle)]${
        collapsed ? ' repository-sidebar-collapsed' : ''
      }`}
      aria-label="Navigation"
    >
      <div className="sidebar-command-bar flex items-center border-b border-[var(--color-border)]">
        <Tooltip label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <button
            type="button"
            className="sidebar-collapse"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            <FontAwesomeIcon
              icon={collapsed ? faChevronRight : faChevronLeft}
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      </div>
      {collapsed ? (
        <nav className="sidebar-icon-rail" aria-label="Navigation sections">
          {mvpSidebarSections.map(section => {
            const icon = sidebarIcons[section.id]
            const value =
              section.id === 'repositories'
                ? (appState.selectedRepository?.name ??
                  'No repository selected')
                : (branchState.currentBranch ?? 'No branch selected')
            const description = `${section.label}: ${value}`
            return (
              <Tooltip label={description} key={section.id}>
                <button
                  type="button"
                  aria-label={description}
                  onClick={() => activateSection(section.id)}
                >
                  {icon !== null && (
                    <FontAwesomeIcon icon={icon} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            )
          })}
        </nav>
      ) : (
        <div className="sidebar-panels flex flex-col">
          {mvpSidebarSections.map(section => {
            const expanded = expandedSections.has(section.id)
            const icon = sidebarIcons[section.id]
            return (
              <section
                className={`sidebar-panel sidebar-panel-${section.id} min-w-0${
                  expanded ? ' sidebar-panel-expanded' : ''
                }${
                  section.id === 'repositories'
                    ? ''
                    : ' border-t border-[var(--color-border)]'
                }`}
                key={section.id}
              >
                <h2>
                  <button
                    id={`sidebar-${section.id}-heading`}
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`sidebar-${section.id}`}
                    onClick={() => onToggleSection(section.id)}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    {icon !== null && (
                      <FontAwesomeIcon icon={icon} aria-hidden="true" />
                    )}
                    {section.label}
                  </button>
                </h2>
                {expanded && (
                  <div
                    id={`sidebar-${section.id}`}
                    className="sidebar-panel-content"
                    role="region"
                    aria-label={section.label}
                  >
                    {section.id === 'repositories' &&
                      (appState.repositories.length === 0 ? (
                        <p className="repository-list-empty">
                          No repositories yet.
                        </p>
                      ) : (
                        <div className="repositories-panel-content">
                          <label className="repository-filter">
                            <span className="sr-only">Filter repositories</span>
                            <FontAwesomeIcon
                              icon={faMagnifyingGlass}
                              aria-hidden="true"
                            />
                            <input
                              type="search"
                              aria-label="Filter repositories"
                              placeholder="Filter repositories"
                              value={repositoryFilter}
                              onChange={event =>
                                setRepositoryFilter(event.currentTarget.value)
                              }
                            />
                          </label>
                          {filteredRepositories.length === 0 ? (
                            <p className="repository-list-empty">
                              No matching repositories.
                            </p>
                          ) : (
                            <VirtualList
                              items={filteredRepositories}
                              className="repository-list"
                              ariaLabel="Repositories"
                              estimateSize={() => 36}
                              gap={1}
                              getItemKey={repository => repository.id}
                            >
                              {(repository, index, row) => (
                                <RepositoryListRow
                                  index={index}
                                  repositories={filteredRepositories}
                                  repository={repository}
                                  row={row}
                                  selectedRepository={
                                    appState.selectedRepository
                                  }
                                  onContextMenu={onRepositoryContextMenu}
                                  onSelect={onSelectRepository}
                                />
                              )}
                            </VirtualList>
                          )}
                        </div>
                      ))}
                    {section.id === 'branches' &&
                      (appState.selectedRepository === null ? (
                        <p className="sidebar-panel-empty">
                          Select a repository to view branches.
                        </p>
                      ) : (
                        <div className="branches-panel-content">
                          {branchState.loading ? (
                            <p>Loading branches…</p>
                          ) : branchState.error !== null ? (
                            <p className="application-error" role="alert">
                              {branchState.error}
                            </p>
                          ) : (
                            <>
                              <div className="branch-filter-actions">
                                <label className="branch-filter">
                                  <span className="sr-only">
                                    Filter branches
                                  </span>
                                  <FontAwesomeIcon
                                    icon={faMagnifyingGlass}
                                    aria-hidden="true"
                                  />
                                  <input
                                    type="search"
                                    aria-label="Filter branches"
                                    placeholder="Filter branches"
                                    value={branchFilter}
                                    onChange={event =>
                                      setBranchFilter(event.currentTarget.value)
                                    }
                                  />
                                </label>
                                <Tooltip label="Create and check out a new branch">
                                  <button
                                    type="button"
                                    className="new-branch-button"
                                    aria-label="New branch"
                                    aria-expanded={showBranchCreation}
                                    aria-controls="new-branch-form"
                                    disabled={branchActionsDisabled}
                                    onClick={() => {
                                      setShowBranchCreation(true)
                                      requestAnimationFrame(() =>
                                        document
                                          .getElementById('new-branch-name')
                                          ?.focus()
                                      )
                                    }}
                                  >
                                    <FontAwesomeIcon
                                      icon={faArrowsSplitUpAndLeft}
                                      aria-hidden="true"
                                    />
                                  </button>
                                </Tooltip>
                              </div>
                              {showBranchCreation && (
                                <form
                                  id="new-branch-form"
                                  className="new-branch-form"
                                  aria-label="Create branch"
                                  onSubmit={event => {
                                    event.preventDefault()
                                    void onBranchChange(() =>
                                      branchStore.createAndCheckout(
                                        newBranchName
                                      )
                                    ).then(() => {
                                      if (
                                        branchStore.state.operationError ===
                                        null
                                      ) {
                                        onBranchNameChange('')
                                        setShowBranchCreation(false)
                                      }
                                    })
                                  }}
                                >
                                  <label htmlFor="new-branch-name">
                                    New branch name
                                  </label>
                                  <input
                                    id="new-branch-name"
                                    placeholder="New branch name"
                                    value={newBranchName}
                                    disabled={branchActionsDisabled}
                                    onKeyDown={event => {
                                      if (event.key === 'Escape') {
                                        setShowBranchCreation(false)
                                      }
                                    }}
                                    onChange={event =>
                                      onBranchNameChange(
                                        event.currentTarget.value
                                      )
                                    }
                                  />
                                  <Tooltip label="Create and check out branch">
                                    <button
                                      type="submit"
                                      aria-label="Create branch"
                                      disabled={branchActionsDisabled}
                                    >
                                      <FontAwesomeIcon
                                        icon={faPlus}
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </Tooltip>
                                  <Tooltip label="Cancel creating branch">
                                    <button
                                      type="button"
                                      aria-label="Cancel creating branch"
                                      onClick={() =>
                                        setShowBranchCreation(false)
                                      }
                                    >
                                      <FontAwesomeIcon
                                        icon={faXmark}
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </Tooltip>
                                </form>
                              )}
                              {branchListEntries.length === 0 ? (
                                <p className="branch-list-empty">
                                  {branchState.branches.every(
                                    branch => branch.type !== BranchType.Local
                                  )
                                    ? 'No branches found.'
                                    : 'No matching branches.'}
                                </p>
                              ) : (
                                <VirtualList
                                  items={branchListEntries}
                                  className="branch-list"
                                  ariaLabel="Branches"
                                  estimateSize={() => 36}
                                  gap={1}
                                  getItemKey={entry => entry.branch.ref}
                                >
                                  {(entry, index, row) => (
                                    <BranchListRow
                                      branch={entry.branch}
                                      branches={filteredBranches}
                                      currentBranch={branchState.currentBranch}
                                      groupLabel={
                                        index === 0
                                          ? branchGroupLabels[entry.group]
                                          : branchListEntries[index - 1]
                                                .group !== entry.group
                                            ? branchGroupLabels[entry.group]
                                            : undefined
                                      }
                                      index={index}
                                      operationDisabled={branchActionsDisabled}
                                      row={row}
                                      onSelect={branch =>
                                        void onBranchChange(() =>
                                          branchStore.checkout(branch.name)
                                        )
                                      }
                                    />
                                  )}
                                </VirtualList>
                              )}
                            </>
                          )}
                          {branchState.progress !== null && (
                            <p role="status">
                              {branchState.progress.description}
                            </p>
                          )}
                          {branchState.operationError !== null && (
                            <p className="application-error" role="alert">
                              {branchState.operationError}
                            </p>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </aside>
  )
}
