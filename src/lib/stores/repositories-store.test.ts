import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoriesDatabase } from "@/lib/databases/repositories-database";
import { RepositoriesStore } from "./repositories-store";

describe("RepositoriesStore", () => {
  let database: RepositoriesDatabase;
  let store: RepositoriesStore;

  beforeEach(async () => {
    database = new RepositoriesDatabase(`rdc-repositories-test-${crypto.randomUUID()}`);
    await database.open();
    store = new RepositoriesStore(database);
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it("contains an added repository with its resolved git directory", async () => {
    const repository = await store.addRepository("/some/cool/path", "/some/cool/path/.git");

    expect(await store.getAll()).toEqual([repository]);
    expect(repository).toMatchObject({
      path: "/some/cool/path",
      gitDir: "/some/cool/path/.git",
      missing: false,
    });
  });

  it("returns multiple repositories in insertion order", async () => {
    await store.addRepository("/some/cool/path", "/some/cool/path/.git");
    await store.addRepository("/some/other/path", "/some/other/path/.git");

    expect((await store.getAll()).map((repository) => repository.path)).toEqual([
      "/some/cool/path",
      "/some/other/path",
    ]);
  });

  it("reuses an existing repository at the same path", async () => {
    const first = await store.addRepository("/repo", "/repo/.git");
    const second = await store.addRepository("/repo", "/different/.git");

    expect(second.id).toBe(first.id);
    expect(second.gitDir).toBe("/repo/.git");
    expect(await store.getAll()).toHaveLength(1);
  });

  it("persists repositories across store instances and removes them durably", async () => {
    const repository = await store.addRepository("/repo", "/repo/.git");
    const reopened = new RepositoriesStore(database);

    expect(await reopened.getAll()).toEqual([repository]);

    await reopened.removeRepository(repository);
    expect(await store.getAll()).toEqual([]);
  });
});
