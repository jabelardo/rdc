import { parallelWithConcurrencyLimit } from '../promise'
import { getLocalFontFamilies, isFontFamilyInstalled } from './installed-fonts'

export async function getInstalledMonospaceFontFamilies(): Promise<string[]> {
  const families = await getLocalFontFamilies()
  if (families.length === 0) {
    return getCuratedMonospaceFontFamilies().filter(isFontFamilyInstalled)
  }
  const monospaceFamilies = await filterMonospaceFamilies(families)
  return monospaceFamilies.sort((a, b) => a.localeCompare(b))
}

async function filterMonospaceFamilies(families: string[]): Promise<string[]> {
  const results = await parallelWithConcurrencyLimit(
    families,
    family => isMonospaceFontFamily(family),
    10
  )
  return families.filter((_, i) => results[i])
}

async function isMonospaceFontFamily(family: string): Promise<boolean> {
  const ctx = document.createElement('canvas').getContext('2d')
  if (ctx === null) {
    return false
  }

  const font = `24px ${JSON.stringify(family)}`
  try {
    await document.fonts.load(font)
  } catch {
    return false
  }

  ctx.font = font
  const a = ctx.measureText('i'.repeat(50)).width
  const b = ctx.measureText('W'.repeat(50)).width
  return Math.abs(a - b) < 0.01
}

function getCuratedMonospaceFontFamilies() {
  return [
    'Cascadia Mono',
    'Cascadia Code',
    'Consolas',
    'Lucida Console',
    'Fira Code',
    'JetBrains Mono',
    'Courier New',
    'Menlo',
    'Monaco',
    'SF Mono',
    'Liberation Mono',
    'DejaVu Sans Mono',
    'Ubuntu Mono',
    'Source Code Pro',
    'Inconsolata',
    'Hack',
  ]
}
