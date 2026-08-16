import { describe, it } from "vitest";
import assert from "node:assert";
import { mapStatus } from "@/utils/status";
import { AppFileStatusKind } from "@/models/status";

describe("lib/status", () => {
  describe("mapStatus", () => {
    it('returns "New" for new files', () => {
      assert.equal(mapStatus({ kind: AppFileStatusKind.New }), "New");
    });

    it('returns "New" for untracked files', () => {
      assert.equal(mapStatus({ kind: AppFileStatusKind.Untracked }), "New");
    });

    it('returns "Modified" for modified files', () => {
      assert.equal(mapStatus({ kind: AppFileStatusKind.Modified }), "Modified");
    });

    it('returns "Deleted" for deleted files', () => {
      assert.equal(mapStatus({ kind: AppFileStatusKind.Deleted }), "Deleted");
    });

    it('returns "Renamed" for renamed files', () => {
      assert.equal(
        mapStatus({
          kind: AppFileStatusKind.Renamed,
          oldPath: "old.txt",
          renameIncludesModifications: false,
        }),
        "Renamed",
      );
    });

    it('returns "Copied" for copied files', () => {
      assert.equal(
        mapStatus({
          kind: AppFileStatusKind.Copied,
          oldPath: "orig.txt",
          renameIncludesModifications: false,
        }),
        "Copied",
      );
    });
  });
});
