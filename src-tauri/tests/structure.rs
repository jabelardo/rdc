//! The checks that defend BACKEND_STRUCTURE.md.
//!
//! A Rust integration test rather than a Node script in `scripts/` beside the frontend's checkers,
//! because this runs under `cargo test --workspace` — already a CI gate, and already the command a
//! Rust change runs locally. It needs no new wiring and cannot be forgotten.
//!
//! The original assertions were verified by planting a violation and watching them fail. Review
//! then closed three blind spots: duplicate wire names were hidden by sets, multiline return types
//! were inspected one line at a time, and two documented boundaries had no assertion at all.
//!
//! - Registering a command that does not exist is a **compile** error, not a test failure —
//!   `generate_handler!` expands to a reference to `tags::__cmd__invent_a_tag`. rustc owns that
//!   direction; the assertion below is kept because it states the intent, not because it is what
//!   protects you.
//!
//! What none of them can defend is the distinction between IPC-specific orchestration and reusable
//! domain logic: a misplaced helper function breaks nothing mechanical. The checker enforces
//! direction, not cohesion.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `.rs` file under `path`, recursively.
fn rust_files(path: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).expect("source directory should be readable") {
            let entry = entry.expect("directory entry should be readable");
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_none_or(|name| name != "target") {
                    stack.push(path);
                }
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// Source with `//` line comments removed.
///
/// Without this, a doc comment stating a rule would violate it — `commands/platform/mod.rs` says
/// that a module there may not name `git_ops`, and saying so is not naming it.
fn code_only(source: &str) -> String {
    source
        .lines()
        .map(|line| match line.find("//") {
            Some(index) => &line[..index],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("{} should be readable: {error}", path.display()))
}

#[derive(Debug)]
struct CommandDeclaration {
    name: String,
    file: PathBuf,
    signature: String,
}

/// Every function carrying `#[tauri::command]`, including its complete signature.
fn declared_commands() -> Vec<CommandDeclaration> {
    let mut commands = Vec::new();
    for file in rust_files(&crate_root().join("src/commands")) {
        let source = read(&file);
        let lines: Vec<&str> = source.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            let marker = line.trim();
            if !marker.starts_with("#[tauri::command") || !marker.ends_with(']') {
                continue;
            }
            // Attributes and comments may sit between the marker and the signature — `pull`
            // carries an `#[allow(clippy::too_many_arguments)]` with a comment explaining it,
            // because a command's parameter list is its wire API and grouping the parameters to
            // satisfy the lint would change what the frontend sends.
            let signature_start = lines[index + 1..]
                .iter()
                .position(|candidate| {
                    let candidate = candidate.trim_start();
                    !candidate.is_empty()
                        && !candidate.starts_with('#')
                        && !candidate.starts_with("//")
                })
                .map(|offset| index + 1 + offset)
                .unwrap_or_else(|| {
                    panic!(
                        "{}: #[tauri::command] with no item after it",
                        file.display()
                    )
                });
            let signature = lines[signature_start..]
                .iter()
                .scan(false, |finished, line| {
                    if *finished {
                        return None;
                    }
                    if line.contains('{') {
                        *finished = true;
                    }
                    Some(*line)
                })
                .collect::<Vec<_>>()
                .join(" ");
            let name = signature
                .split("fn ")
                .nth(1)
                .and_then(|rest| rest.split('(').next())
                .unwrap_or_else(|| {
                    panic!("{}: cannot read a name from {signature:?}", file.display())
                });
            commands.push(CommandDeclaration {
                name: name.trim().to_owned(),
                file: file.clone(),
                signature,
            });
        }
    }
    commands
}

/// Names listed in `lib.rs`'s `generate_handler!`.
fn registered_commands() -> Vec<String> {
    let source = read(&crate_root().join("src/lib.rs"));
    let start = source
        .find("invoke_handler(tauri::generate_handler![")
        .expect("lib.rs should register an invoke handler");
    let list = &source[start..];
    let end = list.find("])").expect("the handler list should be closed");
    list[..end]
        .lines()
        .filter_map(|line| {
            let line = line.trim().trim_end_matches(',');
            line.starts_with("commands::")
                .then(|| line.rsplit("::").next().unwrap_or_default().to_owned())
        })
        .filter(|name| !name.is_empty())
        .collect()
}

/// An unregistered command compiles silently and is dead from the frontend's point of view — the
/// failure mode with the least evidence at the crash site.
#[test]
fn every_command_is_registered_and_every_registration_resolves() {
    let declared = declared_commands();
    let registered = registered_commands();

    assert!(
        declared.len() > 100,
        "the scan found only {} commands, so it is probably broken rather than the code",
        declared.len()
    );

    let mut declaration_counts = BTreeMap::new();
    for command in &declared {
        declaration_counts
            .entry(command.name.as_str())
            .or_insert_with(Vec::new)
            .push(command.file.display().to_string());
    }
    let duplicate_declarations: Vec<_> = declaration_counts
        .iter()
        .filter(|(_, files)| files.len() > 1)
        .collect();
    assert!(
        duplicate_declarations.is_empty(),
        "Tauri command wire names must be unique, but these are declared more than once: \
         {duplicate_declarations:?}"
    );

    let mut registration_counts = BTreeMap::new();
    for name in &registered {
        *registration_counts.entry(name.as_str()).or_insert(0usize) += 1;
    }
    let duplicate_registrations: Vec<_> = registration_counts
        .iter()
        .filter(|(_, count)| **count > 1)
        .collect();
    assert!(
        duplicate_registrations.is_empty(),
        "generate_handler! must register each command once: {duplicate_registrations:?}"
    );

    let declared_names: BTreeSet<_> = declared.iter().map(|command| &command.name).collect();
    let registered_names: BTreeSet<_> = registered.iter().collect();
    let unregistered: Vec<_> = declared_names.difference(&registered_names).collect();
    assert!(
        unregistered.is_empty(),
        "these commands are declared but never reach generate_handler!, so the frontend cannot \
         call them: {unregistered:?}"
    );

    let unresolved: Vec<_> = registered_names.difference(&declared_names).collect();
    assert!(
        unresolved.is_empty(),
        "generate_handler! lists these, but no #[tauri::command] declares them: {unresolved:?}"
    );
}

/// `commands/platform/` adapts `crate::platform`. Reaching for git from there would mean the split
/// no longer says what a module does.
#[test]
fn platform_commands_do_not_reach_for_git() {
    let mut offenders = Vec::new();
    for file in rust_files(&crate_root().join("src/commands/platform")) {
        if code_only(&read(&file)).contains("git_ops") {
            offenders.push(file);
        }
    }
    assert!(
        offenders.is_empty(),
        "commands/platform/ may not name git_ops — see BACKEND_STRUCTURE.md: {offenders:?}"
    );
}

/// The mirror of the rule above.
#[test]
fn git_commands_do_not_reach_for_the_platform_layer() {
    let mut offenders = Vec::new();
    for file in rust_files(&crate_root().join("src/commands/git")) {
        if code_only(&read(&file)).contains("crate::platform") {
            offenders.push(file);
        }
    }
    assert!(
        offenders.is_empty(),
        "commands/git/ may not name crate::platform — split cross-boundary work at an app-service \
         seam: {offenders:?}"
    );
}

/// Consequence 1 of the layer rule. True today, with nothing keeping it true.
///
/// It is what lets `cargo test -p git-ops` run the bulk of the suite with no app and no display
/// server, and what keeps `cargo check -p git-ops --target x86_64-pc-windows-msvc` green while the
/// app crate cannot compile for Windows at all.
#[test]
fn the_crates_know_nothing_about_tauri() {
    for crate_name in ["git-ops", "trampoline"] {
        let manifest = read(
            &crate_root()
                .join("crates")
                .join(crate_name)
                .join("Cargo.toml"),
        );
        for line in manifest.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            assert!(
                !line.contains("tauri"),
                "{crate_name}/Cargo.toml names tauri in {line:?} — the crates must stay buildable \
                 and testable without an app"
            );
        }

        let crate_directory = crate_root().join("crates").join(crate_name);
        for file in rust_files(&crate_directory) {
            assert!(
                !code_only(&read(&file)).contains("tauri"),
                "{} names tauri; the crates must not depend on the app's framework",
                file.display()
            );
        }
    }
}

