import { describe, expect, it } from "vitest";
import {
  aggregatePhaseProgress,
  aggregateRemoteProgress,
  RemoteTransportWeight,
} from "./remote-operation-progress";

describe("remote operation progress aggregation", () => {
  it("splits transport progress evenly across remotes", () => {
    expect(aggregateRemoteProgress(0, 2, 0.5)).toBe(0.225);
    expect(aggregateRemoteProgress(1, 2, 1)).toBe(0.9);
  });

  it("handles an empty remote list without dividing by zero", () => {
    expect(aggregateRemoteProgress(0, 0, 0)).toBe(RemoteTransportWeight);
  });

  it("combines sequential workflow phases", () => {
    expect(aggregatePhaseProgress(0, 0.65, 0.5)).toBe(0.325);
    expect(aggregatePhaseProgress(0.65, 0.25, 0.5)).toBe(0.775);
  });
});
