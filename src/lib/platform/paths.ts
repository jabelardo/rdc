import { invoke } from '@tauri-apps/api/core'
import {
  appDataDir,
  appLogDir,
  audioDir,
  dataDir,
  desktopDir,
  documentDir,
  downloadDir,
  homeDir,
  pictureDir,
  resourceDir,
  tempDir,
  videoDir,
} from '@tauri-apps/api/path'
import { arch } from '@tauri-apps/plugin-os'

export type AppPathName =
  | 'home'
  | 'appData'
  | 'userData'
  | 'temp'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'logs'

export type Architecture = 'x64' | 'arm64' | 'x64-emulated'

const pathResolvers: Readonly<Record<AppPathName, () => Promise<string>>> = {
  home: homeDir,
  appData: dataDir,
  userData: appDataDir,
  temp: tempDir,
  desktop: desktopDir,
  documents: documentDir,
  downloads: downloadDir,
  music: audioDir,
  pictures: pictureDir,
  videos: videoDir,
  logs: appLogDir,
}

/** Electron's app.getPath replacement for every name its renderer consumes. */
export function getPath(name: AppPathName): Promise<string> {
  return pathResolvers[name]()
}

/** Electron's app path contains packaged resources, which is Tauri's resource directory. */
export function getAppPathProxy(): Promise<string> {
  return resourceDir()
}

export function getExecPath(): Promise<string> {
  return invoke<string>('get_exec_path')
}

export function isRunningUnderARM64Translation(): Promise<boolean> {
  return invoke<boolean>('is_running_under_arm64_translation')
}

export async function getAppArchitecture(): Promise<Architecture> {
  if (await isRunningUnderARM64Translation()) {
    return 'x64-emulated'
  }

  return arch() === 'aarch64' ? 'arm64' : 'x64'
}
