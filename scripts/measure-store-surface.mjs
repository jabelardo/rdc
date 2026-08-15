// Measures Phase 3's coverage: every function upstream's store layer imports from `lib/git`, against
// the commands this app actually registers; every command against real Tauri `invoke` calls; and every
// upstream IPC channel against the routing table in MIGRATION_MAP.md §7.1.
//
// This exists because the number was previously carried in prose ("104 distinct functions") with no
// record of how it was filtered, and a recount disagreed with it. A number in a document that nobody
// can reproduce is a claim; this makes it a measurement.
//
// Usage, from the repository root:
//
//   node scripts/measure-store-surface.mjs [path-to-desktop-plus]
//
// Not a CI job: it needs the upstream checkout, which CI doesn't have. Run it when closing a slice.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const upstream = process.argv[2] ?? "../desktop-plus";
const STORES = join(upstream, "app/src/lib/stores");
const IPC_SHARED = join(upstream, "app/src/lib/ipc-shared.ts");

/**
 * Names that are types, not functions. Counted separately because a type needs a serde shape and a
 * snapshot case, not a command — a different kind of work with a different definition of done.
 */
const TYPES = new Set([
  "CherryPickResult",
  "GitError",
  "GitResetMode",
  "HookProgress",
  "IConfigValueOrigin",
  "IStatusResult",
  "IndexStatus",
  "MergeOptions",
  "MergeResult",
  "PushOptions",
  "RebaseResult",
  "RepositoryType",
  "TerminalOutput",
]);

/**
 * Functions whose new home is TypeScript rather than a command, each with the reason and the file that
 * is supposed to hold it. A command that computes a string from a string is a command that shouldn't
 * exist — but "it lives in TypeScript" is checked below rather than trusted, since that is exactly the
 * kind of claim that rots.
 */
const IN_TYPESCRIPT = new Map([
  ["formatAsLocalRef", { file: "src/lib/refs.ts", why: "string manipulation" }],
  ["revRange", { file: "src/lib/rev-range.ts", why: "string manipulation" }],
  ["revSymmetricDifference", { file: "src/lib/rev-range.ts", why: "string manipulation" }],
  ["isCoAuthoredByTrailer", { file: "src/models/trailer.ts", why: "a predicate over one object" }],
  [
    "getBranchAheadBehind",
    {
      file: "src/lib/rev-list-ipc.ts",
      why: "composes get_ahead_behind with revSymmetricDifference",
    },
  ],
  [
    "parseSingleUnfoldedTrailer",
    {
      file: "src/models/trailer.ts",
      why: "a pure line parser called once per line — a round trip per line would be worse",
    },
  ],
  // No file: these have no TypeScript counterpart by design.
  [
    "git",
    {
      file: null,
      why: "the exec wrapper itself; git-ops replaces it rather than exposing it",
    },
  ],
  [
    "memoizedGetRemotesFromPath",
    {
      file: null,
      why: "a caching decorator over getRemotes; caching is the store layer's call",
    },
  ],
]);

/** Functions a later phase owns, with that phase. */
const LATER_PHASES = new Map([
  ["envForRemoteOperation", "Phase 5 — proxy support; Phase 7 — account state"],
  ["getConfigValueWithOrigin", "Phase 7"],
  ["getFilesDiffText", "Phase 7"],
]);

/** Where the command name isn't the camelCase name in snake_case. */
const RENAMED = new Map([
  ["merge", "merge_branch"],
  ["rebase", "rebase_branch"],
  ["getRemoteHEAD", "get_remote_head"],
  ["getRemoteURL", "get_remote_url"],
  ["setRemoteURL", "set_remote_url"],
  ["updateRemoteHEAD", "update_remote_head"],
  ["createDesktopStashEntry", "create_stash_entry"],
  ["dropDesktopStashEntry", "drop_stash_entry"],
  ["getLastDesktopStashEntryForBranch", "get_last_stash_entry_for_branch"],
  ["saveGitIgnore", "save_gitignore"],
  ["appendIgnoreRule", "append_ignore_rules"],
  ["appendIgnoreFile", "append_ignore_files"],
  ["installGlobalLFSFilters", "install_global_lfs_filters"],
  ["installLFSHooks", "install_lfs_hooks"],
  ["isUsingLFS", "is_using_lfs"],
  ["listWorktreesFromGitDir", "list_worktrees_from_git_dir"],
  ["listWorktreesFromGitDirFallback", "list_worktrees_from_git_dir_fallback"],
]);

