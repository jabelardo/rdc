interface ILocalFontData {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly style: string;
}

declare global {
  // Added in Chromium 103 (June 21, 2022)
  function queryLocalFonts(): Promise<readonly ILocalFontData[]>;
}

export async function getLocalFonts(): Promise<readonly ILocalFontData[]> {
  try {
    return await globalThis.queryLocalFonts();
  } catch (error) {
    console.warn("Unable to query local fonts:", error);
    return [];
  }
}

export async function getLocalFontFamilies(): Promise<string[]> {
  const fonts = await getLocalFonts();
  const families = fonts.map((font) => font.family).filter((family) => family.trim() !== "");
  // Was lodash's `uniq`; native Set dedupe is equivalent for a string[] and
  // costs no dependency. See DEVELOPMENT.md for the utility-library policy.
  return [...new Set(families)];
}

export function isFontFamilyInstalled(family: string): boolean {
  return document.fonts.check(`16px ${JSON.stringify(family)}`);
}
