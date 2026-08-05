import Dexie, { type Table } from "dexie";

/**
 * The local-only subset of upstream's repository record.
 *
 * GitHub association tables travel with the post-MVP account consumer. Keeping
 * their fields out of this first schema avoids persisting credentials or
 * account identity before any product surface needs them.
 */
export type DatabaseRepository = {
  readonly id?: number;
  readonly path: string;
  readonly gitDir: string;
  readonly missing: boolean;
  readonly alias: string | null;
  readonly groupName: string | null;
  readonly defaultBranch: string | null;
};

export class RepositoriesDatabase extends Dexie {
  public readonly repositories!: Table<DatabaseRepository, number>;

  public constructor(name = "rdc-repositories") {
    super(name);
    this.version(1).stores({
      repositories: "++id, &path",
    });
  }
}
