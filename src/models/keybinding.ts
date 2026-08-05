import type { MenuIDs } from "./menu-ids";

export type KeybindingModifier = "alt" | "control" | "meta" | "shift";

/** A parsed binding shared by the native menu and frontend keyboard dispatcher. */
export interface Keybinding {
  readonly modifiers: ReadonlyArray<KeybindingModifier>;
  /** A physical key in the shared muda/KeyboardEvent.code vocabulary, such as `KeyP` or `Comma`. */
  readonly key: string;
}

export type MenuKeybindings = Readonly<Partial<Record<MenuIDs, Keybinding>>>;
