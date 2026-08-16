/**
 * Which OS the renderer is running on, as the menu and window chrome need to know it.
 *
 * A model rather than part of the menu module, because it is not a menu concept: the platform
 * layer's double-click handling needs it too, and a shared module reaching into `app/` for a string
 * union is the dependency direction inverted over nothing.
 */
export type MenuPlatform = "macos" | "windows" | "linux";
