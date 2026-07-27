export interface IBranchNamePreset {
  readonly name: string
  readonly description: string
}

export function parseBranchNamePresets(
  commandOutput: string
): IBranchNamePreset[] {
  return commandOutput
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [name, ...descriptionParts] = line.split(' ')
      return {
        name,
        description: descriptionParts.join(' ') || name,
      }
    })
}
