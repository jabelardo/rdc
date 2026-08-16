/**
 * Which OS the renderer is running on, as the menu and window chrome need to know it.
 *
 * A model rather than part of the menu module, because it is not a menu concept: the platform
 * layer's double-click handling needs it too, and a shared module reaching into `app/` for a string
 * union is the dependency direction inverted over nothing.
 */
export type MenuPlatform = "macos" | "windows" | "linux";

/**
 * Which OS this build is running on.
 *
 * Beside the type rather than in the menu module: the menu is its largest consumer, but the clone
 * dialog needs it to pick between a save panel and a directory picker, and a feature may not import
 * `app/`. The constants are Vite defines, so this is a compile-time answer.
 */
export function currentMenuPlatform(): MenuPlatform {
  return __DARWIN__ ? "macos" : __WIN32__ ? "windows" : "linux";
}
