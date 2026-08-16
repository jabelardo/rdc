import {
  ArrowRight,
  type LucideIcon,
  SquareChevronUp,
  SquareMinus,
  SquarePlus,
  TriangleAlert,
} from "lucide-react";
import { type AppFileStatus, AppFileStatusKind } from "@/models/status";
import { mapStatus } from "@/utils/status";
import { Tooltip } from "@/components/tooltip/tooltip";

function fileStatusIcon(kind: AppFileStatusKind): LucideIcon {
  switch (kind) {
    case AppFileStatusKind.New:
    case AppFileStatusKind.Untracked:
    case AppFileStatusKind.Copied:
      return SquarePlus;
    case AppFileStatusKind.Deleted:
      return SquareMinus;
    case AppFileStatusKind.Renamed:
      return ArrowRight;
    case AppFileStatusKind.Conflicted:
      return TriangleAlert;
    case AppFileStatusKind.Modified:
      return SquareChevronUp;
  }
}

/** One status glyph shared by working-tree and committed-file lists. */
export function FileStatusIcon({
  status,
  className = "",
}: {
  readonly status: AppFileStatus;
  readonly className?: string;
}) {
  const label = mapStatus(status);
  const StatusIcon = fileStatusIcon(status.kind);
  return (
    <Tooltip label={label}>
      <small
        className={`working-tree-file-status status-${status.kind.toLowerCase()} ${className}`}
        role="img"
        aria-label={label}
      >
        <StatusIcon aria-hidden="true" />
      </small>
    </Tooltip>
  );
}
