import type { Repository } from '../../models/repository'
import type { RepositoryType } from '../../models/repository-type'
import { getNumber, setNumber } from '../local-storage'
import { getRepositoryType } from '../misc-ipc'
import { setWindowSelectedRepository } from '../platform/window'
import { RepositoriesStore } from './repositories-store'

const LastSelectedRepositoryIDKey = 'last-selected-repository-id'

export type AppStoreState = {
  readonly repositories: ReadonlyArray<Repository>
  readonly selectedRepository: Repository | null
}

type AppStoreDependencies = {
  readonly getRepositoryType: (path: string) => Promise<RepositoryType>
  readonly setWindowSelectedRepository: (path: string | null) => Promise<void>
}

const defaultDependencies: AppStoreDependencies = {
  getRepositoryType,
  setWindowSelectedRepository,
}

/**
 * The first real slice of upstream's dispatcher/store seam.
 *
 * Repository ownership and selection live here so later changes/history
 * slices can extend this state instead of replacing a one-off shell model.
 */
export class AppStore {
  private repositories: ReadonlyArray<Repository> = []
  private selectedRepository: Repository | null = null
  private readonly listeners = new Set<(state: AppStoreState) => void>()

  public constructor(
    private readonly repositoriesStore: RepositoriesStore,
    private readonly dependencies: AppStoreDependencies = defaultDependencies
  ) {}

  public get state(): AppStoreState {
    return {
      repositories: this.repositories,
      selectedRepository: this.selectedRepository,
    }
  }

  public onDidUpdate(listener: (state: AppStoreState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitUpdate(): void {
    const state = this.state
    for (const listener of this.listeners) {
      listener(state)
    }
  }

  public async load(): Promise<void> {
    this.repositories = await this.repositoriesStore.getAll()
    const lastSelectedID = getNumber(LastSelectedRepositoryIDKey, 0)
    const selected =
      this.repositories.find(repository => repository.id === lastSelectedID) ??
      this.repositories[0] ??
      null
    await this.selectRepository(selected)
  }

  public async addRepository(
    requestedPath: string,
    persistSelection = true
  ): Promise<Repository> {
    const type = await this.dependencies.getRepositoryType(requestedPath)
    if (type.kind !== 'regular') {
      throw new Error(
        `${requestedPath} isn't a Git working repository (${type.kind}).`
      )
    }

    const added = await this.repositoriesStore.addRepository(
      type.topLevelWorkingDirectory,
      type.gitDir
    )
    this.repositories = await this.repositoriesStore.getAll()
    const repository =
      this.repositories.find(candidate => candidate.id === added.id) ?? added
    await this.selectRepository(repository, persistSelection)
    return repository
  }

  public async removeRepository(repository: Repository): Promise<void> {
    await this.repositoriesStore.removeRepository(repository)
    this.repositories = await this.repositoriesStore.getAll()

    const selected =
      this.selectedRepository?.id === repository.id
        ? (this.repositories[0] ?? null)
        : (this.repositories.find(
            candidate => candidate.id === this.selectedRepository?.id
          ) ??
          this.repositories[0] ??
          null)
    await this.selectRepository(selected)
  }

  public async selectRepository(
    repository: Repository | null,
    persistSelection = true
  ): Promise<void> {
    const selected =
      repository === null
        ? null
        : (this.repositories.find(
            candidate => candidate.id === repository.id
          ) ?? null)

    this.selectedRepository = selected
    if (selected !== null && persistSelection) {
      setNumber(LastSelectedRepositoryIDKey, selected.id)
    }
    await this.dependencies.setWindowSelectedRepository(selected?.path ?? null)
    this.emitUpdate()
  }
}
