use super::custom_integration::{expand_target_path_argument, parse_custom_integration_arguments};
use super::custom_integration_model::CustomIntegration;
pub use super::shell_model::FoundShell;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug)]
pub(crate) struct LinuxShellCandidate {
    pub(crate) name: &'static str,
    path: PathBuf,
}

#[cfg(any(target_os = "linux", test))]
impl LinuxShellCandidate {
    fn new(name: &'static str, path: &'static str) -> Self {
        Self {
            name,
            path: path.into(),
        }
    }
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_shell_candidates() -> Vec<LinuxShellCandidate> {
    vec![
        LinuxShellCandidate::new("GNOME Terminal", "/usr/bin/gnome-terminal"),
        LinuxShellCandidate::new("GNOME Console", "/usr/bin/kgx"),
        LinuxShellCandidate::new("Ptyxis", "/usr/bin/ptyxis"),
        LinuxShellCandidate::new("MATE Terminal", "/usr/bin/mate-terminal"),
        LinuxShellCandidate::new("Tilix", "/usr/bin/tilix"),
        LinuxShellCandidate::new("Terminator", "/usr/bin/terminator"),
        LinuxShellCandidate::new("URxvt", "/usr/bin/urxvt"),
        LinuxShellCandidate::new("Konsole", "/usr/bin/konsole"),
        LinuxShellCandidate::new("XTerm", "/usr/bin/xterm"),
        LinuxShellCandidate::new("Terminology", "/usr/bin/terminology"),
        LinuxShellCandidate::new("Deepin Terminal", "/usr/bin/deepin-terminal"),
        LinuxShellCandidate::new("Elementary Terminal", "/usr/bin/io.elementary.terminal"),
        LinuxShellCandidate::new("XFCE Terminal", "/usr/bin/xfce4-terminal"),
        LinuxShellCandidate::new("Alacritty", "/usr/bin/alacritty"),
        LinuxShellCandidate::new("Kitty", "/usr/bin/kitty"),
        LinuxShellCandidate::new("LXDE Terminal", "/usr/bin/lxterminal"),
        LinuxShellCandidate::new("Warp", "/usr/bin/warp-terminal"),
        LinuxShellCandidate::new("Black Box", "/usr/bin/blackbox-terminal"),
        LinuxShellCandidate::new("Ghostty", "/usr/bin/ghostty"),
        LinuxShellCandidate::new("COSMIC Terminal", "/usr/bin/cosmic-term"),
    ]
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn discover_linux_shells(
    candidates: &[LinuxShellCandidate],
    mut exists: impl FnMut(&Path) -> bool,
) -> Vec<FoundShell> {
    candidates
        .iter()
        .filter(|candidate| exists(&candidate.path))
        .map(|candidate| FoundShell {
            shell: candidate.name.to_owned(),
            path: candidate.path.clone(),
            bundle_id: None,
            extra_args: None,
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug)]
pub(crate) struct DarwinShellCandidate {
    name: &'static str,
    bundle_ids: Vec<&'static str>,
    executable: Option<&'static str>,
}

#[cfg(any(target_os = "macos", test))]
impl DarwinShellCandidate {
    fn new(
        name: &'static str,
        bundle_ids: &[&'static str],
        executable: Option<&'static str>,
    ) -> Self {
        Self {
            name,
            bundle_ids: bundle_ids.to_vec(),
            executable,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn darwin_shell_candidates() -> Vec<DarwinShellCandidate> {
    vec![
        DarwinShellCandidate::new("Terminal", &["com.apple.Terminal"], None),
        DarwinShellCandidate::new("Hyper", &["co.zeit.hyper"], None),
        DarwinShellCandidate::new("iTerm2", &["com.googlecode.iterm2"], None),
        DarwinShellCandidate::new("PowerShell Core", &["com.microsoft.powershell"], None),
        DarwinShellCandidate::new("Ghostty", &["com.mitchellh.ghostty"], None),
        DarwinShellCandidate::new(
            "Kitty",
            &["net.kovidgoyal.kitty"],
            Some("Contents/MacOS/kitty"),
        ),
        DarwinShellCandidate::new(
            "Alacritty",
            &["org.alacritty", "io.alacritty"],
            Some("Contents/MacOS/alacritty"),
        ),
        DarwinShellCandidate::new("Tabby", &["org.tabby"], Some("Contents/MacOS/Tabby")),
        DarwinShellCandidate::new(
            "WezTerm",
            &["com.github.wez.wezterm"],
            Some("Contents/MacOS/wezterm"),
        ),
        DarwinShellCandidate::new(
            "Warp",
            &["dev.warp.Warp-Stable"],
            Some("Contents/MacOS/stable"),
        ),
    ]
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn discover_darwin_shells(
    candidates: &[DarwinShellCandidate],
    mut locate: impl FnMut(&str) -> Vec<PathBuf>,
    mut exists: impl FnMut(&Path) -> bool,
) -> Vec<FoundShell> {
    candidates
        .iter()
        .filter_map(|candidate| {
            candidate.bundle_ids.iter().find_map(|bundle_id| {
                locate(bundle_id)
                    .into_iter()
                    .find(|path| exists(path))
                    .map(|application_path| FoundShell {
                        shell: candidate.name.to_owned(),
                        path: candidate.executable.map_or_else(
                            || application_path.clone(),
                            |path| application_path.join(path),
                        ),
                        bundle_id: Some((*bundle_id).to_owned()),
                        extra_args: None,
                    })
            })
        })
        .collect()
}

#[cfg(target_os = "linux")]
pub(crate) fn get_available_shells() -> Vec<FoundShell> {
    discover_linux_shells(&linux_shell_candidates(), Path::exists)
}

#[cfg(target_os = "macos")]
fn locate_bundle(bundle_id: &str) -> Vec<PathBuf> {
    let query = format!("kMDItemCFBundleIdentifier == '{bundle_id}'");
    match std::process::Command::new("/usr/bin/mdfind")
        .arg(query)
        .output()
    {
        Ok(output) if output.status.success() => {
            crate::platform::editors::parse_spotlight_paths(&output.stdout)
        }
        _ => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn get_available_shells() -> Vec<FoundShell> {
    discover_darwin_shells(&darwin_shell_candidates(), locate_bundle, Path::exists)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Debug)]
pub(crate) struct WindowsShellLocations {
    pub(crate) windows_directory: PathBuf,
    pub(crate) command_prompt: PathBuf,
    pub(crate) git: Option<PathBuf>,
    pub(crate) powershell: Option<PathBuf>,
    pub(crate) powershell_core: Option<PathBuf>,
    pub(crate) hyper: Option<PathBuf>,
    pub(crate) git_bash: Option<PathBuf>,
    pub(crate) cygwin: Option<PathBuf>,
    pub(crate) warp: Option<PathBuf>,
    pub(crate) wsl: Option<PathBuf>,
    pub(crate) alacritty: Option<PathBuf>,
    pub(crate) windows_terminal: Option<PathBuf>,
    pub(crate) fluent_terminal: Option<PathBuf>,
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn assemble_windows_shells(locations: WindowsShellLocations) -> Vec<FoundShell> {
    let extra_args = locations.git.as_ref().map_or_else(Vec::new, |git| {
        vec![
            "/K".to_owned(),
            format!(
                r#""{}\system32\doskey.exe git=^"{}^" $*""#,
                locations.windows_directory.display(),
                git.display()
            ),
        ]
    });
    let mut shells = vec![FoundShell {
        shell: "Command Prompt".to_owned(),
        path: locations.command_prompt,
        bundle_id: None,
        extra_args: Some(extra_args),
    }];

    for (shell, path) in [
        ("PowerShell", locations.powershell),
        ("PowerShell Core", locations.powershell_core),
        ("Hyper", locations.hyper),
        ("Git Bash", locations.git_bash),
        ("Cygwin", locations.cygwin),
        ("Warp", locations.warp),
        ("WSL", locations.wsl),
        ("Alacritty", locations.alacritty),
        ("Windows Terminal", locations.windows_terminal),
        ("Fluent Terminal", locations.fluent_terminal),
    ] {
        if let Some(path) = path {
            shells.push(FoundShell {
                shell: shell.to_owned(),
                path,
                bundle_id: None,
                extra_args: None,
            });
        }
    }

    shells
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShellLaunchPlatform {
    #[cfg(any(target_os = "linux", test))]
    Linux,
    #[cfg(any(target_os = "macos", test))]
    MacOs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ShellLaunchSpec {
    pub(crate) program: PathBuf,
    pub(crate) arguments: Vec<OsString>,
    pub(crate) current_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub(crate) enum ShellLaunchError {
    Missing(PathBuf),
    Unknown(String),
    #[cfg(any(target_os = "macos", test))]
    MissingBundleId(String),
    Io(std::io::Error),
}

impl fmt::Display for ShellLaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(path) => write!(
                formatter,
                "could not find shell executable at '{}'",
                path.display()
            ),
            Self::Unknown(shell) => write!(formatter, "unknown shell '{shell}'"),
            #[cfg(any(target_os = "macos", test))]
            Self::MissingBundleId(shell) => {
                write!(formatter, "macOS shell '{shell}' has no bundle identifier")
            }
            Self::Io(error) => write!(formatter, "could not launch shell: {error}"),
        }
    }
}

impl std::error::Error for ShellLaunchError {}

pub(crate) fn shell_launch_spec(
    platform: ShellLaunchPlatform,
    shell: &FoundShell,
    target: &Path,
) -> Result<ShellLaunchSpec, ShellLaunchError> {
    let target_text = target.as_os_str().to_owned();
    let direct = |arguments: Vec<OsString>, current_dir: Option<PathBuf>| ShellLaunchSpec {
        program: shell.path.clone(),
        arguments,
        current_dir,
    };

    match platform {
        #[cfg(any(target_os = "linux", test))]
        ShellLaunchPlatform::Linux => {
            let arguments = match shell.shell.as_str() {
                "GNOME Terminal" | "GNOME Console" | "MATE Terminal" | "Tilix" | "Terminator"
                | "XFCE Terminal" | "Alacritty" | "Black Box" | "COSMIC Terminal" => {
                    vec![OsString::from("--working-directory"), target_text]
                }
                "Ptyxis" => vec![
                    OsString::from("--new-window"),
                    OsString::from("--working-directory"),
                    target_text,
                ],
                "URxvt" => vec![OsString::from("-cd"), target_text],
                "Konsole" => vec![OsString::from("--workdir"), target_text],
                "XTerm" => {
                    return Ok(direct(
                        vec![OsString::from("-e"), OsString::from("/bin/bash")],
                        Some(target.to_owned()),
                    ));
                }
                "Terminology" => vec![OsString::from("-d"), target_text],
                "Deepin Terminal" | "Elementary Terminal" => {
                    vec![OsString::from("-w"), target_text]
                }
                "Kitty" => vec![
                    OsString::from("--single-instance"),
                    OsString::from("--directory"),
                    target_text,
                ],
                "LXDE Terminal" | "Ghostty" => {
                    vec![OsString::from(format!(
                        "--working-directory={}",
                        target.display()
                    ))]
                }
                "Warp" => return Ok(direct(Vec::new(), Some(target.to_owned()))),
                unknown => return Err(ShellLaunchError::Unknown(unknown.to_owned())),
            };
            Ok(direct(arguments, None))
        }
        #[cfg(any(target_os = "macos", test))]
        ShellLaunchPlatform::MacOs => {
            let arguments = match shell.shell.as_str() {
                "Kitty" => vec![
                    OsString::from("--single-instance"),
                    OsString::from("--directory"),
                    target_text,
                ],
                "Alacritty" => vec![OsString::from("--working-directory"), target_text],
                "Tabby" => vec![OsString::from("open"), target_text],
                "WezTerm" => vec![
                    OsString::from("start"),
                    OsString::from("--cwd"),
                    target_text,
                ],
                "Terminal" | "Hyper" | "iTerm2" | "PowerShell Core" | "Warp" | "Ghostty" => {
                    let bundle_id = shell
                        .bundle_id
                        .as_ref()
                        .ok_or_else(|| ShellLaunchError::MissingBundleId(shell.shell.clone()))?;
                    return Ok(ShellLaunchSpec {
                        program: "/usr/bin/open".into(),
                        arguments: vec![
                            OsString::from("-b"),
                            OsString::from(bundle_id),
                            target_text,
                        ],
                        current_dir: None,
                    });
                }
                unknown => return Err(ShellLaunchError::Unknown(unknown.to_owned())),
            };
            Ok(direct(arguments, None))
        }
    }
}

pub(crate) async fn launch_shell(
    shell: FoundShell,
    target: PathBuf,
) -> Result<(), ShellLaunchError> {
    if !tokio::fs::try_exists(&shell.path)
        .await
        .map_err(ShellLaunchError::Io)?
    {
        return Err(ShellLaunchError::Missing(shell.path));
    }

    #[cfg(target_os = "linux")]
    let platform = ShellLaunchPlatform::Linux;
    #[cfg(target_os = "macos")]
    let platform = ShellLaunchPlatform::MacOs;
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err(ShellLaunchError::Unknown(
        "shell launching is not implemented on this platform".to_owned(),
    ));

    spawn_shell(shell_launch_spec(platform, &shell, &target)?)
}

pub(crate) async fn launch_custom_shell(
    custom_shell: CustomIntegration,
    target: PathBuf,
) -> Result<(), ShellLaunchError> {
    if !tokio::fs::try_exists(&custom_shell.path)
        .await
        .map_err(ShellLaunchError::Io)?
    {
        return Err(ShellLaunchError::Missing(custom_shell.path));
    }
    let target_text = target.to_str().ok_or_else(|| {
        ShellLaunchError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "shell target path is not valid Unicode and cannot cross IPC",
        ))
    })?;
    let arguments =
        parse_custom_integration_arguments(&custom_shell.arguments).map_err(|error| {
            ShellLaunchError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, error))
        })?;
    let arguments = expand_target_path_argument(arguments, target_text)
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();

    #[cfg(target_os = "macos")]
    let spec = if let Some(bundle_id) = custom_shell.bundle_id {
        let mut open_arguments = vec![OsString::from("-b"), OsString::from(bundle_id)];
        open_arguments.extend(arguments);
        ShellLaunchSpec {
            program: "/usr/bin/open".into(),
            arguments: open_arguments,
            current_dir: None,
        }
    } else {
        ShellLaunchSpec {
            program: custom_shell.path,
            arguments,
            current_dir: None,
        }
    };
    #[cfg(target_os = "linux")]
    let spec = ShellLaunchSpec {
        program: custom_shell.path,
        arguments,
        current_dir: None,
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err(ShellLaunchError::Unknown(
        "custom shell launching is not implemented on this platform".to_owned(),
    ));

    spawn_shell(spec)
}

fn spawn_shell(spec: ShellLaunchSpec) -> Result<(), ShellLaunchError> {
    let mut command = tokio::process::Command::new(&spec.program);
    command
        .args(&spec.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    if let Some(current_dir) = spec.current_dir {
        command.current_dir(current_dir);
    }

    let mut child = command.spawn().map_err(ShellLaunchError::Io)?;
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        assemble_windows_shells, darwin_shell_candidates, discover_darwin_shells,
        discover_linux_shells, linux_shell_candidates, shell_launch_spec, ShellLaunchPlatform,
        WindowsShellLocations,
    };
    use crate::platform::shell_model::FoundShell;
    use std::collections::HashSet;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    #[test]
    fn linux_discovery_preserves_upstream_order_and_exact_paths() {
        let candidates = linux_shell_candidates();
        let existing = HashSet::from([
            "/usr/bin/gnome-terminal",
            "/usr/bin/konsole",
            "/usr/bin/ghostty",
        ]);

        let found = discover_linux_shells(&candidates, |path| {
            existing.contains(path.to_string_lossy().as_ref())
        });

        assert_eq!(
            found,
            vec![
                FoundShell {
                    shell: "GNOME Terminal".to_owned(),
                    path: "/usr/bin/gnome-terminal".into(),
                    bundle_id: None,
                    extra_args: None,
                },
                FoundShell {
                    shell: "Konsole".to_owned(),
                    path: "/usr/bin/konsole".into(),
                    bundle_id: None,
                    extra_args: None,
                },
                FoundShell {
                    shell: "Ghostty".to_owned(),
                    path: "/usr/bin/ghostty".into(),
                    bundle_id: None,
                    extra_args: None,
                },
            ]
        );
    }

    #[test]
    fn linux_candidate_table_includes_recent_upstream_terminals() {
        let candidates = linux_shell_candidates();
        let labels = candidates
            .iter()
            .map(|candidate| candidate.name)
            .collect::<HashSet<_>>();

        assert!(labels.contains("Ptyxis"));
        assert!(labels.contains("Warp"));
        assert!(labels.contains("Black Box"));
        assert!(labels.contains("Ghostty"));
        assert!(labels.contains("COSMIC Terminal"));
    }

    #[test]
    fn macos_discovery_uses_bundle_fallbacks_and_internal_executables() {
        let mut looked_up = Vec::new();
        let found = discover_darwin_shells(
            &darwin_shell_candidates(),
            |bundle_id| {
                looked_up.push(bundle_id.to_owned());
                match bundle_id {
                    "com.apple.Terminal" => vec!["/Applications/Terminal.app".into()],
                    "org.alacritty" => vec!["/missing/Alacritty.app".into()],
                    "io.alacritty" => vec!["/Applications/Alacritty.app".into()],
                    "com.mitchellh.ghostty" => vec!["/Applications/Ghostty.app".into()],
                    _ => Vec::new(),
                }
            },
            |path| path.starts_with(Path::new("/Applications")),
        );

        assert_eq!(
            found,
            vec![
                FoundShell {
                    shell: "Terminal".to_owned(),
                    path: "/Applications/Terminal.app".into(),
                    bundle_id: Some("com.apple.Terminal".to_owned()),
                    extra_args: None,
                },
                FoundShell {
                    shell: "Ghostty".to_owned(),
                    path: "/Applications/Ghostty.app".into(),
                    bundle_id: Some("com.mitchellh.ghostty".to_owned()),
                    extra_args: None,
                },
                FoundShell {
                    shell: "Alacritty".to_owned(),
                    path: "/Applications/Alacritty.app/Contents/MacOS/alacritty".into(),
                    bundle_id: Some("io.alacritty".to_owned()),
                    extra_args: None,
                },
            ]
        );
        assert!(looked_up
            .windows(2)
            .any(|ids| { ids == ["org.alacritty".to_owned(), "io.alacritty".to_owned()] }));
    }

    #[test]
    fn windows_discovery_includes_every_upstream_candidate_in_order() {
        let found = assemble_windows_shells(WindowsShellLocations {
            windows_directory: r"C:\Windows".into(),
            command_prompt: r"C:\Windows\System32\cmd.exe".into(),
            git: Some(r"C:\Program Files\Git\cmd\git.exe".into()),
            powershell: Some(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into()),
            powershell_core: Some(r"C:\Program Files\PowerShell\7\pwsh.exe".into()),
            hyper: Some(r"C:\Users\test\AppData\Local\hyper\Hyper.exe".into()),
            git_bash: Some(r"C:\Program Files\Git\git-bash.exe".into()),
            cygwin: Some(r"C:\cygwin64\bin\mintty.exe".into()),
            warp: Some(r"C:\Program Files\Warp\warp.exe".into()),
            wsl: Some(r"C:\Windows\System32\wsl.exe".into()),
            alacritty: Some(r"C:\Program Files\Alacritty\alacritty.exe".into()),
            windows_terminal: Some(
                r"C:\Users\test\AppData\Local\Microsoft\WindowsApps\wt.exe".into(),
            ),
            fluent_terminal: Some(
                r"C:\Users\test\AppData\Local\Microsoft\WindowsApps\flute.exe".into(),
            ),
        });

        assert_eq!(
            found
                .iter()
                .map(|shell| shell.shell.as_str())
                .collect::<Vec<_>>(),
            [
                "Command Prompt",
                "PowerShell",
                "PowerShell Core",
                "Hyper",
                "Git Bash",
                "Cygwin",
                "Warp",
                "WSL",
                "Alacritty",
                "Windows Terminal",
                "Fluent Terminal",
            ]
        );
        assert_eq!(
            found[0].extra_args.as_deref(),
            Some(
                [
                    "/K".to_owned(),
                    r#""C:\Windows\system32\doskey.exe git=^"C:\Program Files\Git\cmd\git.exe^" $*""#
                        .to_owned(),
                ]
                .as_slice()
            )
        );
    }

    #[test]
    fn linux_launch_specs_preserve_each_terminal_family() {
        for (shell, arguments, current_dir) in [
            ("GNOME Terminal", vec!["--working-directory", "/repo"], None),
            (
                "Ptyxis",
                vec!["--new-window", "--working-directory", "/repo"],
                None,
            ),
            ("URxvt", vec!["-cd", "/repo"], None),
            ("Konsole", vec!["--workdir", "/repo"], None),
            ("XTerm", vec!["-e", "/bin/bash"], Some("/repo")),
            ("Terminology", vec!["-d", "/repo"], None),
            ("Deepin Terminal", vec!["-w", "/repo"], None),
            (
                "Kitty",
                vec!["--single-instance", "--directory", "/repo"],
                None,
            ),
            ("LXDE Terminal", vec!["--working-directory=/repo"], None),
            ("Warp", vec![], Some("/repo")),
            ("Ghostty", vec!["--working-directory=/repo"], None),
        ] {
            let spec = shell_launch_spec(
                ShellLaunchPlatform::Linux,
                &found_shell(shell, None),
                Path::new("/repo"),
            )
            .expect("known Linux shell");
            assert_eq!(
                spec.arguments,
                arguments
                    .into_iter()
                    .map(OsString::from)
                    .collect::<Vec<_>>(),
                "{shell}"
            );
            assert_eq!(spec.current_dir, current_dir.map(PathBuf::from), "{shell}");
        }
    }

    #[test]
    fn macos_launch_specs_use_internal_executables_or_bundle_open() {
        for (shell, arguments) in [
            ("Alacritty", vec!["--working-directory", "/repo"]),
            ("Tabby", vec!["open", "/repo"]),
            ("WezTerm", vec!["start", "--cwd", "/repo"]),
            ("Kitty", vec!["--single-instance", "--directory", "/repo"]),
        ] {
            let spec = shell_launch_spec(
                ShellLaunchPlatform::MacOs,
                &found_shell(shell, Some("example.bundle")),
                Path::new("/repo"),
            )
            .expect("known macOS shell");
            assert_eq!(spec.program, PathBuf::from("/terminal"));
            assert_eq!(
                spec.arguments,
                arguments
                    .into_iter()
                    .map(OsString::from)
                    .collect::<Vec<_>>()
            );
        }

        let terminal = shell_launch_spec(
            ShellLaunchPlatform::MacOs,
            &found_shell("Terminal", Some("com.apple.Terminal")),
            Path::new("/repo"),
        )
        .expect("Terminal");
        assert_eq!(terminal.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            terminal.arguments,
            ["-b", "com.apple.Terminal", "/repo"].map(OsString::from)
        );
    }

    fn found_shell(shell: &str, bundle_id: Option<&str>) -> FoundShell {
        FoundShell {
            shell: shell.to_owned(),
            path: "/terminal".into(),
            bundle_id: bundle_id.map(str::to_owned),
            extra_args: None,
        }
    }
}
