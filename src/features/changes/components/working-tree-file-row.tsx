import { Trash2 } from "lucide-react";
import type { WorkingDirectoryFileChange } from "@/models/status";
import { handleListNavigation } from "@/utils/list-navigation";
import { FileStatusIcon } from "@/components/file-status-icon";
import { Tooltip } from "@/components/tooltip/tooltip";
import type { VirtualListRow } from "@/components/virtual-list";

type WorkingTreeFileRowProps = {
  readonly file: WorkingDirectoryFileChange;
  readonly files: ReadonlyArray<WorkingDirectoryFileChange>;
  readonly index: number;
  readonly row: VirtualListRow;
  readonly selectedFileID: string | null;
  readonly onDiscard: (fileID: string) => void;
  readonly onSelect: (fileID: string) => void;
  readonly onSetIncluded: (fileID: string, included: boolean) => void;
};

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
  const selected = selectedFileID === file.id;
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
        onChange={(event) => onSetIncluded(file.id, event.currentTarget.checked)}
      />
      <button
        type="button"
        className="working-tree-file-selection"
        data-keyboard-list-item
        data-keyboard-list-index={index}
        aria-current={selected ? "true" : undefined}
        tabIndex={selected || (selectedFileID === null && index === 0) ? 0 : -1}
        onClick={() => onSelect(file.id)}
        onKeyDown={(event) =>
          handleListNavigation(
            event,
            index,
            files.length,
            (targetIndex) => onSelect(files[targetIndex].id),
            row.focusIndex,
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
            <Trash2 aria-hidden="true" />
            <span className="sr-only">Discard {file.path}</span>
          </button>
        </Tooltip>
      </span>
    </li>
  );
}
