import { getInstalledMonospaceFontFamilies } from '../lib/fonts/monospace-font-filter'

export type DiffFontFamily = string

const localFontPrefix = 'local:'

export const defaultDiffFontFamily: DiffFontFamily = 'default'
export const defaultDiffFontSize = 11

export const availableDiffFontSizes: ReadonlyArray<number> = [
  10, 11, 12, 13, 14, 16,
]

function getFontFamilyName(fontFamily: DiffFontFamily): string | null {
  if (fontFamily === defaultDiffFontFamily) {
    return null
  }

  return fontFamily.startsWith(localFontPrefix)
    ? fontFamily.substring(localFontPrefix.length)
    : fontFamily
}

export function getDiffFontFamilyLabel(fontFamily: DiffFontFamily) {
  const name = getFontFamilyName(fontFamily)
  return name === null ? 'Default monospace' : name
}

export function getDiffFontFamilyCssValue(fontFamily: DiffFontFamily) {
  const name = getFontFamilyName(fontFamily)
  return name === null
    ? 'var(--font-family-monospace)'
    : `${JSON.stringify(name)}, var(--font-family-monospace)`
}

let availableDiffFontFamiliesPromise: Promise<
  ReadonlyArray<DiffFontFamily>
> | null = null

export async function getAvailableDiffFontFamilies(): Promise<
  ReadonlyArray<DiffFontFamily>
> {
  if (availableDiffFontFamiliesPromise !== null) {
    return availableDiffFontFamiliesPromise
  }

  // This is a slow, blocking operation.
  // Yield to the event loop first so that the Appearance settings page can fully render.
  await new Promise(resolve => setTimeout(resolve, 0))

  availableDiffFontFamiliesPromise = (async () => {
    const families = await getInstalledMonospaceFontFamilies()
    return [
      defaultDiffFontFamily,
      ...families.map(f => `${localFontPrefix}${f}`),
    ]
  })()

  return availableDiffFontFamiliesPromise
}

export function getDiffLineHeight(diffFontSize: number) {
  return Math.max(20, diffFontSize + 8)
}
