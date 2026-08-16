import { invoke } from "@tauri-apps/api/core";

/** The path for the installed command line launcher. */
export const InstalledCLIPath = "/usr/local/bin/rdc";

/** Install the command line launcher on macOS. */
export function installCLI(): Promise<void> {
  return invoke("install_darwin_cli");
}
