export type TitleBarStyle = 'native' | 'custom' | 'native-without-menu-bar'

export type MainProcessConfig = {
  readonly titleBarStyle: TitleBarStyle
  readonly hideWindowOnQuit: boolean
}
