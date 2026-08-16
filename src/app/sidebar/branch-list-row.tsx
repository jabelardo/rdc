import { Check, GitBranch } from "lucide-react";
import type { Branch } from "@/models/branch";
import { formatTimestamp } from "@/utils/format-timestamp";
import { handleListNavigation } from "@/utils/list-navigation";
import { Tooltip } from "@/components/tooltip/tooltip";
import type { VirtualListRow } from "@/components/virtual-list";

type BranchListRowProps = {
  readonly branch: Branch;
  readonly branches: ReadonlyArray<Branch>;
  readonly currentBranch: string | null;
  readonly groupLabel?: string;
  readonly index: number;
  readonly operationDisabled: boolean;
  readonly row: VirtualListRow;
  readonly onSelect: (branch: Branch) => void;
  readonly onContextMenu?: (branch: Branch, x: number, y: number) => void;
};

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
  const current = branch.name === currentBranch;
  const unavailable = operationDisabled || current;
  const description = current ? `${branch.name} — current branch` : `Check out ${branch.name}`;
  const tooltipDescription = `${
    current ? "Current branch" : "Check out branch"
  }\nLast modified: ${formatTimestamp(branch.tip.author.date)}`;
  // Bound to a capitalised name so JSX renders it as a component rather than an element name.
  const BranchIcon = current ? Check : GitBranch;

  return (
    <li
      ref={row.measureElement}
      className="branch-list-item"
      data-index={row.virtualIndex}
      style={row.style}
    >
      {groupLabel !== undefined && <h3 className="branch-list-group-heading">{groupLabel}</h3>}
      <Tooltip label={tooltipDescription}>
        <button
          type="button"
          className="branch-list-selection"
          data-branch-name={branch.name}
          data-keyboard-list-item
          data-keyboard-list-index={index}
          aria-label={description}
          aria-current={current ? "true" : undefined}
          aria-disabled={unavailable}
          tabIndex={current || (currentBranch === null && index === 0) ? 0 : -1}
          onClick={() => {
            if (!unavailable) {
              onSelect(branch);
            }
          }}
          onKeyDown={(event) => {
            handleListNavigation(
              event,
              index,
              branches.length,
              (targetIndex) => {
                const target = branches[targetIndex];
                if (!operationDisabled && target.name !== currentBranch) {
                  onSelect(target);
                }
              },
              row.focusIndex,
            );
          }}
          onContextMenu={
            onContextMenu === undefined
              ? undefined
              : (event) => {
                  event.preventDefault();
                  onContextMenu(branch, event.clientX, event.clientY);
                  event.currentTarget.blur();
                }
          }
        >
          <BranchIcon className="branch-list-icon" aria-hidden="true" />
          <span>{branch.name}</span>
        </button>
      </Tooltip>
    </li>
  );
}
