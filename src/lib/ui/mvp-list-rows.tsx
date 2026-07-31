import {
  faCheck,
  faCodeBranch,
  faEllipsisVertical,
  faFolder,
  faRotateLeft,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { Branch } from '../../models/branch'
import type { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  type WorkingDirectoryFileChange,
} from '../../models/status'
import { mapStatus } from '../status'
import { handleListNavigation } from './list-navigation'
import type { VirtualListRow } from './virtual-list'

type RepositoryListRowProps = {
  readonly index: number
  readonly repositories: ReadonlyArray<Repository>
  readonly repository: Repository
  readonly row: VirtualListRow
  readonly selectedRepository: Repository | null
  readonly onContextMenu: (repository: Repository) => void
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
      <button
        type="button"
        className="repository-list-selection"
        data-repository-path={repository.path}
        data-keyboard-list-item
        data-keyboard-list-index={index}
        aria-label={`Select ${repository.name}`}
        title={`${repository.name} — ${repository.path}`}
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
          onContextMenu(repository)
        }}
      >
        <FontAwesomeIcon
          className="repository-list-icon"
          icon={faFolder}
          aria-hidden="true"
        />
        <strong>{repository.name}</strong>
      </button>
      <button
        type="button"
        className="repository-list-actions"
        aria-label={`More actions for ${repository.name}`}
        title={`More actions for ${repository.name}`}
        onClick={() => onContextMenu(repository)}
      >
        <FontAwesomeIcon icon={faEllipsisVertical} aria-hidden="true" />
      </button>
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
}

export function BranchListRow({
  branch,
  branches,
  currentBranch,
  groupLabel,
  index,
  onSelect,
  operationDisabled,
  row,
}: BranchListRowProps) {
  const current = branch.name === currentBranch
  const unavailable = operationDisabled || current
  const description = current
    ? `${branch.name} — current branch`
    : `Check out ${branch.name}`

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
      <button
        type="button"
        className="branch-list-selection"
        data-branch-name={branch.name}
        data-keyboard-list-item
        data-keyboard-list-index={index}
        aria-label={description}
        aria-current={current ? 'true' : undefined}
        aria-disabled={unavailable}
        title={description}
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
      >
        <FontAwesomeIcon
          className="branch-list-icon"
          icon={current ? faCheck : faCodeBranch}
          aria-hidden="true"
        />
        <span>{branch.name}</span>
      </button>
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

function workingTreeStatusGlyph(kind: AppFileStatusKind): string {
  switch (kind) {
    case AppFileStatusKind.New:
    case AppFileStatusKind.Untracked:
    case AppFileStatusKind.Copied:
      return '+'
    case AppFileStatusKind.Deleted:
      return '−'
    case AppFileStatusKind.Renamed:
      return '→'
    case AppFileStatusKind.Conflicted:
      return '!'
    case AppFileStatusKind.Modified:
      return '•'
  }
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
        <small
          className={`working-tree-file-status status-${file.status.kind.toLowerCase()}`}
          role="img"
          aria-label={mapStatus(file.status)}
          title={mapStatus(file.status)}
        >
          {workingTreeStatusGlyph(file.status.kind)}
        </small>
        <button
          type="button"
          className="working-tree-file-discard"
          aria-label={`Discard ${file.path}`}
          title={`Discard changes to ${file.path}`}
          onClick={() => onDiscard(file.id)}
        >
          <FontAwesomeIcon icon={faRotateLeft} aria-hidden="true" />
          <span className="sr-only">Discard {file.path}</span>
        </button>
      </span>
    </li>
  )
}
