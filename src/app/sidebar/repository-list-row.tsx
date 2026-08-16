import { EllipsisVertical, Folder } from "lucide-react";
import type { Repository } from "@/models/repository";
import { handleListNavigation } from "@/utils/list-navigation";
import { Tooltip } from "@/components/tooltip/tooltip";
import type { VirtualListRow } from "@/components/virtual-list";

type RepositoryListRowProps = {
  readonly index: number;
  readonly repositories: ReadonlyArray<Repository>;
  readonly repository: Repository;
  readonly row: VirtualListRow;
  readonly selectedRepository: Repository | null;
  readonly onContextMenu: (repository: Repository, x: number, y: number) => void;
  readonly onSelect: (repository: Repository) => void;
};

export function RepositoryListRow({
  index,
  onContextMenu,
  onSelect,
  repositories,
  repository,
  row,
  selectedRepository,
}: RepositoryListRowProps) {
  const selected = selectedRepository?.id === repository.id;
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
          aria-current={selected ? "true" : undefined}
          tabIndex={selected || (selectedRepository === null && index === 0) ? 0 : -1}
          onClick={() => onSelect(repository)}
          onKeyDown={(event) =>
            handleListNavigation(
              event,
              index,
              repositories.length,
              (targetIndex) => onSelect(repositories[targetIndex]),
              row.focusIndex,
            )
          }
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu(repository, event.clientX, event.clientY);
            event.currentTarget.blur();
          }}
        >
          <Folder className="repository-list-icon" aria-hidden="true" />
          <strong>{repository.name}</strong>
        </button>
      </Tooltip>
      <Tooltip label={`More actions for ${repository.name}`}>
        <button
          type="button"
          className="repository-list-actions"
          aria-label={`More actions for ${repository.name}`}
          onClick={(e) => {
            onContextMenu(repository, e.clientX, e.clientY);
            e.currentTarget.blur();
          }}
        >
          <EllipsisVertical aria-hidden="true" />
        </button>
      </Tooltip>
    </li>
  );
}
