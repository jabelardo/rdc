import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Keybinding, MenuKeybindings } from "../../models/keybinding";
import type { MenuIDs } from "../../models/menu-ids";

const keybindingsChangedEvent = "keybindings-changed";

/** Load platform-resolved defaults merged with the user's persisted overrides. */
export function getKeybindings(): Promise<MenuKeybindings> {
  return invoke<MenuKeybindings>("get_keybindings");
}

/**
 * Persist one override and return the complete conflict-checked map.
 *
 * `binding.key` is a physical `KeyboardEvent.code`, not a layout-dependent `KeyboardEvent.key`.
 */
export function setKeybinding(menuId: MenuIDs, binding: Keybinding): Promise<MenuKeybindings> {
  return invoke<MenuKeybindings>("set_keybinding", { menuId, binding });
}

/** Remove every override and return the platform defaults. */
export function resetKeybindings(): Promise<MenuKeybindings> {
  return invoke<MenuKeybindings>("reset_keybindings");
}

export function onKeybindingsChanged(
  callback: (keybindings: MenuKeybindings) => void,
): Promise<UnlistenFn> {
  return listen<MenuKeybindings>(keybindingsChangedEvent, (event) => callback(event.payload));
}
