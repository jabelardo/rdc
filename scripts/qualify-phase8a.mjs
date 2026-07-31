import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function includesLegacyIdentity(value) {
  return /desktop[ -]?plus|github desktop/i.test(JSON.stringify(value))
}

/**
 * Audit inputs only. Phase 8a must prove that a development build is
 * internally coherent without creating the final packages owned by 8b.
 */
export function qualifyPhase8aInputs(root) {
  const errors = []
  const packageJson = readJson(path.join(root, 'package.json'))
  const tauriConfig = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'))
  const capability = readJson(
    path.join(root, 'src-tauri', 'capabilities', 'default.json')
  )
  const requireCondition = (condition, message) => {
    if (!condition) {
      errors.push(message)
    }
  }

  requireCondition(
    packageJson.name === tauriConfig.productName.toLowerCase(),
    'package name must match the lowercase Tauri product name'
  )
  requireCondition(
    packageJson.version === tauriConfig.version,
    'package and Tauri versions must match'
  )
  requireCondition(
    packageJson.engines?.node === '>=24 <25',
    'Phase 8a builds must retain the Node 24 engine boundary'
  )
  requireCondition(
    typeof tauriConfig.identifier === 'string' &&
      tauriConfig.identifier.length > 0 &&
      !includesLegacyIdentity(tauriConfig.identifier),
    'the provisional bundle identifier must be non-empty and rdc-owned'
  )
  requireCondition(
    tauriConfig.bundle?.active === true &&
      tauriConfig.bundle?.targets === 'all',
    'Tauri bundle inputs must remain enabled for both MVP targets'
  )
  requireCondition(
    tauriConfig.app?.windows?.[0]?.create === false,
    'the startup-owned window template must retain create:false'
  )
  requireCondition(
    tauriConfig.app?.security?.freezePrototype === true,
    'the qualified production configuration must freeze Object.prototype'
  )
  requireCondition(
    !includesLegacyIdentity({
      productName: tauriConfig.productName,
      identifier: tauriConfig.identifier,
    }),
    'packaging identity must not inherit Desktop Plus or GitHub Desktop'
  )
  requireCondition(
    capability.windows?.includes('main') &&
      capability.windows?.includes('repository-*'),
    'the capability must cover the main and repository window labels'
  )
  requireCondition(
    !capability.permissions?.includes('core:default'),
    'the qualified capability must remain least-privilege'
  )

  for (const relative of [
    ...(tauriConfig.bundle?.resources ?? []),
    ...(tauriConfig.bundle?.icon ?? []),
  ]) {
    const file = path.join(root, 'src-tauri', relative)
    requireCondition(
      existsSync(file) && statSync(file).size > 0,
      `bundle input is missing or empty: ${relative}`
    )
  }

  const cli = path.join(root, 'src-tauri', 'resources', 'rdc-cli')
  requireCondition(
    existsSync(cli) && (statSync(cli).mode & 0o111) !== 0,
    'the bundled rdc-cli resource must be executable'
  )

  return {
    errors,
    humanDecisions: ['final bundle identifier', 'final application icon'],
    productName: tauriConfig.productName,
    version: tauriConfig.version,
    identifier: tauriConfig.identifier,
    resources: tauriConfig.bundle?.resources ?? [],
    icons: tauriConfig.bundle?.icon ?? [],
    finalPackagesProduced: false,
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const root = path.resolve(import.meta.dirname, '..')
  const report = qualifyPhase8aInputs(root)
  console.log(JSON.stringify(report, null, 2))
  if (report.errors.length > 0) {
    process.exitCode = 1
  }
}
