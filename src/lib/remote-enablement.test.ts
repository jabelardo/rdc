import { describe, expect, it } from "vitest";
import type { MenuItem } from "../models/app-menu";
import type { Repository } from "../models/repository";
import { buildRepositoryMenu } from "./menu/repository-menu";
import { remoteEnablement } from "./remote-enablement";
import type { RemoteState } from "./stores/remote-store";

const repository = { id: 7, name: "rdc", path: "/projects/rdc" } as Repository;

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    repositoryPath: repository.path,
    remotes: [],
    currentRemote: { name: "origin", url: "/remotes/origin.git" },
    currentBranch: {
      name: "main",
      upstream: "origin/main",
    } as RemoteState["currentBranch"],
    loading: false,
    managementError: null,
    ...overrides,
  };
}

function menuFlags(rs: RemoteState): {
  canFetch: boolean;
  canPush: boolean;
  canPull: boolean;
} {
  const menu = buildRepositoryMenu(
    { repositories: [repository], selectedRepository: repository },
    "linux",
    rs,
  );
  const items = menu.items.flatMap((item) =>
    item.type === "submenuItem" ? [item, ...item.menu.items] : [item],
  );
  const enabled = (id: string): boolean =>
    (items.find((item) => item.id === id) as MenuItem & { enabled: boolean }).enabled;
  return {
    canFetch: enabled("fetch"),
    canPush: enabled("push"),
    canPull: enabled("pull"),
  };
}

describe("remoteEnablement", () => {
  it("disables all three without a selection", () => {
    expect(
      remoteEnablement({
        hasSelection: false,
        selectedRepositoryPath: null,
        remoteState: remoteState(),
      }),
    ).toEqual({ canFetch: false, canPush: false, canPull: false });
  });

  it("guards against stale remote facts for a previously selected repository", () => {
    const flags = remoteEnablement({
      hasSelection: true,
      selectedRepositoryPath: repository.path,
      remoteState: remoteState({ repositoryPath: "/other/repository" }),
    });
    expect(flags).toEqual({ canFetch: false, canPush: false, canPull: false });
  });

  it("requires a remote and a quiet store", () => {
    expect(
      remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: remoteState({ currentRemote: null }),
      }),
    ).toEqual({ canFetch: false, canPush: false, canPull: false });
    expect(
      remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: remoteState(),
        repositoryOperationActive: true,
      }),
    ).toEqual({ canFetch: false, canPush: false, canPull: false });
    expect(
      remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: remoteState({ loading: true }),
      }),
    ).toEqual({ canFetch: false, canPush: false, canPull: false });
  });

  it("honors the native repository lock even before legacy remote state catches up", () => {
    expect(
      remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: remoteState(),
        repositoryOperationActive: true,
      }),
    ).toEqual({ canFetch: false, canPush: false, canPull: false });
  });

  it("scales push and pull off the current branch and its upstream", () => {
    expect(
      remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: remoteState({ currentBranch: null }),
      }),
    ).toEqual({ canFetch: true, canPush: false, canPull: false });
    expect(
      remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: remoteState({
          currentBranch: {
            name: "main",
            upstream: null,
          } as RemoteState["currentBranch"],
        }),
      }),
    ).toEqual({ canFetch: true, canPush: true, canPull: false });
  });

  it("parity: the application menu derives its flags from the same predicate", () => {
    const cases: ReadonlyArray<RemoteState> = [
      remoteState(),
      remoteState({ currentRemote: null }),
      remoteState(),
      remoteState({ loading: true }),
      remoteState({ repositoryPath: "/other/repository" }),
      remoteState({ currentBranch: null }),
      remoteState({
        currentBranch: {
          name: "main",
          upstream: null,
        } as RemoteState["currentBranch"],
      }),
    ];
    for (const rs of cases) {
      const predicate = remoteEnablement({
        hasSelection: true,
        selectedRepositoryPath: repository.path,
        remoteState: rs,
      });
      expect(menuFlags(rs)).toEqual(predicate);
    }
  });
});
