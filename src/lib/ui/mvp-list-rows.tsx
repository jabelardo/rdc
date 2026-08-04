import {
  faArrowRight,
  faCheck,
  faCodeBranch,
  faEllipsisVertical,
  faExclamation,
  faFolder,
  faTrashCan,
  faSquareCaretUp,
  faSquareMinus,
  faSquarePlus,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { Branch } from '../../models/branch'
import type { Repository } from '../../models/repository'
import {
  type AppFileStatus,
  AppFileStatusKind,
  type WorkingDirectoryFileChange,
} from '../../models/status'
import { mapStatus } from '../status'
import { handleListNavigation } from './list-navigation'
import { Tooltip } from './tooltip'
import type { VirtualListRow } from './virtual-list'

function formatBranchModifiedDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

type RepositoryListRowProps = {
  readonly index: number
  readonly repositories: ReadonlyArray<Repository>
  readonly repository: Repository
  readonly row: VirtualListRow
  readonly selectedRepository: Repository | null
  readonly onContextMenu: (
    repository: Repository,
    x?: number,
    y?: number
  ) => void
  readonly onSelect: (repository: Repository) => void
}

export function RepositoryListRow({
  index,
  onContextMenu,
  onSelect,
  repositories,
  repository,
  row,
  selectedRepository,
}: RepositoryListRowProps) {
  const selected = selectedRepository?.id === repository.id
  return (
    <li
      ref={row.measureElement}
      className="repository-list-item"
      data-index={row.virtualIndex}
      style={row.style}
    >
      <Tooltip label={repository.path}>
        <button
          type="button"
          className="repository-list-selection"
          data-repository-path={repository.path}
          data-keyboard-list-item
          data-keyboard-list-index={index}
          aria-label={`Select ${repository.name}`}
          aria-current={selected ? 'true' : undefined}
          tabIndex={
            selected || (selectedRepository === null && index === 0) ? 0 : -1
          }
          onClick={() => onSelect(repository)}
          onKeyDown={event =>
            handleListNavigation(
              event,
              index,
              repositories.length,
              targetIndex => onSelect(repositories[targetIndex]),
              row.focusIndex
            )
          }
          onContextMenu={event => {
            event.preventDefault()
            onContextMenu(repository, event.clientX, event.clientY)
            event.currentTarget.blur()
          }}
        >
          <FontAwesomeIcon
            className="repository-list-icon"
            icon={faFolder}
            aria-hidden="true"
          />
          <strong>{repository.name}</strong>
        </button>
      </Tooltip>
      <Tooltip label={`More actions for ${repository.name}`}>
        <button
          type="button"
          className="repository-list-actions"
          aria-label={`More actions for ${repository.name}`}
          onClick={e => {
            onContextMenu(repository, e.clientX, e.clientY)
            e.currentTarget.blur()
          }}
        >
          <FontAwesomeIcon icon={faEllipsisVertical} aria-hidden="true" />
        </button>
      </Tooltip>
    </li>
  )
}

type BranchListRowProps = {
  readonly branch: Branch
  readonly branches: ReadonlyArray<Branch>
  readonly currentBranch: string | null
  readonly groupLabel?: string
  readonly index: number
  readonly operationDisabled: boolean
  readonly row: VirtualListRow
  readonly onSelect: (branch: Branch) => void
  readonly onContextMenu?: (branch: Branch, x?: number, y?: number) => void
}

export function BranchListRow({
  branch,
  branches,
  currentBranch,
  groupLabel,
  index,
  onSelect,
  operationDisabled,
  onContextMenu,
  row,
}: BranchListRowProps) {
  const current = branch.name === currentBranch
  const unavailable = operationDisabled || current
  const description = current
    ? `${branch.name} — current branch`
    : `Check out ${branch.name}`
  const tooltipDescription = `${
    current ? 'Current branch' : 'Check out branch'
  }\nLast modified: ${formatBranchModifiedDate(branch.tip.author.date)}`

  return (
    <li
      ref={row.measureElement}
      className="branch-list-item"
      data-index={row.virtualIndex}
      style={row.style}
    >
      {groupLabel !== undefined && (
        <h3 className="branch-list-group-heading">{groupLabel}</h3>
      )}
      <Tooltip label={tooltipDescription}>
        <button
          type="button"
          className="branch-list-selection"
          data-branch-name={branch.name}
          data-keyboard-list-item
          data-keyboard-list-index={index}
          aria-label={description}
          aria-current={current ? 'true' : undefined}
          aria-disabled={unavailable}
          tabIndex={current || (currentBranch === null && index === 0) ? 0 : -1}
          onClick={() => {
            if (!unavailable) {
              onSelect(branch)
            }
          }}
          onKeyDown={event => {
            handleListNavigation(
              event,
              index,
              branches.length,
              targetIndex => {
                const target = branches[targetIndex]
                if (!operationDisabled && target.name !== currentBranch) {
                  onSelect(target)
                }
              },
              row.focusIndex
            )
          }}
          onContextMenu={
            onContextMenu === undefined
              ? undefined
              : event => {
                  event.preventDefault()
                  onContextMenu(
                    branch,
                    event.clientX * window.devicePixelRatio,
                    event.clientY * window.devicePixelRatio
                  )
                  event.currentTarget.blur()
                }
          }
        >
          <FontAwesomeIcon
            className="branch-list-icon"
            icon={current ? faCheck : faCodeBranch}
            aria-hidden="true"
          />
          <span>{branch.name}</span>
        </button>
      </Tooltip>
    </li>
  )
}

type WorkingTreeFileRowProps = {
  readonly file: WorkingDirectoryFileChange
  readonly files: ReadonlyArray<WorkingDirectoryFileChange>
  readonly index: number
  readonly row: VirtualListRow
  readonly selectedFileID: string | null
  readonly onDiscard: (fileID: string) => void
  readonly onSelect: (fileID: string) => void
  readonly onSetIncluded: (fileID: string, included: boolean) => void
}

function fileStatusIcon(kind: AppFileStatusKind): typeof faSquarePlus {
  switch (kind) {
    case AppFileStatusKind.New:
    case AppFileStatusKind.Untracked:
    case AppFileStatusKind.Copied:
      return faSquarePlus
    case AppFileStatusKind.Deleted:
      return faSquareMinus
    case AppFileStatusKind.Renamed:
      return faArrowRight
    case AppFileStatusKind.Conflicted:
      return faExclamation
    case AppFileStatusKind.Modified:
      return faSquareCaretUp
  }
}

/** One status glyph shared by working-tree and committed-file lists. */
export function FileStatusIcon({
  status,
  className = '',
}: {
  readonly status: AppFileStatus
  readonly className?: string
}) {
  const label = mapStatus(status)
  return (
    <Tooltip label={label}>
      <small
        className={`working-tree-file-status status-${status.kind.toLowerCase()} ${className}`}
        role="img"
        aria-label={label}
      >
        <FontAwesomeIcon
          icon={fileStatusIcon(status.kind)}
          aria-hidden="true"
        />
      </small>
    </Tooltip>
  )
}

export function WorkingTreeFileRow({
  file,
  files,
  index,
  onDiscard,
  onSelect,
  onSetIncluded,
  row,
  selectedFileID,
}: WorkingTreeFileRowProps) {
  const selected = selectedFileID === file.id
  return (
    <li
      ref={row.measureElement}
      data-index={row.virtualIndex}
      data-changed-file-path={file.path}
      style={row.style}
    >
      <input
        type="checkbox"
        aria-label={`Include ${file.path}`}
        checked={file.isIncludedInCommit()}
        onChange={event => onSetIncluded(file.id, event.currentTarget.checked)}
      />
      <button
        type="button"
        className="working-tree-file-selection"
        data-keyboard-list-item
        data-keyboard-list-index={index}
        aria-current={selected ? 'true' : undefined}
        tabIndex={selected || (selectedFileID === null && index === 0) ? 0 : -1}
        onClick={() => onSelect(file.id)}
        onKeyDown={event =>
          handleListNavigation(
            event,
            index,
            files.length,
            targetIndex => onSelect(files[targetIndex].id),
            row.focusIndex
          )
        }
      >
        <span>{file.path}</span>
      </button>
      <span className="working-tree-file-actions">
        <FileStatusIcon status={file.status} />
        <Tooltip label={`Discard changes to ${file.path}`}>
          <button
            type="button"
            className="working-tree-file-discard"
            aria-label={`Discard ${file.path}`}
            onClick={() => onDiscard(file.id)}
          >
            <FontAwesomeIcon icon={faTrashCan} aria-hidden="true" />
            <span className="sr-only">Discard {file.path}</span>
          </button>
        </Tooltip>
      </span>
    </li>
  )
}
