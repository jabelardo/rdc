import { invoke } from '@tauri-apps/api/core'

function setItem(key: string, login: string, value: string): Promise<void> {
  return invoke('set_credential', { service: key, login, value })
}

function getItem(key: string, login: string): Promise<string | null> {
  return invoke<string | null>('get_credential', { service: key, login })
}

function deleteItem(key: string, login: string): Promise<boolean> {
  return invoke<boolean>('delete_credential', { service: key, login })
}

export const TokenStore = { setItem, getItem, deleteItem }
