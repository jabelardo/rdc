import type { Repository } from '../../models/repository'
import type { WorkingDirectoryFileChange } from '../../models/status'
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
        aria-current={selected ? 'true' : undefined}
        tabIndex={
          selected || (selectedRepository === null && index === 0)
            ? 0
            : -1
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
        <strong>{repository.name}</strong>
        <span>{repository.path}</span>
      </button>
      <button
        type="button"
        className="repository-list-actions"
        aria-label={`More actions for ${repository.name}`}
        onClick={() => onContextMenu(repository)}
      >
        …
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
        onChange={event =>
          onSetIncluded(file.id, event.currentTarget.checked)
        }
      />
      <button
        type="button"
        className="working-tree-file-selection"
        data-keyboard-list-item
        data-keyboard-list-index={index}
        aria-current={selected ? 'true' : undefined}
        tabIndex={
          selected || (selectedFileID === null && index === 0) ? 0 : -1
        }
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
        <small>{mapStatus(file.status)}</small>
      </button>
      <button
        type="button"
        className="working-tree-file-discard"
        aria-label={`Discard ${file.path}`}
        onClick={() => onDiscard(file.id)}
      >
        Discard
      </button>
    </li>
  )
}
