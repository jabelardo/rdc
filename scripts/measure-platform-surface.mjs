// Measures the frontend-facing platform surface inherited from desktop-plus.
//
// Usage, from the repository root:
//
//   node scripts/measure-platform-surface.mjs [path-to-desktop-plus] [--require-phase4a-complete]
//   node scripts/measure-platform-surface.mjs [path-to-desktop-plus] [--require-complete]
//
// This is a local gate rather than CI because it needs the sibling upstream checkout. It deliberately
// distinguishes "classified" from "implemented": at the start of Phase 4 most entries are known work,
// while at its end every Phase 4 entry must have a wrapper under src/lib/platform or a registered
// command. Later-phase and deliberately deleted entries remain classified without pretending they are
// implemented.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const args = process.argv.slice(2)
const upstream = args.find(argument => !argument.startsWith('--')) ?? '../desktop-plus'
const requirePhase4aComplete = args.includes('--require-phase4a-complete')
const requireComplete = args.includes('--require-complete')
const UPSTREAM_PROXY = join(upstream, 'app/src/ui/main-process-proxy.ts')
const UPSTREAM_SOURCE = join(upstream, 'app/src')
const PLATFORM_SOURCE = 'src/lib/platform'
const PLATFORM_ADAPTER_FILES = [
  'src/lib/custom-integration.ts',
  'src/lib/menu/application-menu.ts',
  'src/lib/stores/token-store.ts',
]

const PROXY_FACTORIES = new Set(['invokeProxy', 'sendProxy'])

// Phase 4 was split after the inventory was built: 4a is the platform substrate Phase 7 needs,
// while these independent integrations are 4b. Keep the boundary here so 4a can have a real closure
// gate without pretending that the whole phase is complete.
export const PHASE_4B_PROXY_EXPORTS = new Set([
  'sendDialogDidOpen',
  'checkForUpdates',
  'quitAndInstallUpdate',
  'onAutoUpdaterError',
  'onAutoUpdaterCheckingForUpdate',
  'onAutoUpdaterUpdateAvailable',
  'onAutoUpdaterUpdateNotAvailable',
  'onAutoUpdaterUpdateDownloaded',
  'onShowInstallingUpdate',
  'getAppleActionOnDoubleClick',
  'moveToApplicationsFolder',
  'isInApplicationFolder',
  'saveGUID',
  'getGUID',
  'updateMainProcessConfig',
  'getMainProcessConfig',
  'showNotification',
  'getNotificationsPermission',
  'requestNotificationsPermission',
])

export const PHASE_4B_SUBSCRIPTIONS = new Set([
  'notification-event',
  'auto-updater-error',
  'auto-updater-checking-for-update',
  'auto-updater-update-available',
  'auto-updater-update-not-available',
  'auto-updater-update-downloaded',
  'show-installing-update',
])

// These exports are still part of the upstream proxy contract, but another phase owns their replacement.
const LATER_PHASE_EXPORTS = new Map([
  ['showCertificateTrustDialog', 5],
  ['updateAccounts', 5],
  ['resolveProxy', 5],
  ['_reportUncaughtException', 6],
  ['reportUncaughtException', 6],
  ['sendErrorReport', 6],
  ['installWindowsCLI', 9],
  ['uninstallWindowsCLI', 9],
])

// rdc owns its configuration format, so it intentionally has no migration-result API.
const DELETED_EXPORTS = new Map([
  ['getConfigMigrationResult', 'rdc does not migrate desktop-plus configuration'],
])

// Upstream subscribed directly to raw Electron channels, so these replacement
// adapters necessarily have frontend-friendly names rather than channel names.
const SUBSCRIPTION_ADAPTERS = new Map([
  ['app-menu', 'ApplicationMenuController'],
  ['auto-updater-checking-for-update', 'onAutoUpdaterCheckingForUpdate'],
  ['auto-updater-error', 'onAutoUpdaterError'],
  ['auto-updater-update-available', 'onAutoUpdaterUpdateAvailable'],
  ['auto-updater-update-downloaded', 'onAutoUpdaterUpdateDownloaded'],
  ['auto-updater-update-not-available', 'onAutoUpdaterUpdateNotAvailable'],
  ['blur', 'onWindowFocusChanged'],
  ['focus', 'onWindowFocusChanged'],
  ['menu-event', 'onNativeMenuAction'],
  ['launch-timing-stats', 'onLaunchTimingStats'],
  ['notification-event', 'onNotificationEvent'],
  ['native-theme-updated', 'onNativeThemeUpdated'],
  ['show-installing-update', 'onShowInstallingUpdate'],
  ['window-state-changed', 'onWindowStateChanged'],
  ['zoom-factor-changed', 'onWindowZoomFactorChanged'],
])

