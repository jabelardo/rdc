pub use super::editor_model::FoundEditor;
use std::ffi::OsString;
use std::fmt;
#[cfg(any(target_os = "linux", target_os = "macos", test))]
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug)]
pub(crate) struct EditorCandidate {
    name: &'static str,
    paths: Vec<PathBuf>,
}

#[cfg(any(target_os = "linux", test))]
impl EditorCandidate {
    fn new(name: &'static str, paths: &[&str]) -> Self {
        Self {
            name,
            paths: paths.iter().map(PathBuf::from).collect(),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug)]
pub(crate) struct DarwinEditorCandidate {
    name: &'static str,
    bundle_ids: Vec<&'static str>,
}

#[cfg(any(target_os = "macos", test))]
impl DarwinEditorCandidate {
    fn new(name: &'static str, bundle_ids: &[&'static str]) -> Self {
        Self {
            name,
            bundle_ids: bundle_ids.to_vec(),
        }
    }
}

/// The macOS editor table from desktop-plus, in preference order.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn darwin_editor_candidates() -> Vec<DarwinEditorCandidate> {
    vec![
        DarwinEditorCandidate::new("Atom", &["com.github.atom"]),
        DarwinEditorCandidate::new("Aptana Studio", &["aptana.studio"]),
        DarwinEditorCandidate::new("Eclipse IDE for Java Developers", &["epp.package.java"]),
        DarwinEditorCandidate::new(
            "Eclipse IDE for Enterprise Java and Web Developers",
            &["epp.package.jee"],
        ),
        DarwinEditorCandidate::new("Eclipse IDE for C/C++ Developers", &["epp.package.cpp"]),
        DarwinEditorCandidate::new(
            "Eclipse IDE for Eclipse Committers",
            &["epp.package.committers"],
        ),
        DarwinEditorCandidate::new(
            "Eclipse IDE for Embedded C/C++ Developers",
            &["epp.package.embedcpp"],
        ),
        DarwinEditorCandidate::new("Eclipse IDE for PHP Developers", &["epp.package.php"]),
        DarwinEditorCandidate::new(
            "Eclipse IDE for Java and DSL Developers",
            &["epp.package.dsl"],
        ),
        DarwinEditorCandidate::new(
            "Eclipse IDE for RCP and RAP Developers",
            &["epp.package.rcp"],
        ),
        DarwinEditorCandidate::new("Eclipse Modeling Tools", &["epp.package.modeling"]),
        DarwinEditorCandidate::new(
            "Eclipse IDE for Scientific Computing",
            &["epp.package.parallel"],
        ),
        DarwinEditorCandidate::new("Eclipse IDE for Scout Developers", &["epp.package.scout"]),
        DarwinEditorCandidate::new("MacVim", &["org.vim.MacVim"]),
        DarwinEditorCandidate::new("Neovide", &["com.neovide.neovide"]),
        DarwinEditorCandidate::new("VimR", &["com.qvacua.VimR"]),
        DarwinEditorCandidate::new("Visual Studio Code", &["com.microsoft.VSCode"]),
        DarwinEditorCandidate::new(
            "Visual Studio Code (Insiders)",
            &["com.microsoft.VSCodeInsiders"],
        ),
        DarwinEditorCandidate::new("VSCodium", &["com.visualstudio.code.oss", "com.vscodium"]),
        DarwinEditorCandidate::new(
            "Sublime Text",
            &[
                "com.sublimetext.4",
                "com.sublimetext.3",
                "com.sublimetext.2",
            ],
        ),
        DarwinEditorCandidate::new("BBEdit", &["com.barebones.bbedit"]),
        DarwinEditorCandidate::new("PhpStorm", &["com.jetbrains.PhpStorm"]),
        DarwinEditorCandidate::new("PyCharm", &["com.jetbrains.PyCharm"]),
        DarwinEditorCandidate::new("PyCharm Community Edition", &["com.jetbrains.pycharm.ce"]),
        DarwinEditorCandidate::new("DataSpell", &["com.jetbrains.DataSpell"]),
        DarwinEditorCandidate::new("RubyMine", &["com.jetbrains.RubyMine"]),
        DarwinEditorCandidate::new("RustRover", &["com.jetbrains.RustRover"]),
        DarwinEditorCandidate::new("RStudio", &["org.rstudio.RStudio", "com.rstudio.desktop"]),
        DarwinEditorCandidate::new("TextMate", &["com.macromates.TextMate"]),
        DarwinEditorCandidate::new("Brackets", &["io.brackets.appshell"]),
        DarwinEditorCandidate::new("WebStorm", &["com.jetbrains.WebStorm"]),
        DarwinEditorCandidate::new("CLion", &["com.jetbrains.CLion"]),
        DarwinEditorCandidate::new("Typora", &["abnerworks.Typora"]),
        DarwinEditorCandidate::new("CodeRunner", &["com.krill.CodeRunner"]),
        DarwinEditorCandidate::new(
            "SlickEdit",
            &[
                "com.slickedit.SlickEditPro2018",
                "com.slickedit.SlickEditPro2017",
                "com.slickedit.SlickEditPro2016",
                "com.slickedit.SlickEditPro2015",
            ],
        ),
        DarwinEditorCandidate::new("IntelliJ", &["com.jetbrains.intellij"]),
        DarwinEditorCandidate::new("IntelliJ Community Edition", &["com.jetbrains.intellij.ce"]),
        DarwinEditorCandidate::new("Xcode", &["com.apple.dt.Xcode"]),
        DarwinEditorCandidate::new("GoLand", &["com.jetbrains.goland"]),
        DarwinEditorCandidate::new("Android Studio", &["com.google.android.studio"]),
        DarwinEditorCandidate::new("Rider", &["com.jetbrains.rider"]),
        DarwinEditorCandidate::new("Nova", &["com.panic.Nova"]),
        DarwinEditorCandidate::new("Emacs", &["org.gnu.Emacs"]),
        DarwinEditorCandidate::new("Lite XL", &["com.lite-xl"]),
        DarwinEditorCandidate::new("Fleet", &["Fleet.app"]),
        DarwinEditorCandidate::new("Pulsar", &["dev.pulsar-edit.pulsar"]),
        DarwinEditorCandidate::new("Zed", &["dev.zed.Zed"]),
        DarwinEditorCandidate::new("Zed (Preview)", &["dev.zed.Zed-Preview"]),
        DarwinEditorCandidate::new("Cursor", &["com.todesktop.230313mzl4w4u92"]),
        DarwinEditorCandidate::new("Windsurf", &["com.exafunction.windsurf"]),
    ]
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_spotlight_paths(stdout: &[u8]) -> Vec<PathBuf> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn discover_darwin_editors(
    candidates: &[DarwinEditorCandidate],
    mut locate: impl FnMut(&str) -> Vec<PathBuf>,
    mut exists: impl FnMut(&Path) -> bool,
) -> Vec<FoundEditor> {
    candidates
        .iter()
        .filter_map(|candidate| {
            candidate.bundle_ids.iter().find_map(|bundle_id| {
                locate(bundle_id)
                    .into_iter()
                    .find(|path| exists(path))
                    .map(|path| FoundEditor {
                        editor: candidate.name.to_owned(),
                        path,
                    })
            })
        })
        .collect()
}