/**
 * Commands with no importer in `lib/stores`, and the consumer that justifies each. The exit criterion
 * is "no command without a consumer", and the store list is only most of the evidence — some call
 * sites are in `ui/`, and a few commands are ours rather than upstream's.
 */
const CONSUMER_OUTSIDE_STORES = new Map([
  ["abort_hook", "ours — the abort side of hook interception, consumed by the Phase 7 hook prompt"],
  ["resolve_hook_failure", "ours — answers the Phase 7 failed-hook prompt through lib/hook-ipc.ts"],
  [
    "add_safe_directory",
    "ui/missing-repository.tsx, ui/add-repository/add-existing-repository.tsx",
  ],
  ["add_worktree", "ui/worktrees/add-worktree-dialog.tsx"],
  ["get_description", "ui/publish-repository/publish.tsx (upstream getGitDescription)"],
  [
    "get_available_editors",
    "Phase 4 platform integration — lib/editors/lookup.ts and preferences/store consumers",
  ],
  [
    "get_available_shells",
    "Phase 4 platform integration — ui/preferences/preferences.tsx and lib/stores/app-store.ts",
  ],
  [
    "get_keybindings",
    "Phase 4 platform adapter — lib/platform/keybindings.ts; renderer integration lands in Phase 7",
  ],
  [
    "set_keybinding",
    "Phase 4 platform adapter — lib/platform/keybindings.ts; preferences UI lands in Phase 7",
  ],
  [
    "reset_keybindings",
    "Phase 4 platform adapter — lib/platform/keybindings.ts; preferences UI lands in Phase 7",
  ],
  [
    "set_native_menu",
    "Phase 4 macOS startup — lib/menu/startup.ts replaces the Rust bootstrap after renderer load",
  ],
  [
    "show_contextual_menu",
    "Phase 4 platform adapter — lib/menu/context-menu.ts and 33 upstream UI consumers",
  ],
  [
    "validate_custom_integration_path",
    "Phase 4 platform integration — ui/preferences/custom-integration-form.tsx",
  ],
  ["is_valid_custom_integration", "Phase 4 platform integration — ui/preferences/preferences.tsx"],
  ["launch_external_editor", "Phase 4 platform integration — lib/stores/app-store.ts"],
  ["launch_custom_external_editor", "Phase 4 platform integration — lib/stores/app-store.ts"],
  ["launch_shell", "Phase 4 platform integration — lib/stores/app-store.ts"],
  ["launch_custom_shell", "Phase 4 platform integration — lib/stores/app-store.ts"],
  ["beep", "Phase 4 platform adapter — lib/platform/system.ts"],
  ["classify_folder_open", "Phase 4 platform adapter — lib/platform/files.ts"],
  ["delete_credential", "Phase 4 TokenStore facade — lib/stores/token-store.ts"],
  [
    "get_apple_action_on_double_click",
    "Phase 4 platform adapter — lib/platform/system.ts and window-title-bar consumers",
  ],
  ["get_credential", "Phase 4 TokenStore facade — lib/stores/token-store.ts"],
  ["get_current_window_zoom_factor", "Phase 4 platform adapter — lib/platform/window.ts"],
  ["get_exec_path", "Phase 4 platform adapter — lib/platform/files.ts"],
  ["get_guid", "Phase 4 install-ID adapter — lib/platform/install-id.ts"],
  ["get_main_process_config", "Phase 4 config adapter — lib/platform/config.ts"],
  ["get_notifications_permission", "Phase 4 notification facade — lib/platform/notifications.ts"],
  ["install_darwin_cli", "Phase 4 CLI adapter — lib/platform/cli.ts"],
  [
    "init_repository",
    "ui/app/use-app-controller.ts — initializes a fresh repository after add-local-repository",
  ],
  [
    "is_in_application_folder",
    "Phase 4 application-folder adapter — lib/platform/application-folder.ts",
  ],
  ["is_running_under_arm64_translation", "Phase 4 platform adapter — lib/platform/system.ts"],
  ["move_item_to_trash", "Phase 4 platform adapter — lib/platform/files.ts"],
  [
    "permanently_delete_repository_path",
    "Phase 7b discard recovery — lib/discard-changes.ts through lib/platform/files.ts",
  ],
  [
    "move_to_applications_folder",
    "Phase 4 application-folder adapter — lib/platform/application-folder.ts",
  ],
  ["open_repository_in_new_window", "Phase 4 window adapter — lib/platform/window.ts"],
  ["renderer_ready", "Phase 4 startup adapter — lib/platform/window.ts"],
  [
    "request_notifications_permission",
    "Phase 4 notification facade — lib/platform/notifications.ts",
  ],
  ["save_guid", "Phase 4 install-ID adapter — lib/platform/install-id.ts"],
  ["set_credential", "Phase 4 TokenStore facade — lib/stores/token-store.ts"],
  ["set_window_selected_repository", "Phase 4 window adapter — lib/platform/window.ts"],
  ["set_window_zoom_factor", "Phase 4 platform adapter — lib/platform/window.ts"],
  [
    "toggle_devtools",
    "Phase 8b in-window menu bar — lib/platform/window.ts toggleDevTools, consumed by the Dev-only menu item and the startup executor",
  ],
  ["show_notification", "Phase 4 notification facade — lib/platform/notifications.ts"],
  ["update_main_process_config", "Phase 4 config adapter — lib/platform/config.ts"],
  ["write_description", "ui/add-repository/create-repository.tsx"],
  ["read_gitignore_at_root", "ui/repository-settings/repository-settings.tsx"],
  ["checkout_remote_branch", "ours — the half of upstream checkoutBranch that creates a local ref"],
  // Operation registry — OPERATION_PROGRESS_PLAN.md. These are ours, not upstream's, so no store
  // import can vouch for them.
  [
    "get_active_operation_for_repository",
    "ours — lib/stores/operation-store.ts adopts an operation already running on the repository",
  ],
  [
    "get_active_operation_for_clone_destination",
    "ours — lib/stores/clone-store.ts, which scopes a clone by destination rather than repository",
  ],
  [
    "get_operation_scope_for_repository",
    "ours — lib/stores/operation-store.ts, to tell an operation on this repository from one elsewhere",
  ],
  [
    "get_latest_operation_event",
    "ours — an observability seam for the E2E suites, which invoke it directly to read a terminal event without racing the UI (clone-cancellation, fetch-cancellation, remote-push, operation-windows)",
  ],
  [
    "request_operation_cancellation",
    "ours — lib/stores/operation-store.ts, for both cancellation and adopted cancellation",
  ],
  ["abort_revert", "ours — ui/app/use-app-controller.ts, the revert half of conflict recovery"],
  ["move_repository_paths_to_trash", "lib/discard-changes.ts via lib/platform/files.ts"],
  ["permanently_delete_repository_paths", "lib/discard-changes.ts via lib/platform/files.ts"],
  [
    "fetch_workflow",
    "ours — lib/stores/remote-store.ts, whose Fetch sends the current and default remotes through one operation (upstream's GitStore.fetch, minus the fork arm that needs GitHub metadata)",
  ],
  [
    "show_context_menu_at",
    "ours — lib/platform/menu.ts showContextMenu, consumed by ui/app/use-app-controller.ts; the positioned variant that replaced muda's blocking popup on Linux",
  ],
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

function snakeCase(name) {
  return name.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();
}

/** Channel names declared as top-level properties of the two upstream IPC contract types. */
export function upstreamIpcChannels(source) {
  const sourceFile = ts.createSourceFile(
    "ipc-shared.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const readNames = (typeName) => {
    const declaration = sourceFile.statements.find(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === typeName &&
        ts.isTypeLiteralNode(statement.type),
    );
    if (!declaration) {
      throw new Error(`could not find ${typeName} in upstream ipc-shared.ts`);
    }

    return declaration.type.members.filter(ts.isPropertySignature).map((member) => {
      if (
        ts.isStringLiteral(member.name) ||
        ts.isIdentifier(member.name) ||
        ts.isNumericLiteral(member.name)
      ) {
        return member.name.text;
      }
      throw new Error(`unsupported computed channel name in ${typeName}`);
    });
  };

  const request = readNames("RequestChannels");
  const requestResponse = readNames("RequestResponseChannels");
  return { request, requestResponse, all: [...request, ...requestResponse] };
}

/**
 * The channel and direction columns of the routed-channel tables, excluding the git-command table.
 *
 * The direction is read too, not just the name: it is the one column that can be checked against
 * upstream rather than taken on trust, since a channel declared in `RequestResponseChannels` is
 * request/response by definition and one declared in `RequestChannels` is not.
 */
export function routedIpcChannels(source) {
  const start = source.indexOf("### 7.1 Upstream channels, routed");
  const end = source.indexOf("### 7.2 Git commands", start);
  if (start < 0 || end < 0) {
    throw new Error("could not find MIGRATION_MAP.md §7.1 routed-channel tables");
  }

  return [...source.slice(start, end).matchAll(/^\s*\| `([^`]+)` \| ([^|]+)\|/gm)].map((match) => ({
    channel: match[1],
    direction: match[2].trim(),
  }));
}

/**
 * Literal command names passed to Tauri's real `invoke` import.
 *
 * Parsing the call expression matters: looking for a quoted command name anywhere in the frontend
 * lets a comment, fixture, or unrelated constant falsely satisfy the wrapper check.
 */
export function invokedTauriCommands(files) {
  const commands = new Set();

  for (const { file, source } of files) {
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const invokeNames = new Set();

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.moduleSpecifier.text !== "@tauri-apps/api/core" ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        continue;
      }
      for (const element of statement.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "invoke") {
          invokeNames.add(element.name.text);
        }
      }
    }

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        invokeNames.has(node.expression.text)
      ) {
        const command = node.arguments[0];
        if (
          command &&
          (ts.isStringLiteral(command) || ts.isNoSubstitutionTemplateLiteral(command))
        ) {
          commands.add(command.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return commands;
}

/** Every name the store layer imports from `lib/git`, however the path is spelled. */
function storeImports() {
  const names = new Set();
  for (const file of walk(STORES)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']*)'/g)) {
      const [, clause, specifier] = match;
      // `lib/git`, `../git`, `./git/foo` — but not `../git-store` or anything else ending in `git`.
      if (!/(^|\/)git(\/[\w./-]*)?$/.test(specifier)) continue;
      if (!/(^|\/)(lib\/)?git(\/|$)/.test(specifier)) continue;
      for (const part of clause.split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(" as ")[0]
          .trim();
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** The commands `generate_handler!` actually registers. */
function registeredCommands() {
  const source = readFileSync("src-tauri/src/lib.rs", "utf8");
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/)[1];
  const entries = block
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").at(-1));

  const duplicates = entries.filter((name, index) => entries.indexOf(name) !== index);
  return { commands: new Set(entries), duplicates: [...new Set(duplicates)] };
}

function duplicatesIn(names) {
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();
}

function measure() {
  const imports = storeImports();
  const { commands, duplicates } = registeredCommands();

  const buckets = {
    hasCommand: [],
    inTypeScript: [],
    laterPhase: [],
    missing: [],
    types: [],
  };
  const covered = new Set();

  for (const name of imports) {
    if (TYPES.has(name)) {
      buckets.types.push(name);
      continue;
    }
    if (IN_TYPESCRIPT.has(name)) {
      const { file, why } = IN_TYPESCRIPT.get(name);
      if (file && !new RegExp(`export\\b.*\\b${name}\\b`).test(readFileSync(file, "utf8"))) {
        buckets.missing.push(`${name} — claimed to live in ${file}, which doesn't export it`);
      } else {
        buckets.inTypeScript.push(`${name} — ${file ?? "no counterpart"}: ${why}`);
      }
      continue;
    }
    if (LATER_PHASES.has(name)) {
      buckets.laterPhase.push(`${name} — ${LATER_PHASES.get(name)}`);
      continue;
    }
    const command = RENAMED.get(name) ?? snakeCase(name);
    if (commands.has(command)) {
      buckets.hasCommand.push(name);
      covered.add(command);
    } else {
      buckets.missing.push(`${name} — no command (looked for \`${command}\`)`);
    }
  }

  const functions =
    buckets.hasCommand.length +
    buckets.inTypeScript.length +
    buckets.laterPhase.length +
    buckets.missing.length;

  const unexplained = [...commands]
    .filter((command) => !covered.has(command) && !CONSUMER_OUTSIDE_STORES.has(command))
    .sort();

  console.log(`store layer imports ${imports.length} names from lib/git`);
  console.log(`  ${buckets.types.length} are types, leaving ${functions} functions\n`);
  console.log(`has a command          ${buckets.hasCommand.length}`);
  console.log(`lives in TypeScript    ${buckets.inTypeScript.length}`);
  console.log(`owned by a later phase ${buckets.laterPhase.length}`);
  console.log(`NOT COVERED            ${buckets.missing.length}`);
  for (const line of buckets.missing) console.log(`   ${line}`);
  console.log(`\n${commands.size} commands registered`);
  if (duplicates.length) console.log(`   REGISTERED TWICE: ${duplicates.join(", ")}`);
  console.log(`   ${covered.size} answer a store import`);
  console.log(`   ${CONSUMER_OUTSIDE_STORES.size} have a named consumer elsewhere`);
  console.log(`   ${unexplained.length} with no consumer named anywhere`);
  for (const command of unexplained) console.log(`   ${command}`);

  // Every command needs a real Tauri invoke call, not merely a mention somewhere in the frontend.
  const frontendFiles = walk("src")
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
  const invokedCommands = invokedTauriCommands(frontendFiles);
  const unwrapped = [...commands].filter((command) => !invokedCommands.has(command)).sort();
  console.log(`   ${commands.size - unwrapped.length} have a typed TypeScript invoke wrapper`);
  for (const command of unwrapped) console.log(`   NO INVOKE WRAPPER: ${command}`);

  // Every snapshot key needs a test using it. An unused key is invisible: it pins a shape nothing reads.
  const snapshot = JSON.parse(readFileSync("src/lib/__generated__/wire-snapshot.json", "utf8"));
  const specs = walk("src")
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("");
  const unread = Object.keys(snapshot).filter(
    (key) =>
      !specs.includes(`snapshot.${key}`) &&
      !specs.includes(`'${key}'`) &&
      !specs.includes(`"${key}"`),
  );
  console.log(
    `\n${Object.keys(snapshot).length} wire-snapshot keys, ${unread.length} unreferenced by any test`,
  );
  for (const key of unread) console.log(`   UNREAD: ${key}`);

  // The Phase 4–9 routing list must be an exact inventory of the two upstream IPC contract types.
  const upstreamChannels = upstreamIpcChannels(readFileSync(IPC_SHARED, "utf8"));
  const routes = routedIpcChannels(readFileSync("MIGRATION_MAP.md", "utf8"));
  const routedChannels = routes.map((route) => route.channel);
  const upstreamChannelSet = new Set(upstreamChannels.all);
  const routedChannelSet = new Set(routedChannels);
  const duplicateUpstreamChannels = duplicatesIn(upstreamChannels.all);
  const duplicateRoutes = duplicatesIn(routedChannels);
  const unrouted = [...upstreamChannelSet]
    .filter((channel) => !routedChannelSet.has(channel))
    .sort();
  const unknownRoutes = [...routedChannelSet]
    .filter((channel) => !upstreamChannelSet.has(channel))
    .sort();

  // A duplex channel is request/response by declaration; a simplex one is a one-way send either way.
  const duplex = new Set(upstreamChannels.requestResponse);
  const misdirected = routes
    .filter((route) => upstreamChannelSet.has(route.channel))
    .filter((route) => duplex.has(route.channel) !== (route.direction === "request/response"))
    .map(
      (route) =>
        `${route.channel} — routed as "${route.direction}" but declared in ` +
        `${duplex.has(route.channel) ? "RequestResponseChannels" : "RequestChannels"}`,
    )
    .sort();

  console.log(
    `\n${upstreamChannelSet.size} upstream IPC channels ` +
      `(${upstreamChannels.request.length} request, ` +
      `${upstreamChannels.requestResponse.length} request/response)`,
  );
  console.log(`   ${routedChannelSet.size} have exactly one route in MIGRATION_MAP.md §7.1`);
  console.log(`   ${routes.length - misdirected.length} carry the direction upstream declares`);
  for (const channel of duplicateUpstreamChannels) console.log(`   DECLARED TWICE: ${channel}`);
  for (const channel of duplicateRoutes) console.log(`   ROUTED TWICE: ${channel}`);
  for (const channel of unrouted) console.log(`   NOT ROUTED: ${channel}`);
  for (const channel of unknownRoutes) console.log(`   UNKNOWN ROUTE: ${channel}`);
  for (const problem of misdirected) console.log(`   WRONG DIRECTION: ${problem}`);

  // Non-zero when something is uncovered, unexplained, or absent from a checked contract.
  const problems =
    buckets.missing.length +
    unexplained.length +
    duplicates.length +
    unwrapped.length +
    unread.length +
    duplicateUpstreamChannels.length +
    duplicateRoutes.length +
    unrouted.length +
    unknownRoutes.length +
    misdirected.length;
  process.exitCode = problems > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  measure();
}
