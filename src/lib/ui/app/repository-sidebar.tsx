import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronLeft,
  faChevronRight,
  faCodeBranch,
  faFolderTree,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { BranchType } from '../../../models/branch'
import type { Repository } from '../../../models/repository'
import type { AppStoreState } from '../../stores/app-store'
import type { BranchState, BranchStore } from '../../stores/branch-store'
import type { ConflictState } from '../../stores/conflict-store'
import { RepositoryListRow } from '../mvp-list-rows'
import {
  MvpSidebarCapabilities,
  type SidebarSectionID,
  visibleSidebarSections,
} from '../sidebar-sections'
import { VirtualList } from '../virtual-list'

const mvpSidebarSections = visibleSidebarSections(MvpSidebarCapabilities)
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
        <button
          type="button"
          className="sidebar-collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <FontAwesomeIcon
            icon={collapsed ? faChevronRight : faChevronLeft}
            aria-hidden="true"
          />
        </button>
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
              <button
                type="button"
                key={section.id}
                aria-label={description}
                title={description}
                onClick={() => activateSection(section.id)}
              >
                {icon !== null && (
                  <FontAwesomeIcon icon={icon} aria-hidden="true" />
                )}
              </button>
            )
          })}
        </nav>
      ) : (
        <div className="sidebar-panels grid gap-2">
          {mvpSidebarSections.map(section => {
            const expanded = expandedSections.has(section.id)
            const icon = sidebarIcons[section.id]
            return (
              <section
                className={`sidebar-panel min-w-0${
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
                    role="region"
                    aria-label={section.label}
                  >
                    {section.id === 'repositories' &&
                      (appState.repositories.length === 0 ? (
                        <p className="repository-list-empty">
                          No repositories yet.
                        </p>
                      ) : (
                        <VirtualList
                          items={appState.repositories}
                          className="repository-list"
                          ariaLabel="Repositories"
                          estimateSize={() => 56}
                          gap={5}
                          getItemKey={repository => repository.id}
                        >
                          {(repository, index, row) => (
                            <RepositoryListRow
                              index={index}
                              repositories={appState.repositories}
                              repository={repository}
                              row={row}
                              selectedRepository={appState.selectedRepository}
                              onContextMenu={onRepositoryContextMenu}
                              onSelect={onSelectRepository}
                            />
                          )}
                        </VirtualList>
                      ))}
                    {section.id === 'branches' &&
                      (appState.selectedRepository === null ? (
                        <p className="sidebar-panel-empty">
                          Select a repository to view branches.
                        </p>
                      ) : (
                        <div className="branch-controls">
                          {branchState.loading ? (
                            <p>Loading branches…</p>
                          ) : branchState.error !== null ? (
                            <p className="application-error" role="alert">
                              {branchState.error}
                            </p>
                          ) : (
                            <label>
                              Current branch
                              <select
                                aria-label="Current branch"
                                value={branchState.currentBranch ?? ''}
                                disabled={
                                  branchState.operation !== null ||
                                  conflictState.mergeInProgress
                                }
                                onChange={event =>
                                  void onBranchChange(() =>
                                    branchStore.checkout(
                                      event.currentTarget.value
                                    )
                                  )
                                }
                              >
                                {branchState.currentBranch === null && (
                                  <option value="">
                                    Detached or unborn HEAD
                                  </option>
                                )}
                                {branchState.branches.map(branch => (
                                  <option
                                    key={branch.ref}
                                    value={branch.name}
                                    disabled={branch.type === BranchType.Remote}
                                  >
                                    {branch.name}
                                    {branch.type === BranchType.Remote
                                      ? ' (remote)'
                                      : ''}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <form
                            aria-label="Create branch"
                            onSubmit={event => {
                              event.preventDefault()
                              void onBranchChange(() =>
                                branchStore.createAndCheckout(newBranchName)
                              ).then(() => {
                                if (branchStore.state.operationError === null) {
                                  onBranchNameChange('')
                                }
                              })
                            }}
                          >
                            <label htmlFor="new-branch-name">
                              New branch name
                            </label>
                            <input
                              id="new-branch-name"
                              value={newBranchName}
                              disabled={
                                branchState.operation !== null ||
                                conflictState.mergeInProgress
                              }
                              onChange={event =>
                                onBranchNameChange(event.currentTarget.value)
                              }
                            />
                            <button
                              type="submit"
                              disabled={
                                branchState.operation !== null ||
                                conflictState.mergeInProgress
                              }
                            >
                              {branchState.operation === 'creating'
                                ? 'Creating…'
                                : branchState.operation === 'checking-out'
                                  ? 'Checking out…'
                                  : 'Create branch'}
                            </button>
                          </form>
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
