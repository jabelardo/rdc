/**
 * Configuration for a user-specified external tool (editor or shell).
 *
 * MIGRATION NOTE (layering fix): in desktop-plus this interface lived in
 * `lib/custom-integration.ts`, alongside the code that actually *launches* the tool — which imports
 * `child_process`, `fs`, `fs/promises`, `util` and `windows-argv-parser`. `models/editor-override.ts`
 * needs only the shape, and through it `models/repository.ts` inherited that entire Node
 * dependency tree.
 *
 * The launching half belongs in Rust and lands with the shells/editors work in Phase 4; this is just
 * the record describing what to launch.
 */
export interface ICustomIntegration {
  /** The path to the custom integration */
  readonly path: string
  /** The arguments to pass to the custom integration */
  readonly arguments: string
  /** The bundle ID of the custom integration (macOS only) */
  readonly bundleID?: string
}

/** Result of checking whether a custom tool path can be launched. */
export interface ICustomIntegrationPathValidation {
  readonly isValid: boolean
  /** Present only for a valid macOS application bundle. */
  readonly bundleID?: string
}
