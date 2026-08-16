import { beforeEach, describe, expect, it, vi } from "vitest";

const getPath = vi.hoisted(() => vi.fn());
const showFolderContents = vi.hoisted(() => vi.fn());

vi.mock("@/platform/paths", () => ({ getPath }));
vi.mock("@/platform/files", () => ({ showFolderContents }));

const { showApplicationLogs } = await import("./logs");

describe("application log recovery", () => {
  beforeEach(() => {
    getPath.mockReset();
    showFolderContents.mockReset();
    getPath.mockResolvedValue("/logs/rdc");
    showFolderContents.mockResolvedValue(undefined);
  });

  it("opens the application log directory through the guarded folder boundary", async () => {
    await showApplicationLogs();

    expect(getPath).toHaveBeenCalledWith("logs");
    expect(showFolderContents).toHaveBeenCalledWith("/logs/rdc");
  });
});
