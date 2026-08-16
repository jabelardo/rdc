import { AppFileStatusKind, type AppFileStatus, isConflictWithMarkers } from "@/models/status";
import { assertNever } from "@/utils/fatal-error";

/**
 * Convert a given `AppFileStatusKind` value to a human-readable string to be
 * presented to users which describes the state of a file.
 *
 * Typically this will be the same value as that of the enum key.
 *
 * Used in file lists.
 */
export function mapStatus(status: AppFileStatus): string {
  switch (status.kind) {
    case AppFileStatusKind.New:
    case AppFileStatusKind.Untracked:
      return "New";
    case AppFileStatusKind.Modified:
      return "Modified";
    case AppFileStatusKind.Deleted:
      return "Deleted";
    case AppFileStatusKind.Renamed:
      return "Renamed";
    case AppFileStatusKind.Conflicted:
      if (isConflictWithMarkers(status)) {
        const conflictsCount = status.conflictMarkerCount;
        return conflictsCount > 0 ? "Conflicted" : "Resolved";
      }

      return "Conflicted";
    case AppFileStatusKind.Copied:
      return "Copied";
    default:
      return assertNever(status, `Unknown file status ${status}`);
  }
}
