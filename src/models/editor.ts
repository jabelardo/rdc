/** An installed external editor, in the shape consumed by the ported preferences and store code. */
export interface FoundEditor {
  /** Friendly user-facing name. */
  readonly editor: string;

  /** Executable or application path used to launch it. */
  readonly path: string;
}
