import { describe, expect, it } from "vitest";
import snapshot from "@/lib/__generated__/wire-snapshot.json";
import type { OpenRepositoryAction } from "./cli-action";

describe("window startup action wire contract", () => {
  it("matches the Rust serializer and preserves explicit false", () => {
    const action = {
      kind: "open-repository",
      path: "/repo/../repo",
      persistSelection: false,
    } satisfies OpenRepositoryAction;

    expect(snapshot.windowStartupAction).toEqual(action);
  });
});
