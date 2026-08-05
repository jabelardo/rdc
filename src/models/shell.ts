/**
 * Terminal labels persisted by desktop-plus across Linux, macOS, and Windows.
 *
 * Windows runtime support is Phase 10, but its stored values belong in the shared domain contract now
 * so settings survive a platform move and the later implementation cannot silently rename them.
 */
export enum Shell {
  Terminal = "Terminal",
  Hyper = "Hyper",
  iTerm2 = "iTerm2",
  PowerShellCore = "PowerShell Core",
  Kitty = "Kitty",
  Alacritty = "Alacritty",
  Tabby = "Tabby",
  WezTerm = "WezTerm",
  Warp = "Warp",
  Ghostty = "Ghostty",
  Gnome = "GNOME Terminal",
  GnomeConsole = "GNOME Console",
  Ptyxis = "Ptyxis",
  Mate = "MATE Terminal",
  Tilix = "Tilix",
  Terminator = "Terminator",
  Urxvt = "URxvt",
  Konsole = "Konsole",
  Xterm = "XTerm",
  Terminology = "Terminology",
  Deepin = "Deepin Terminal",
  Elementary = "Elementary Terminal",
  XFCE = "XFCE Terminal",
  LXTerminal = "LXDE Terminal",
  BlackBox = "Black Box",
  Cosmic = "COSMIC Terminal",
  Cmd = "Command Prompt",
  PowerShell = "PowerShell",
  GitBash = "Git Bash",
  Cygwin = "Cygwin",
  WSL = "WSL",
  WindowsTerminal = "Windows Terminal",
  FluentTerminal = "Fluent Terminal",
}

export interface FoundShell {
  readonly shell: Shell;
  readonly path: string;
  readonly bundleID?: string;
  readonly extraArgs?: ReadonlyArray<string>;
}