/// The app composes the two crates; neither lower-level crate may take on that responsibility.
#[test]
fn the_crates_do_not_depend_on_each_other() {
    for (crate_name, forbidden_dependency) in [("git-ops", "trampoline"), ("trampoline", "git-ops")]
    {
        let manifest_path = crate_root()
            .join("crates")
            .join(crate_name)
            .join("Cargo.toml");
        let manifest = code_only(&read(&manifest_path));
        let package_alias = format!("package = \"{forbidden_dependency}\"");
        let dependency_lines: Vec<_> = manifest
            .lines()
            .map(str::trim)
            .filter(|line| {
                line.strip_prefix(forbidden_dependency)
                    .is_some_and(|rest| rest.trim_start().starts_with('=') || rest.starts_with('.'))
                    || line.contains(&package_alias)
            })
            .collect();
        assert!(
            dependency_lines.is_empty(),
            "{crate_name} may not depend on {forbidden_dependency}; the app composes the crates: \
             {dependency_lines:?}"
        );
    }
}

/// `CommandError` preserves the machine-readable classification that a string return discards.
#[test]
fn every_command_returns_the_error_contract() {
    let mut offenders = Vec::new();
    for command in declared_commands() {
        let signature: String = command.signature.split_whitespace().collect();
        if !signature.contains("->Result<") || !signature.contains(",CommandError>") {
            offenders.push(format!("{}: {}", command.file.display(), command.signature));
        }
    }
    assert!(
        offenders.is_empty(),
        "every command must return Result<_, CommandError> — see commands/error.rs: {offenders:?}"
    );
}

/// Platform wire types must exist on every target even when their OS implementation does not.
#[test]
fn platform_models_are_cfg_free() {
    let platform = crate_root().join("src/platform");
    let mut offenders = Vec::new();
    for file in rust_files(&platform) {
        let is_model = file
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("_model.rs"));
        if is_model
            && read(&file)
                .lines()
                .any(|line| line.trim_start().starts_with("#[cfg"))
        {
            offenders.push(file);
        }
    }
    assert!(
        offenders.is_empty(),
        "platform *_model.rs files must remain cfg-free so their wire types exist on every target: \
         {offenders:?}"
    );
}
