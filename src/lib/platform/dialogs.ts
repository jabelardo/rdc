import { open, save } from '@tauri-apps/plugin-dialog'
import type { OpenDialogOptions, SaveDialogOptions } from '../../models/dialog'

export async function showOpenDialog(
  options: OpenDialogOptions
): Promise<string | null> {
  const properties = new Set(options.properties)
  const result = await open({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters?.map(filter => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
    directory: properties.has('openDirectory'),
    canCreateDirectories: properties.has('createDirectory'),
    multiple: properties.has('multiSelections'),
  })

  if (Array.isArray(result)) {
    return result[0] ?? null
  }
  return result
}

export function showSaveDialog(
  options: SaveDialogOptions
): Promise<string | null> {
  const properties = new Set(options.properties)
  return save({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters?.map(filter => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
    canCreateDirectories: properties.has('createDirectory'),
  })
}
