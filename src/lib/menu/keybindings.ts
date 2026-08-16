import type { AppMenu, ExecutableMenuItem } from "@/models/app-menu";
import type { Keybinding, KeybindingModifier, MenuKeybindings } from "@/models/keybinding";

export type KeybindingDisplayPlatform = "macos" | "windows" | "linux";

type KeyboardEventLike = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export function matchesKeybinding(event: KeyboardEventLike, binding: Keybinding): boolean {
  const modifiers = new Set(binding.modifiers);
  return (
    event.code === binding.key &&
    event.altKey === modifiers.has("alt") &&
    event.ctrlKey === modifiers.has("control") &&
    event.metaKey === modifiers.has("meta") &&
    event.shiftKey === modifiers.has("shift")
  );
}

/**
 * Resolve a keydown against the authoritative binding map and current menu
 * state. Disabled and hidden actions must behave like disabled native menu
 * accelerators.
 */
export function findMenuItemForKeybinding(
  event: KeyboardEventLike,
  menu: AppMenu,
  bindings: MenuKeybindings,
): ExecutableMenuItem | undefined {
  for (const [id, binding] of Object.entries(bindings)) {
    if (binding === undefined || !matchesKeybinding(event, binding)) {
      continue;
    }
    const item = menu.getItemById(id);
    if (
      item !== undefined &&
      item.type !== "separator" &&
      item.type !== "submenuItem" &&
      item.enabled &&
      item.visible
    ) {
      return item;
    }
  }
  return undefined;
}

type KeybindingDispatcherState = {
  readonly menu: AppMenu;
  readonly bindings: MenuKeybindings;
};

/**
 * Install the Linux/Windows accelerator dispatcher in the capture phase so
 * Chromium cannot consume shortcuts such as Ctrl+A before the app menu sees
 * them. macOS uses the native menu and must not install this listener.
 */
export function installKeybindingDispatcher(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  getState: () => KeybindingDispatcherState,
  execute: (item: ExecutableMenuItem) => void,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    const { menu, bindings } = getState();
    const item = findMenuItemForKeybinding(event, menu, bindings);
    if (item === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    execute(item);
  };

  target.addEventListener("keydown", onKeyDown, true);
  return () => target.removeEventListener("keydown", onKeyDown, true);
}

export function friendlyKeybindingText(
  binding: Keybinding,
  platform: KeybindingDisplayPlatform,
): string {
  const parts: string[] = binding.modifiers.map((modifier) => friendlyModifier(modifier, platform));
  parts.push(friendlyKey(binding.key, platform));
  return parts.join(platform === "macos" ? "" : "+");
}

function friendlyModifier(modifier: KeybindingModifier, platform: KeybindingDisplayPlatform) {
  if (platform === "macos") {
    switch (modifier) {
      case "alt":
        return "⌥";
      case "control":
        return "⌃";
      case "meta":
        return "⌘";
      case "shift":
        return "⇧";
    }
  }
  switch (modifier) {
    case "alt":
      return "Alt";
    case "control":
      return "Ctrl";
    case "meta":
      return "Meta";
    case "shift":
      return "Shift";
  }
}

function friendlyKey(key: string, platform: KeybindingDisplayPlatform) {
  if (/^Key[A-Z]$/.test(key)) {
    return key.slice(3);
  }
  if (/^Digit[0-9]$/.test(key)) {
    return key.slice(5);
  }
  const labels: Readonly<Record<string, string>> = {
    Backquote: "`",
    Backslash: "\\",
    Backspace: platform === "macos" ? "⌫" : "Backspace",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Delete: platform === "macos" ? "⌦" : "Delete",
    Enter: platform === "macos" ? "↩" : "Enter",
    Equal: "=",
    Escape: platform === "macos" ? "⎋" : "Esc",
    Minus: "-",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    Slash: "/",
    Space: "Space",
    Tab: platform === "macos" ? "⇥" : "Tab",
  };
  return labels[key] ?? key;
}
