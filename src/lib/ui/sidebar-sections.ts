export type SidebarSectionID =
  | 'repositories'
  | 'branches'
  | 'tags'
  | 'stashes'
  | 'submodules'
  | 'subtrees'

export type SidebarSectionDefinition = {
  readonly id: SidebarSectionID
  readonly label: string
  readonly delivery: 'mvp' | 'phase-7f'
}

/**
 * Describe the complete navigation architecture without rendering features
 * whose stores and actions do not exist yet.
 */
export const SidebarSections: ReadonlyArray<SidebarSectionDefinition> =
  Object.freeze([
    { id: 'repositories', label: 'Repositories', delivery: 'mvp' },
    { id: 'branches', label: 'Branches', delivery: 'mvp' },
    { id: 'tags', label: 'Tags', delivery: 'phase-7f' },
    { id: 'stashes', label: 'Stashes', delivery: 'phase-7f' },
    { id: 'submodules', label: 'Submodules', delivery: 'phase-7f' },
    { id: 'subtrees', label: 'Subtrees', delivery: 'phase-7f' },
  ])

export const MvpSidebarCapabilities: ReadonlySet<SidebarSectionID> = new Set([
  'repositories',
  'branches',
])

export function visibleSidebarSections(
  capabilities: ReadonlySet<SidebarSectionID>
): ReadonlyArray<SidebarSectionDefinition> {
  return SidebarSections.filter(section => capabilities.has(section.id))
}
