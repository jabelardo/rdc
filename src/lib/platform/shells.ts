import { invoke } from "@tauri-apps/api/core";
import type { ICustomIntegration } from "../../models/custom-integration";
import type { FoundShell, Shell } from "../../models/shell";

/** Resolve terminal applications installed on this machine. */
export function getAvailableShells(): Promise<ReadonlyArray<FoundShell>> {
  return invoke<ReadonlyArray<FoundShell>>("get_available_shells");
}

export async function findShellOrDefault(shell: Shell): Promise<FoundShell> {
  const available = await getAvailableShells();
  const found = available.find((candidate) => candidate.shell === shell);
  const fallback = found ?? available[0];

  if (fallback === undefined) {
    throw new Error("No terminal application is available");
  }

  return fallback;
}

export function launchShell(shell: FoundShell, path: string): Promise<void> {
  return invoke("launch_shell", { shell, path });
}

export function launchCustomShell(customShell: ICustomIntegration, path: string): Promise<void> {
  return invoke("launch_custom_shell", { customShell, path });
}
