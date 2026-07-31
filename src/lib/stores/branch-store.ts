import { BranchType, type Branch } from '../../models/branch'
import type { ICheckoutProgress } from '../../models/progress'
import { getBranches } from '../branch-ipc'
import { checkoutBranch, getStatus, type IStatusResult } from '../git-ipc'
import { createBranch } from '../branch-ipc'

export type BranchOperation = 'creating' | 'checking-out'

export type BranchState = {
  readonly repositoryPath: string | null
  readonly branches: ReadonlyArray<Branch>
  readonly currentBranch: string | null
  readonly loading: boolean
  readonly error: string | null
  readonly operation: BranchOperation | null
  readonly progress: ICheckoutProgress | null
  readonly operationError: string | null
}

type BranchFactsStatus = Pick<IStatusResult, 'currentBranch'>

type BranchStoreDependencies = {
  readonly getBranches: (
    repositoryPath: string
  ) => Promise<ReadonlyArray<Branch>>
  readonly getStatus: (
    repositoryPath: string,
    listUntrackedFilesIndividually: boolean
  ) => Promise<BranchFactsStatus | null>
  readonly createBranch: typeof createBranch
  readonly checkoutBranch: typeof checkoutBranch
}

const defaultDependencies: BranchStoreDependencies = {
  getBranches,
  getStatus,
  createBranch,
  checkoutBranch,
}

const EmptyState: BranchState = {
  repositoryPath: null,
  branches: [],
  currentBranch: null,
  loading: false,
  error: null,
  operation: null,
  progress: null,
  operationError: null,
}

/**
 * Owns the minimum Phase 7c branch workflow.
 *
 * Git owns branch validity and checkout mechanics. This store owns the
 * user-level create-then-checkout sequence and refreshes both refs and HEAD
 * afterwards so the UI never infers the current branch from branch ordering.
 */
export class BranchStore {
  private currentState = EmptyState
  private requestID = 0
  private operationID = 0
  private readonly dependencies: BranchStoreDependencies
  private readonly listeners = new Set<(state: BranchState) => void>()

  public constructor(dependencies: Partial<BranchStoreDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  public get state(): BranchState {
    return this.currentState
  }

  public onDidUpdate(listener: (state: BranchState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public async load(repositoryPath: string): Promise<void> {
    const requestID = ++this.requestID
    this.operationID++
    this.update({
      repositoryPath,
      branches: [],
      currentBranch: null,
      loading: true,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    })

    try {
      const [branches, status] = await this.loadFacts(repositoryPath)
      if (requestID !== this.requestID) {
        return
      }
      this.update({
        repositoryPath,
        branches,
        currentBranch: status?.currentBranch ?? null,
        loading: false,
        error: null,
        operation: null,
        progress: null,
        operationError: null,
      })
    } catch (error) {
      if (requestID !== this.requestID) {
        return
      }
      this.update({
        repositoryPath,
        branches: [],
        currentBranch: null,
        loading: false,
        error: String(error),
        operation: null,
        progress: null,
        operationError: null,
      })
    }
  }

  public async createAndCheckout(name: string): Promise<boolean> {
    const branchName = name.trim()
    if (branchName.length === 0) {
      this.update({
        ...this.currentState,
        operationError: 'Enter a branch name.',
      })
      return false
    }
    const repositoryPath = this.currentState.repositoryPath
    if (repositoryPath === null) {
      return false
    }

    const operationID = ++this.operationID
    const requestID = this.requestID
    this.update({
      ...this.currentState,
      operation: 'creating',
      progress: null,
      operationError: null,
    })
    try {
      await this.dependencies.createBranch(
        repositoryPath,
        branchName,
        undefined,
        false
      )
      if (!this.isCurrentOperation(requestID, operationID)) {
        return false
      }
      this.update({
        ...this.currentState,
        operation: 'checking-out',
      })
      await this.dependencies.checkoutBranch(
        repositoryPath,
        branchName,
        progress => this.publishProgress(requestID, operationID, progress)
      )
      return await this.finishOperation(repositoryPath, requestID, operationID)
    } catch (error) {
      return this.failOperation(requestID, operationID, error)
    }
  }

  public async checkout(name: string): Promise<boolean> {
    const branch = this.currentState.branches.find(
      branch => branch.name === name
    )
    if (
      branch === undefined ||
      branch.type !== BranchType.Local ||
      branch.name === this.currentState.currentBranch ||
      this.currentState.repositoryPath === null
    ) {
      return false
    }

    const repositoryPath = this.currentState.repositoryPath
    const operationID = ++this.operationID
    const requestID = this.requestID
    this.update({
      ...this.currentState,
      operation: 'checking-out',
      progress: null,
      operationError: null,
    })
    try {
      await this.dependencies.checkoutBranch(
        repositoryPath,
        branch.name,
        progress => this.publishProgress(requestID, operationID, progress)
      )
      return await this.finishOperation(repositoryPath, requestID, operationID)
    } catch (error) {
      return this.failOperation(requestID, operationID, error)
    }
  }

  public clear(): void {
    this.requestID++
    this.operationID++
    this.update(EmptyState)
  }

  private loadFacts(repositoryPath: string) {
    return Promise.all([
      this.dependencies.getBranches(repositoryPath),
      this.dependencies.getStatus(repositoryPath, true),
    ])
  }

  private async finishOperation(
    repositoryPath: string,
    requestID: number,
    operationID: number
  ): Promise<boolean> {
    const [branches, status] = await this.loadFacts(repositoryPath)
    if (!this.isCurrentOperation(requestID, operationID)) {
      return false
    }
    this.update({
      repositoryPath,
      branches,
      currentBranch: status?.currentBranch ?? null,
      loading: false,
      error: null,
      operation: null,
      progress: null,
      operationError: null,
    })
    return true
  }

  private failOperation(
    requestID: number,
    operationID: number,
    error: unknown
  ): false {
    if (this.isCurrentOperation(requestID, operationID)) {
      this.update({
        ...this.currentState,
        operation: null,
        progress: null,
        operationError: String(error),
      })
    }
    return false
  }

  private publishProgress(
    requestID: number,
    operationID: number,
    progress: ICheckoutProgress
  ): void {
    if (this.isCurrentOperation(requestID, operationID)) {
      this.update({ ...this.currentState, progress })
    }
  }

  private isCurrentOperation(requestID: number, operationID: number): boolean {
    return requestID === this.requestID && operationID === this.operationID
  }

  private update(state: BranchState): void {
    this.currentState = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
