import { invoke } from "@tauri-apps/api/core";
import type { MainProcessConfig } from "../../models/main-process-config";

export function getMainProcessConfig(): Promise<MainProcessConfig> {
  return invoke<MainProcessConfig>("get_main_process_config");
}

export function updateMainProcessConfig(
  configDiff: Partial<MainProcessConfig>,
): Promise<MainProcessConfig> {
  return invoke<MainProcessConfig>("update_main_process_config", {
    configDiff,
  });
}
