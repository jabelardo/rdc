import { describe, expect, it } from "vitest";
import { listNavigationTarget } from "./list-navigation";

describe("list keyboard navigation", () => {
  it("moves with arrows without wrapping", () => {
    expect(listNavigationTarget("ArrowDown", 1, 4)).toBe(2);
    expect(listNavigationTarget("ArrowDown", 3, 4)).toBe(3);
    expect(listNavigationTarget("ArrowUp", 2, 4)).toBe(1);
    expect(listNavigationTarget("ArrowUp", 0, 4)).toBe(0);
  });

  it("moves to either boundary with Home and End", () => {
    expect(listNavigationTarget("Home", 2, 4)).toBe(0);
    expect(listNavigationTarget("End", 1, 4)).toBe(3);
  });

  it("leaves unrelated keys and empty lists alone", () => {
    expect(listNavigationTarget("Enter", 1, 4)).toBeNull();
    expect(listNavigationTarget("ArrowDown", 0, 0)).toBeNull();
  });
});
