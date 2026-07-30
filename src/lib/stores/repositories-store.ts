import { Repository } from '../../models/repository'
import {
  RepositoriesDatabase,
  type DatabaseRepository,
} from '../databases/repositories-database'

function toRepository(record: DatabaseRepository): Repository {
  if (record.id === undefined) {
    throw new Error('A persisted repository must have an id')
  }

  return new Repository(
    record.path,
    record.id,
    null,
    record.missing,
    record.alias,
    record.groupName,
    record.defaultBranch,
    {},
    null,
    false,
    null,
    record.gitDir
  )
}

/**
 * Owns the durable local repository list.
 *
 * This is the Phase 7a subset of upstream's store. Account association,
 * workflow preferences and other metadata are added with their consumers.
 */
export class RepositoriesStore {
  public constructor(private readonly database: RepositoriesDatabase) {}

  public async getAll(): Promise<ReadonlyArray<Repository>> {
    return (await this.database.repositories.orderBy('id').toArray()).map(
      toRepository
    )
  }

  public async addRepository(
    path: string,
    gitDir: string
  ): Promise<Repository> {
    const record = await this.database.transaction(
      'rw',
      this.database.repositories,
      async () => {
        const existing = await this.database.repositories
          .where('path')
          .equals(path)
          .first()
        if (existing !== undefined) {
          return existing
        }

        const repository: DatabaseRepository = {
          path,
          gitDir,
          missing: false,
          alias: null,
          groupName: null,
          defaultBranch: null,
        }
        const id = await this.database.repositories.add(repository)
        return { ...repository, id }
      }
    )

    return toRepository(record)
  }

  public async removeRepository(repository: Repository): Promise<void> {
    await this.database.repositories.delete(repository.id)
  }
}
