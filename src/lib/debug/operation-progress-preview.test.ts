import { describe, expect, it } from "vitest";
import { operationProgressViewModel } from "../operation-presentation";
import {
  OperationPreviewLabel,
  OperationPreviewStates,
  operationPreviewRecord,
} from "./operation-progress-preview";

describe("operationPreviewRecord", () => {
  it("names every state it offers", () => {
    for (const state of OperationPreviewStates) {
      expect(OperationPreviewLabel[state]).toBeTruthy();
    }
  });

  // The point of the preview is that the *shipped* dialog renders it, so every case must survive
  // the real view model rather than merely being a plausible-looking record.
  it("produces a record the real view model accepts", () => {
    for (const state of OperationPreviewStates) {
      const model = operationProgressViewModel(operationPreviewRecord(state), "main");
      expect(model.statusText, state).toBeTruthy();
    }
  });

  it("reaches the lifecycle copy each case is named for", () => {
    const status = (state: (typeof OperationPreviewStates)[number]) =>
      operationProgressViewModel(operationPreviewRecord(state), "main").statusText;

    expect(status("takingLongerThanExpected")).toBe("Taking longer than expected");
    expect(status("cancelling")).toBe("Cancelling…");
    expect(status("recovering")).toBe("Recovering repository…");
    expect(status("completedBeforeCancellation")).toBe("Completed before cancellation");
    expect(status("outcomeUnknown")).toBe("Outcome unknown");
    // Distinct from the above: a cancelled unknown outcome shows its own wording.
    expect(status("stoppedWaiting")).toMatch(/remote may have accepted/);
    expect(status("failed")).toMatch(/could not read from remote/);
    expect(status("timedOut")).toMatch(/timed out/);
  });

  // These two are the reason a preview exists at all: reproducing them by hand means two minutes of
  // inactivity, or making Git fail while it is recovering.
  it("reaches recovery-required, which must not offer a way out", () => {
    const model = operationProgressViewModel(operationPreviewRecord("recoveryRequired"), "main");

    expect(model.recoveryRequired).toBe(true);
    expect(model.cancellationAvailable).toBe(false);
  });

  it("offers cancellation only to the owner, and adoption only when the owner is gone", () => {
    const owner = operationProgressViewModel(
      operationPreviewRecord("running", "fetch", "main"),
      "main",
      "owner",
    );
    const observer = operationProgressViewModel(
      operationPreviewRecord("running", "fetch", "main"),
      "main",
      "observer",
    );
    const unowned = operationProgressViewModel(
      operationPreviewRecord("running", "fetch", null),
      "main",
      "unowned",
    );

    expect(owner.cancellationAvailable).toBe(true);
    expect(observer.cancellationAvailable).toBe(false);
    expect(unowned.adoptionAvailable).toBe(true);
  });

  it("labels cancellation for the operation being previewed", () => {
    const model = operationProgressViewModel(
      operationPreviewRecord("running", "push"),
      "main",
      "owner",
    );

    expect(model.cancellationLabel).toBe("Cancel push");
  });
});
