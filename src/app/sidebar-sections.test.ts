import { describe, expect, it } from "vitest";
import {
  MvpSidebarCapabilities,
  SidebarSections,
  visibleSidebarSections,
} from "./sidebar-sections";

describe("sidebar section registry", () => {
  it("keeps every planned section in one stable order", () => {
    expect(SidebarSections.map((section) => section.id)).toEqual([
      "repositories",
      "branches",
      "tags",
      "stashes",
      "submodules",
      "subtrees",
    ]);
  });

  it("shows only sections backed by MVP features", () => {
    expect(visibleSidebarSections(MvpSidebarCapabilities).map((section) => section.id)).toEqual([
      "repositories",
      "branches",
    ]);
  });

  it("exposes a deferred section only when its capability lands", () => {
    expect(
      visibleSidebarSections(new Set([...MvpSidebarCapabilities, "tags"])).map(
        (section) => section.id,
      ),
    ).toEqual(["repositories", "branches", "tags"]);
  });
});
