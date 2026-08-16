import { describe, expect, it } from "vitest";
import { remoteWorkflowPhase } from "./remote-operation-workflow";

describe("remoteWorkflowPhase", () => {
  it("reserves the final tenth of fetch for repository refresh", () => {
    expect(remoteWorkflowPhase("fetch", "transport")).toEqual({ offset: 0, weight: 0.9 });
    expect(remoteWorkflowPhase("fetch", "refresh")).toEqual({ offset: 0.9, weight: 0.1 });
  });

  it("keeps push and pull transport phases aligned", () => {
    expect(remoteWorkflowPhase("push", "transport")).toEqual({ offset: 0, weight: 0.65 });
    expect(remoteWorkflowPhase("pull", "transport")).toEqual({ offset: 0, weight: 0.65 });
    expect(remoteWorkflowPhase("push", "fetch")).toEqual({ offset: 0.65, weight: 0.25 });
    expect(remoteWorkflowPhase("pull", "refresh")).toEqual({ offset: 0.9, weight: 0.1 });
  });
});