// These upstream functions only existed to synchronously manipulate Electron
// main-process flags before a later window close. Tauri gives the renderer the
// preventable close event directly, so all three collapse into one handler.
const PROXY_ADAPTERS = new Map([
  ['getAppMenu', 'ApplicationMenuController'],
  ['updateMenuState', 'ApplicationMenuController'],
  ['updatePreferredAppMenuItemLabels', 'ApplicationMenuController'],
  ['executeMenuItem', 'ApplicationMenuController'],
  ['executeMenuItemById', 'ApplicationMenuController'],
  ['sendWillQuitSync', 'installCloseRequestHandler'],
  ['sendWillQuitEvenIfUpdatingSync', 'installCloseRequestHandler'],
  ['sendCancelQuittingSync', 'installCloseRequestHandler'],
])

// Platform integrations imported directly from Node-bound upstream modules rather than through
// main-process-proxy.ts. They are part of Phase 4's broader module map, but not one of its 67 proxy
// entry points, so the reverse audit requires a named consumer here.
const CONSUMER_OUTSIDE_PROXY = new Map([
  [
    'installApplicationMenu',
    'App.tsx installs the Phase 4a frontend menu owner before Phase 7 ports the full application shell',
  ],
  ['getAvailableEditors', 'lib/editors/lookup.ts and Phase 7 preferences/store consumers'],
  ['getAvailableShells', 'ui/preferences/preferences.tsx and lib/stores/app-store.ts'],
  ['findShellOrDefault', 'lib/stores/app-store.ts'],
  ['launchShell', 'lib/stores/app-store.ts'],
  ['launchCustomShell', 'lib/stores/app-store.ts'],
  ['validateCustomIntegrationPath', 'ui/preferences/custom-integration-form.tsx'],
  ['isValidCustomIntegration', 'ui/preferences/preferences.tsx'],
  ['migratedCustomIntegration', 'lib/stores/app-store.ts'],
  ['launchExternalEditor', 'lib/stores/app-store.ts'],
  ['launchCustomExternalEditor', 'lib/stores/app-store.ts'],
  [
    'updateWindowBackgroundColor',
    'ui/app-theme.tsx sends the channel directly rather than through main-process-proxy.ts',
  ],
  [
    'getExecPath',
    'lib/stores/copilot-store.ts invokes get-exec-path directly rather than through main-process-proxy.ts',
  ],
  [
    'unsafeOpenDirectory',
    'main-process-proxy.ts keeps this unsafe primitive private behind showFolderContents',
  ],
  [
    'getKeybindings',
    'Phase 4 menu bootstrap; new capability with no upstream proxy entry point',
  ],
  [
    'setKeybinding',
    'Phase 7 keybinding preferences; new capability with no upstream proxy entry point',
  ],
  [
    'resetKeybindings',
    'Phase 7 keybinding preferences; new capability with no upstream proxy entry point',
  ],
  [
    'onKeybindingsChanged',
    'Phase 4 menu/accelerator refresh; new capability with no upstream proxy entry point',
  ],
  [
    'setNativeMenu',
    'macOS startup installs the frontend-owned default tree after renderer load',
  ],
  [
    'installDefaultCloseRequestHandler',
    'the current React harness supplies Phase 4a platform-default close policy',
  ],
  [
    'UpdateController',
    'fake-backend lifecycle tests now and the Phase 7 update store when its UI is ported',
  ],
  [
    'applicationUpdateController',
    'platform/lifetime.ts consults the retained update before destructive close',
  ],
  ['TokenStore', 'account and BYOK credential persistence; direct replacement for keytar'],
  ['InstalledCLIPath', 'the Phase 7 CLI-installed dialog displays the installed launcher path'],
  ['installCLI', 'the Phase 7 dispatcher invokes the direct macOS CLI installer'],
])

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

