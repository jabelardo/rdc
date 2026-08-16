import { describe, expect, it } from "vitest";
import { formatRelative } from "./format-relative";

const day = 24 * 60 * 60 * 1_000;

describe("formatRelative", () => {
  it("uses calendar-friendly labels for adjacent days", () => {
    expect(formatRelative(-day)).toBe("yesterday");
    expect(formatRelative(day)).toBe("tomorrow");
  });

  it("formats representative elapsed units", () => {
    expect(formatRelative(-3 * day)).toBe("3 days ago");
    expect(formatRelative(-60 * day)).toBe("2 months ago");
    expect(formatRelative(-730 * day)).toBe("2 years ago");
  });

  it("rejects a non-finite offset explicitly", () => {
    expect(formatRelative(Number.NaN)).toBe("Invalid date");
  });
});