/// The Linux editor table from desktop-plus, in preference order.
///
/// Keeping this as data lets tests verify discovery without depending on what happens to be installed
/// on the developer's machine. Windows is deliberately deferred with Windows support; macOS gets its
/// bundle-id based table in the next part of this slice.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_editor_candidates(home: Option<&Path>) -> Vec<EditorCandidate> {
    let mut candidates = vec![
        EditorCandidate::new("Atom", &["/snap/bin/atom", "/usr/bin/atom"]),
        EditorCandidate::new("Neovim", &["/usr/bin/nvim"]),
        EditorCandidate::new("Neovim-Qt", &["/usr/bin/nvim-qt"]),
        EditorCandidate::new("Neovide", &["/usr/bin/neovide"]),
        EditorCandidate::new("gVim", &["/usr/bin/gvim"]),
        EditorCandidate::new(
            "Visual Studio Code",
            &[
                "/usr/share/code/bin/code",
                "/snap/bin/code",
                "/usr/bin/code",
                "/mnt/c/Program Files/Microsoft VS Code/bin/code",
                "/var/lib/flatpak/app/com.visualstudio.code/current/active/export/bin/com.visualstudio.code",
            ],
        ),
        EditorCandidate::new(
            "Visual Studio Code (Insiders)",
            &[
                "/snap/bin/code-insiders",
                "/usr/bin/code-insiders",
                "/var/lib/flatpak/app/com.visualstudio.code.insiders/current/active/export/bin/com.visualstudio.code.insiders",
            ],
        ),
        EditorCandidate::new(
            "VSCodium",
            &[
                "/usr/bin/codium",
                "/var/lib/flatpak/app/com.vscodium.codium/current/active/export/bin/com.vscodium.codium",
                "/usr/share/vscodium-bin/bin/codium",
                "/snap/bin/codium",
            ],
        ),
        EditorCandidate::new("VSCodium (Insiders)", &["/usr/bin/codium-insiders"]),
        EditorCandidate::new("Sublime Text", &["/usr/bin/subl"]),
        EditorCandidate::new("Typora", &["/usr/bin/typora"]),
        EditorCandidate::new(
            "SlickEdit",
            &[
                "/opt/slickedit-pro2018/bin/vs",
                "/opt/slickedit-pro2017/bin/vs",
                "/opt/slickedit-pro2016/bin/vs",
                "/opt/slickedit-pro2015/bin/vs",
            ],
        ),
        EditorCandidate::new("Code", &["/usr/bin/io.elementary.code"]),
        EditorCandidate::new("Lite XL", &["/usr/bin/lite-xl"]),
        EditorCandidate::new("JetBrains PhpStorm", &["/snap/bin/phpstorm"]),
        EditorCandidate::new("JetBrains WebStorm", &["/snap/bin/webstorm"]),
        EditorCandidate::new("IntelliJ IDEA", &["/snap/bin/idea"]),
        EditorCandidate::new(
            "IntelliJ IDEA Ultimate Edition",
            &[
                "/snap/bin/intellij-idea-ultimate",
                "/usr/bin/intellij-idea-ultimate-edition",
            ],
        ),
        EditorCandidate::new("JetBrains Goland", &["/snap/bin/goland"]),
        EditorCandidate::new("JetBrains CLion", &["/snap/bin/clion"]),
        EditorCandidate::new("JetBrains Rider", &["/snap/bin/rider"]),
        EditorCandidate::new("JetBrains RubyMine", &["/snap/bin/rubymine"]),
        EditorCandidate::new(
            "JetBrains PyCharm",
            &["/snap/bin/pycharm", "/snap/bin/pycharm-professional"],
        ),
        EditorCandidate::new("JetBrains RustRover", &["/snap/bin/rustrover"]),
        EditorCandidate::new("Android Studio", &["/snap/bin/studio"]),
        EditorCandidate::new(
            "Emacs",
            &["/snap/bin/emacs", "/usr/local/bin/emacs", "/usr/bin/emacs"],
        ),
        EditorCandidate::new("Kate", &["/usr/bin/kate"]),
        EditorCandidate::new("GEdit", &["/usr/bin/gedit"]),
        EditorCandidate::new("GNOME Text Editor", &["/usr/bin/gnome-text-editor"]),
        EditorCandidate::new("GNOME Builder", &["/usr/bin/gnome-builder"]),
        EditorCandidate::new("Notepadqq", &["/usr/bin/notepadqq"]),
        EditorCandidate::new("Mousepad", &["/usr/bin/mousepad"]),
        EditorCandidate::new("Pulsar", &["/usr/bin/pulsar"]),
        EditorCandidate::new("Pluma", &["/usr/bin/pluma"]),
        EditorCandidate::new(
            "Zed",
            &[
                "/usr/bin/zedit",
                "/usr/bin/zeditor",
                "/usr/bin/zed-editor",
                "/usr/bin/zed",
            ],
        ),
    ];

    if let Some(home) = home {
        let home_paths = [
            (
                "Visual Studio Code",
                ".local/share/flatpak/app/com.visualstudio.code/current/active/export/bin/com.visualstudio.code",
            ),
            (
                "Visual Studio Code (Insiders)",
                ".local/share/flatpak/app/com.visualstudio.code.insiders/current/active/export/bin/com.visualstudio.code.insiders",
            ),
            (
                "VSCodium",
                ".local/share/flatpak/app/com.vscodium.codium/current/active/export/bin/com.vscodium.codium",
            ),
            (
                "JetBrains PhpStorm",
                ".local/share/JetBrains/Toolbox/scripts/PhpStorm",
            ),
            (
                "JetBrains WebStorm",
                ".local/share/JetBrains/Toolbox/scripts/webstorm",
            ),
            ("IntelliJ IDEA", ".local/share/JetBrains/Toolbox/scripts/idea"),
            (
                "IntelliJ IDEA Ultimate Edition",
                ".local/share/JetBrains/Toolbox/scripts/intellij-idea-ultimate",
            ),
            (
                "JetBrains Goland",
                ".local/share/JetBrains/Toolbox/scripts/goland",
            ),
            (
                "JetBrains CLion",
                ".local/share/JetBrains/Toolbox/scripts/clion1",
            ),
            (
                "JetBrains Rider",
                ".local/share/JetBrains/Toolbox/scripts/rider",
            ),
            (
                "JetBrains RubyMine",
                ".local/share/JetBrains/Toolbox/scripts/rubymine",
            ),
            (
                "JetBrains PyCharm",
                ".local/share/JetBrains/Toolbox/scripts/pycharm",
            ),
            (
                "JetBrains RustRover",
                ".local/share/JetBrains/Toolbox/scripts/rustrover",
            ),
            (
                "Android Studio",
                ".local/share/JetBrains/Toolbox/scripts/studio",
            ),
            ("Zed", ".local/bin/zed"),
        ];

        for (name, path) in home_paths {
            if let Some(candidate) = candidates
                .iter_mut()
                .find(|candidate| candidate.name == name)
            {
                // Upstream places each home-scoped path at the point shown in its literal table.
                // All of them precede the final system fallback except Zed, where it precedes
                // `/usr/bin/zed`.
                let insertion = match name {
                    "Visual Studio Code" | "Visual Studio Code (Insiders)" => candidate.paths.len(),
                    "VSCodium" => candidate.paths.len() - 1,
                    "Zed" => candidate.paths.len() - 1,
                    _ => candidate.paths.len(),
                };
                candidate.paths.insert(insertion, home.join(path));
            }
        }
    }

    candidates
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn discover_editors(
    candidates: &[EditorCandidate],
    mut exists: impl FnMut(&Path) -> bool,
) -> Vec<FoundEditor> {
    candidates
        .iter()
        .filter_map(|candidate| {
            candidate
                .paths
                .iter()
                .find(|path| exists(path))
                .map(|path| FoundEditor {
                    editor: candidate.name.to_owned(),
                    path: path.clone(),
                })
        })
        .collect()
}