function sourceFile(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function isExported(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

/** Exported runtime values declared by a TypeScript module. */
export function exportedValues(file, source) {
  const names = []
  for (const statement of sourceFile(file, source).statements) {
    if (!isExported(statement)) continue
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.push(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.push(element.name.text)
      }
    }
  }
  return names
}

/**
 * Literal channels subscribed through the upstream ipc-renderer wrapper.
 *
 * Aliasing the import is supported; looking for the string `ipcRenderer.on` would let comments and
 * unrelated objects satisfy the audit.
 */
export function subscribedChannels(files) {
  const channels = new Set()
  for (const { file, source } of files) {
    const ast = sourceFile(file, source)
    const rendererNamespaces = new Set()
    for (const statement of ast.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        /(^|\/)ipc-renderer$/.test(statement.moduleSpecifier.text) &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)
      ) {
        rendererNamespaces.add(statement.importClause.namedBindings.name.text)
      }
    }

    const visit = node => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'on' &&
        ts.isIdentifier(node.expression.expression) &&
        rendererNamespaces.has(node.expression.expression.text)
      ) {
        const channel = node.arguments[0]
        if (channel && (ts.isStringLiteral(channel) || ts.isNoSubstitutionTemplateLiteral(channel))) {
          channels.add(channel.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return channels
}

/** Phase assignments from MIGRATION_MAP.md §7.1. */
export function routedChannelPhases(source) {
  const start = source.indexOf('### 7.1 Upstream channels, routed')
  const end = source.indexOf('### 7.2 Git commands', start)
  if (start < 0 || end < 0) {
    throw new Error('could not find MIGRATION_MAP.md §7.1 routed-channel tables')
  }

  const routes = new Map()
  for (const match of source.slice(start, end).matchAll(/^\s*\| `([^`]+)` \|[^|]+\|[^|]+\| (\d+) \|/gm)) {
    const [, channel, phase] = match
    if (routes.has(channel)) throw new Error(`channel is routed more than once: ${channel}`)
    routes.set(channel, Number(phase))
  }
  return routes
}

/** The commands `generate_handler!` actually registers. */
function registeredCommands() {
  const source = readFileSync('src-tauri/src/lib.rs', 'utf8')
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/)?.[1]
  if (!block) throw new Error('could not find the Tauri generate_handler! list')
  return new Set(
    block
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => entry.split('::').at(-1))
  )
}

function platformExports() {
  const exports = new Set()
  for (const file of [...walk(PLATFORM_SOURCE), ...PLATFORM_ADAPTER_FILES]) {
    const source = readFileSync(file, 'utf8')
    for (const name of exportedValues(file, source)) exports.add(name)
  }
  return exports
}

function kebabToSnake(name) {
  return name.replaceAll('-', '_')
}

export function isSubscriptionImplemented(channel, providedExports, commands) {
  return (
    providedExports.has(channel) ||
    providedExports.has(SUBSCRIPTION_ADAPTERS.get(channel)) ||
    commands.has(kebabToSnake(channel))
  )
}

function measure() {
  const proxyExports = exportedValues(UPSTREAM_PROXY, readFileSync(UPSTREAM_PROXY, 'utf8')).filter(
    name => !PROXY_FACTORIES.has(name)
  )
  const duplicateProxyExports = proxyExports.filter(
    (name, index) => proxyExports.indexOf(name) !== index
  )
  const proxySet = new Set(proxyExports)
  const unknownClassifications = [...LATER_PHASE_EXPORTS.keys(), ...DELETED_EXPORTS.keys()].filter(
    name => !proxySet.has(name)
  )
  const phase4Exports = proxyExports.filter(
    name => !LATER_PHASE_EXPORTS.has(name) && !DELETED_EXPORTS.has(name)
  )
  const phase4aExports = phase4Exports.filter(name => !PHASE_4B_PROXY_EXPORTS.has(name))

  const upstreamFiles = walk(UPSTREAM_SOURCE).map(file => ({
    file,
    source: readFileSync(file, 'utf8'),
  }))
  const subscriptions = subscribedChannels(upstreamFiles)
  const routes = routedChannelPhases(readFileSync('MIGRATION_MAP.md', 'utf8'))
  const unclassifiedSubscriptions = [...subscriptions].filter(channel => !routes.has(channel)).sort()

  const laterSubscriptions = [...subscriptions].filter(channel => routes.get(channel) !== 4)
  const phase4Subscriptions = [...subscriptions].filter(channel => routes.get(channel) === 4)
  const phase4aSubscriptions = phase4Subscriptions.filter(
    channel => !PHASE_4B_SUBSCRIPTIONS.has(channel)
  )

  const providedExports = platformExports()
  const commands = registeredCommands()
  const implementedPhase4Exports = phase4Exports.filter(
    name =>
      providedExports.has(name) ||
      providedExports.has(PROXY_ADAPTERS.get(name))
  )
  const pendingPhase4Exports = phase4Exports.filter(
    name =>
      !providedExports.has(name) &&
      !providedExports.has(PROXY_ADAPTERS.get(name))
  )
  const pendingPhase4aExports = phase4aExports.filter(
    name =>
      !providedExports.has(name) &&
      !providedExports.has(PROXY_ADAPTERS.get(name))
  )
  const subscriptionAdapterExports = new Set(SUBSCRIPTION_ADAPTERS.values())
  const proxyAdapterExports = new Set(PROXY_ADAPTERS.values())
  const extraExports = [...providedExports]
    .filter(
      name =>
        !proxySet.has(name) &&
        !CONSUMER_OUTSIDE_PROXY.has(name) &&
        !subscriptionAdapterExports.has(name) &&
        !proxyAdapterExports.has(name)
    )
    .sort()

  const implementedPhase4Subscriptions = phase4Subscriptions.filter(
    channel => isSubscriptionImplemented(channel, providedExports, commands)
  )
  const pendingPhase4Subscriptions = phase4Subscriptions.filter(
    channel => !isSubscriptionImplemented(channel, providedExports, commands)
  )
  const pendingPhase4aSubscriptions = phase4aSubscriptions.filter(
    channel => !isSubscriptionImplemented(channel, providedExports, commands)
  )
  const stalePhase4bExports = [...PHASE_4B_PROXY_EXPORTS].filter(
    name => !phase4Exports.includes(name)
  )
  const stalePhase4bSubscriptions = [...PHASE_4B_SUBSCRIPTIONS].filter(
    channel => !phase4Subscriptions.includes(channel)
  )

  console.log(`${proxyExports.length} upstream main-process proxy entry points`)
  console.log(`   ${phase4Exports.length} owned by Phase 4`)
  console.log(`   ${LATER_PHASE_EXPORTS.size} owned by later phases`)
  console.log(`   ${DELETED_EXPORTS.size} deliberately deleted`)
  console.log(`   ${implementedPhase4Exports.length} Phase 4 wrappers implemented`)
  console.log(`   ${pendingPhase4Exports.length} Phase 4 wrappers pending`)
  console.log(
    `   ${phase4aExports.length - pendingPhase4aExports.length}/${phase4aExports.length} Phase 4a wrappers implemented`
  )
  for (const name of pendingPhase4Exports) console.log(`   PENDING WRAPPER: ${name}`)

  console.log(`\n${subscriptions.size} distinct upstream renderer subscriptions`)
  console.log(`   ${phase4Subscriptions.length} owned by Phase 4`)
  console.log(`   ${laterSubscriptions.length} owned by later phases`)
  console.log(`   ${implementedPhase4Subscriptions.length} Phase 4 listeners/commands implemented`)
  console.log(`   ${pendingPhase4Subscriptions.length} Phase 4 listeners/commands pending`)
  console.log(
    `   ${phase4aSubscriptions.length - pendingPhase4aSubscriptions.length}/${phase4aSubscriptions.length} Phase 4a listeners/commands implemented`
  )
  for (const channel of pendingPhase4Subscriptions) console.log(`   PENDING SUBSCRIPTION: ${channel}`)

  console.log(`\n${providedExports.size} Phase 4 adapter runtime exports`)
  console.log(`   ${CONSUMER_OUTSIDE_PROXY.size} have a named consumer outside the proxy`)
  for (const name of extraExports) console.log(`   NO UPSTREAM ENTRY POINT: ${name}`)
  for (const name of unknownClassifications) console.log(`   STALE CLASSIFICATION: ${name}`)
  for (const channel of unclassifiedSubscriptions) console.log(`   UNROUTED SUBSCRIPTION: ${channel}`)
  for (const name of duplicateProxyExports) console.log(`   EXPORTED TWICE: ${name}`)
  for (const name of stalePhase4bExports) console.log(`   STALE PHASE 4B WRAPPER: ${name}`)
  for (const channel of stalePhase4bSubscriptions) {
    console.log(`   STALE PHASE 4B SUBSCRIPTION: ${channel}`)
  }

  // Pending Phase 4 implementation is expected while the phase is open. Structural errors are not:
  // the inventory, classifications and reverse check must stay exact from the first slice onward.
  // The closure gate opts into treating pending work as an error with --require-complete.
  const structuralProblems =
    duplicateProxyExports.length +
    unknownClassifications.length +
    unclassifiedSubscriptions.length +
    extraExports.length +
    stalePhase4bExports.length +
    stalePhase4bSubscriptions.length
  const pendingPhase4aProblems = requirePhase4aComplete
    ? pendingPhase4aExports.length + pendingPhase4aSubscriptions.length
    : 0
  const pendingProblems =
    requireComplete ? pendingPhase4Exports.length + pendingPhase4Subscriptions.length : 0
  process.exitCode = structuralProblems + pendingPhase4aProblems + pendingProblems > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  measure()
}
