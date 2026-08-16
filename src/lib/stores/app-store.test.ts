import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryType } from "@/models/repository-type";
import { RepositoriesDatabase } from "@/lib/databases/repositories-database";
import { AppStore } from "./app-store";
import { RepositoriesStore } from "./repositories-store";

describe("Phase 7a AppStore repository ownership", () => {
  let database: RepositoriesDatabase;
  let repositories: RepositoriesStore;
  let repositoryTypes: Map<string, RepositoryType>;
  let selectedPaths: Array<string | null>;
  let appStore: AppStore;

  beforeEach(async () => {
    localStorage.clear();
    database = new RepositoriesDatabase(`rdc-app-store-test-${crypto.randomUUID()}`);
    await database.open();
    repositories = new RepositoriesStore(database);
    repositoryTypes = new Map();
    selectedPaths = [];
    appStore = new AppStore(repositories, {
      getRepositoryType: async (path) => repositoryTypes.get(path) ?? { kind: "missing" },
      setWindowSelectedRepository: async (path) => {
        selectedPaths.push(path);
      },
    });
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  function regular(path: string, canonicalPath = path): void {
    repositoryTypes.set(path, {
      kind: "regular",
      topLevelWorkingDirectory: canonicalPath,
      gitDir: `${canonicalPath}/.git`,
    });
  }

  it("adds the canonical repository, selects it and publishes native window metadata", async () => {
    regular("/repo/subdirectory", "/repo");

    const repository = await appStore.addRepository("/repo/subdirectory");

    expect(repository.path).toBe("/repo");
    expect(appStore.state.repositories).toEqual([repository]);
    expect(appStore.state.selectedRepository).toBe(repository);
    expect(selectedPaths).toEqual(["/repo"]);
  });

  it("restores the last selected repository in a fresh store", async () => {
    regular("/one");
    regular("/two");
    const one = await appStore.addRepository("/one");
    const two = await appStore.addRepository("/two");
    await appStore.selectRepository(one);

    const reopened = new AppStore(repositories, {
      getRepositoryType: vi.fn(),
      setWindowSelectedRepository: async (path) => {
        selectedPaths.push(path);
      },
    });
    await reopened.load();

    expect(reopened.state.repositories).toEqual([one, two]);
    expect(reopened.state.selectedRepository?.id).toBe(one.id);
    expect(selectedPaths.at(-1)).toBe("/one");
  });

  it("falls back to the first repository and selects the next one after removal", async () => {
    regular("/one");
    regular("/two");
    const one = await appStore.addRepository("/one");
    const two = await appStore.addRepository("/two");
    localStorage.setItem("last-selected-repository-id", "999");

    const reopened = new AppStore(repositories, {
      getRepositoryType: vi.fn(),
      setWindowSelectedRepository: async (path) => {
        selectedPaths.push(path);
      },
    });
    await reopened.load();
    expect(reopened.state.selectedRepository?.id).toBe(one.id);

    await reopened.removeRepository(one);
    expect(reopened.state.repositories).toEqual([two]);
    expect(reopened.state.selectedRepository?.id).toBe(two.id);
    expect(selectedPaths.at(-1)).toBe("/two");
  });

  it("rejects paths that are not regular working repositories", async () => {
    await expect(appStore.addRepository("/missing")).rejects.toThrow(
      "/missing isn't a Git working repository",
    );
    expect(appStore.state.repositories).toEqual([]);
  });
});