#[cfg(target_os = "linux")]
pub(crate) fn get_available_editors() -> Vec<FoundEditor> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    discover_editors(&linux_editor_candidates(home.as_deref()), Path::exists)
}

#[cfg(target_os = "macos")]
fn locate_bundle(bundle_id: &str) -> Vec<PathBuf> {
    // Bundle identifiers are static entries in `darwin_editor_candidates`; passing the Spotlight
    // query as one process argument avoids introducing a shell grammar or injection surface.
    let query = format!("kMDItemCFBundleIdentifier == '{bundle_id}'");
    match std::process::Command::new("/usr/bin/mdfind")
        .arg(query)
        .output()
    {
        Ok(output) if output.status.success() => parse_spotlight_paths(&output.stdout),
        _ => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn get_available_editors() -> Vec<FoundEditor> {
    discover_darwin_editors(&darwin_editor_candidates(), locate_bundle, Path::exists)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchPlatform {
    #[cfg(any(target_os = "linux", test))]
    Linux { flatpak: bool },
    #[cfg(any(target_os = "macos", test))]
    MacOs { application_bundle: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LaunchSpec {
    program: PathBuf,
    arguments: Vec<OsString>,
}

pub(crate) fn editor_launch_spec(
    platform: LaunchPlatform,
    editor_path: &Path,
    arguments: Vec<OsString>,
) -> LaunchSpec {
    match platform {
        #[cfg(any(target_os = "linux", test))]
        LaunchPlatform::Linux { flatpak: true } => {
            let mut host_arguments =
                vec![OsString::from("--host"), editor_path.as_os_str().to_owned()];
            host_arguments.extend(arguments);
            LaunchSpec {
                program: PathBuf::from("flatpak-spawn"),
                arguments: host_arguments,
            }
        }
        #[cfg(any(target_os = "macos", test))]
        LaunchPlatform::MacOs {
            application_bundle: true,
        } => {
            let mut open_arguments = vec![OsString::from("-a"), editor_path.as_os_str().to_owned()];
            open_arguments.extend(arguments);
            LaunchSpec {
                program: PathBuf::from("/usr/bin/open"),
                arguments: open_arguments,
            }
        }
        #[cfg(any(target_os = "linux", test))]
        LaunchPlatform::Linux { flatpak: false } => LaunchSpec {
            program: editor_path.to_owned(),
            arguments,
        },
        #[cfg(any(target_os = "macos", test))]
        LaunchPlatform::MacOs {
            application_bundle: false,
        } => LaunchSpec {
            program: editor_path.to_owned(),
            arguments,
        },
    }
}

#[derive(Debug)]
pub(crate) enum EditorLaunchError {
    Missing(PathBuf),
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    UnsupportedPlatform,
    Io(std::io::Error),
}

impl fmt::Display for EditorLaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(path) => write!(
                formatter,
                "could not find editor executable at '{}'",
                path.display()
            ),
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            Self::UnsupportedPlatform => {
                formatter.write_str("editor launching is not implemented for this platform")
            }
            Self::Io(error) => write!(formatter, "could not launch editor: {error}"),
        }
    }
}

impl std::error::Error for EditorLaunchError {}

pub(crate) async fn launch_editor(
    editor_path: PathBuf,
    arguments: Vec<String>,
    application_bundle: bool,
) -> Result<(), EditorLaunchError> {
    #[cfg(not(target_os = "macos"))]
    let _ = application_bundle;

    if !tokio::fs::try_exists(&editor_path)
        .await
        .map_err(EditorLaunchError::Io)?
    {
        return Err(EditorLaunchError::Missing(editor_path));
    }

    #[cfg(target_os = "linux")]
    let platform = LaunchPlatform::Linux {
        // Flatpak exposes this file inside every sandbox. The environment check also covers test and
        // development shells launched through `flatpak-spawn`.
        flatpak: Path::new("/.flatpak-info").exists() || std::env::var_os("FLATPAK_ID").is_some(),
    };
    #[cfg(target_os = "macos")]
    let platform = LaunchPlatform::MacOs { application_bundle };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    return Err(EditorLaunchError::UnsupportedPlatform);

    let spec = editor_launch_spec(
        platform,
        &editor_path,
        arguments.into_iter().map(OsString::from).collect(),
    );
    let mut child = tokio::process::Command::new(&spec.program)
        .args(&spec.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .map_err(EditorLaunchError::Io)?;

    // The original detached and unref'd the process. Tokio children are also independent when
    // `kill_on_drop(false)`; the background wait merely reaps short-lived launchers such as `open`.
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        darwin_editor_candidates, discover_darwin_editors, discover_editors, editor_launch_spec,
        linux_editor_candidates, parse_spotlight_paths, LaunchPlatform,
    };
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    #[test]
    fn chooses_the_first_existing_path_for_each_editor_and_preserves_order() {
        let candidates = linux_editor_candidates(Some(Path::new("/home/tester")));
        let existing = HashSet::from([
            "/usr/bin/atom",
            "/snap/bin/code",
            "/usr/bin/code",
            "/home/tester/.local/bin/zed",
        ]);

        let found = discover_editors(&candidates, |path| {
            existing.contains(path.to_string_lossy().as_ref())
        });

        assert_eq!(
            found,
            vec![
                super::FoundEditor {
                    editor: "Atom".to_owned(),
                    path: "/usr/bin/atom".into(),
                },
                super::FoundEditor {
                    editor: "Visual Studio Code".to_owned(),
                    path: "/snap/bin/code".into(),
                },
                super::FoundEditor {
                    editor: "Zed".to_owned(),
                    path: "/home/tester/.local/bin/zed".into(),
                },
            ]
        );
    }

    #[test]
    fn includes_home_scoped_flatpak_toolbox_and_zed_candidates() {
        let candidates = linux_editor_candidates(Some(Path::new("/home/tester")));
        let all_paths = candidates
            .iter()
            .flat_map(|candidate| candidate.paths.iter())
            .map(|path| path.as_path())
            .collect::<HashSet<&Path>>();

        assert!(all_paths.contains(Path::new(
            "/home/tester/.local/share/flatpak/app/com.visualstudio.code/current/active/export/bin/com.visualstudio.code"
        )));
        assert!(all_paths.contains(Path::new(
            "/home/tester/.local/share/JetBrains/Toolbox/scripts/idea"
        )));
        assert!(all_paths.contains(Path::new("/home/tester/.local/bin/zed")));
    }

    #[test]
    fn omits_home_scoped_candidates_when_home_is_unavailable() {
        let candidates = linux_editor_candidates(None);

        assert!(candidates
            .iter()
            .flat_map(|candidate| candidate.paths.iter())
            .all(|path| !path.starts_with("/home")));
    }

    #[test]
    fn macos_discovery_tries_bundle_ids_in_order_and_preserves_editor_order() {
        let candidates = darwin_editor_candidates();
        let mut looked_up = Vec::new();

        let found = discover_darwin_editors(
            &candidates,
            |bundle_id| {
                looked_up.push(bundle_id.to_owned());
                match bundle_id {
                    "com.visualstudio.code.oss" => vec!["/missing/VSCodium.app".into()],
                    "com.vscodium" => vec!["/Applications/VSCodium.app".into()],
                    "com.sublimetext.4" => vec!["/Applications/Sublime Text.app".into()],
                    _ => Vec::new(),
                }
            },
            |path| path.starts_with("/Applications"),
        );

        assert_eq!(
            found,
            vec![
                super::FoundEditor {
                    editor: "VSCodium".to_owned(),
                    path: "/Applications/VSCodium.app".into(),
                },
                super::FoundEditor {
                    editor: "Sublime Text".to_owned(),
                    path: "/Applications/Sublime Text.app".into(),
                },
            ]
        );
        assert!(
            looked_up.windows(2).any(|ids| ids
                == [
                    "com.visualstudio.code.oss".to_owned(),
                    "com.vscodium".to_owned()
                ]),
            "the fallback bundle id must be tried after the primary one"
        );
        assert!(
            !looked_up.contains(&"com.sublimetext.3".to_owned()),
            "a found primary bundle id stops fallback lookup"
        );
    }

    #[test]
    fn macos_candidate_table_keeps_upstreams_multi_bundle_fallbacks() {
        let candidates = darwin_editor_candidates();
        let ids_for = |name| {
            candidates
                .iter()
                .find(|candidate| candidate.name == name)
                .expect("candidate exists")
                .bundle_ids
                .as_slice()
        };

        assert_eq!(
            ids_for("VSCodium"),
            ["com.visualstudio.code.oss", "com.vscodium"]
        );
        assert_eq!(
            ids_for("Sublime Text"),
            [
                "com.sublimetext.4",
                "com.sublimetext.3",
                "com.sublimetext.2"
            ]
        );
        assert_eq!(candidates.len(), 50);
    }

    #[test]
    fn spotlight_output_is_line_delimited_and_ignores_empty_lines() {
        assert_eq!(
            parse_spotlight_paths(
                b"/Applications/Visual Studio Code.app\n\n/Users/me/Applications/Code.app\n"
            ),
            vec![
                PathBuf::from("/Applications/Visual Studio Code.app"),
                PathBuf::from("/Users/me/Applications/Code.app"),
            ]
        );
    }

    #[test]
    fn macos_application_launch_uses_open_with_the_application_path() {
        let spec = editor_launch_spec(
            LaunchPlatform::MacOs {
                application_bundle: true,
            },
            Path::new("/Applications/Visual Studio Code.app"),
            vec!["/repos/a project".into()],
        );

        assert_eq!(spec.program, Path::new("/usr/bin/open"));
        assert_eq!(
            spec.arguments,
            [
                "-a",
                "/Applications/Visual Studio Code.app",
                "/repos/a project"
            ]
        );
    }

    #[test]
    fn linux_flatpak_launches_the_host_editor_without_a_shell() {
        let spec = editor_launch_spec(
            LaunchPlatform::Linux { flatpak: true },
            Path::new("/usr/bin/code"),
            vec!["/repos/project".into()],
        );

        assert_eq!(spec.program, Path::new("flatpak-spawn"));
        assert_eq!(
            spec.arguments,
            ["--host", "/usr/bin/code", "/repos/project"]
        );
    }

    #[test]
    fn direct_launch_keeps_each_argument_separate() {
        let spec = editor_launch_spec(
            LaunchPlatform::Linux { flatpak: false },
            Path::new("/usr/bin/code"),
            vec!["--wait".into(), "/repos/a project".into()],
        );

        assert_eq!(spec.program, Path::new("/usr/bin/code"));
        assert_eq!(spec.arguments, ["--wait", "/repos/a project"]);
    }
}
