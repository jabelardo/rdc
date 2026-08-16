import { invoke } from "@tauri-apps/api/core";

export function getGUID(): Promise<string> {
  return invoke<string>("get_guid");
}

export function saveGUID(guid: string): Promise<void> {
  return invoke("save_guid", { guid });
}
