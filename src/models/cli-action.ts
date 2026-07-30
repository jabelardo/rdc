export interface OpenRepositoryAction {
  readonly kind: 'open-repository'
  readonly path: string
  readonly persistSelection?: boolean
}

export type CLIAction =
  | OpenRepositoryAction
  | {
      readonly kind: 'clone-url'
      readonly url: string
      readonly branch?: string
    }
