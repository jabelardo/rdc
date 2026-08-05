import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IMenu, MenuAction } from "../../models/app-menu";
import { getCurrentWindowZoomFactor } from "./window";

export function setNativeMenu(menu: IMenu): Promise<void> {
  return invoke("set_native_menu", { menu });
}

/**
 * An item in a native contextual menu. Callers pass plain objects;
 * {@linkcode showContextMenu} maps each to a wire item the Rust side builds a real menu item or
 * separator from.
 */
export type ContextMenuItem =
  | {
      readonly text: string;
      readonly enabled?: boolean;
      readonly action?: () => void;
      readonly type?: "item" | undefined;
    }
  | { readonly type: "separator" };

/**
 * Where a context menu should anchor, captured from the triggering pointer event.
 *
 * `x`/`y` are webview-viewport CSS pixels (`MouseEvent.clientX/clientY`) — zoom-invariant layout
 * coordinates. This side scales them by the zoom factor, which only it knows; the Rust side then
 * converts from webview- to window-relative, which only it can measure.
 */
export type ContextMenuPosition = { readonly x: number; readonly y: number };

const CONTEXT_MENU_EVENT = "context-menu-event";

/**
 * Releases the selection listener belonging to the menu opened before the current one.
 *
 * Note this drops the *listener*, not the menu — dismissing the previous native menu is the Rust
 * side's job. Only one context menu can be open at a time, and the popup is deliberately
 * fire-and-forget on Linux (see below), so there is no "menu dismissed" signal to unregister on:
 * opening the next menu is the reliable point to let the previous listener go.
 */
let releasePreviousMenuListener: (() => void) | null = null;

/** Serializes opens, so the listener always belongs to the menu actually on screen. */
let pendingOpen: Promise<unknown> = Promise.resolve();

/**
 * Show a contextual menu through the `show_context_menu_at` command.
 *
 * The item `action` callbacks stay here and never cross the IPC boundary: each item is given a
 * per-invocation id, and Rust reports back only which id was picked. Ids carry a random token so a
 * menu opened in one repository window cannot be mistaken for one opened in another — the
 * selection event is broadcast, not addressed to a single window.
 *
 * Awaiting this resolves when the popup has been *shown*, not when it has been dismissed: the
 * Linux path returns immediately by design, because muda's blocking popup is what wedged the app
 * on Wayland (see `src-tauri/src/platform/context_menu.rs`). So the selected action runs from the
 * event listener rather than after the `invoke` resolves.
 */
export function showContextMenu(
  items: ReadonlyArray<ContextMenuItem>,
  position: ContextMenuPosition,
): Promise<void> {
  if (items.length === 0) {
    return Promise.resolve();
  }
  // Showing a menu takes several IPC round-trips, so two quick triggers — a double-click on a
  // row's "more actions" button, say — can be in flight together and reach the Rust side in either
  // order. Whichever popup wins would then be the one whose ids have no listener, so every item in
  // the visible menu would silently do nothing. Queueing removes the interleaving entirely.
  const opened = pendingOpen.then(
    () => openContextMenu(items, position),
    () => openContextMenu(items, position),
  );
  pendingOpen = opened.catch(() => undefined);
  return opened;
}

async function openContextMenu(
  items: ReadonlyArray<ContextMenuItem>,
  position: ContextMenuPosition,
): Promise<void> {
  releasePreviousMenuListener?.();

  const token = Math.random().toString(36).slice(2);
  const actionById = new Map<string, () => void>();
  const wireItems = items.map((item, index) => {
    if (item.type === "separator") {
      return { type: "separator" as const };
    }
    const id = `${token}-${index}`;
    if (item.action !== undefined) {
      actionById.set(id, item.action);
    }
    return {
      type: "item" as const,
      id,
      label: item.text,
      enabled: item.enabled ?? true,
    };
  });

  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    if (releasePreviousMenuListener === dispose) {
      releasePreviousMenuListener = null;
    }
    unlisten?.();
    unlisten = null;
  };
  releasePreviousMenuListener = dispose;

  const registration = await listen<string>(CONTEXT_MENU_EVENT, (event) => {
    const action = actionById.get(event.payload);
    if (action === undefined) {
      return;
    }
    dispose();
    action();
  });
  if (disposed) {
    // A newer menu replaced this one while the listener was still being registered.
    registration();
    return;
  }
  unlisten = registration;

  const zoomFactor = await getCurrentWindowZoomFactor();
  await invoke("show_context_menu_at", {
    x: position.x * zoomFactor,
    y: position.y * zoomFactor,
    items: wireItems,
  });
}

export function selectAllWindowContents(): void {
  document.execCommand("selectAll");
}

/** macOS native menu action channel. */
export function onNativeMenuAction(callback: (action: MenuAction) => void): Promise<UnlistenFn> {
  return listen<MenuAction>("menu-event", (event) => callback(event.payload));
}
