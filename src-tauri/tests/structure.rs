//! The checks that defend BACKEND_STRUCTURE.md.
//!
//! A Rust integration test rather than a Node script in `scripts/` beside the frontend's checkers,
//! because this runs under `cargo test --workspace` — already a CI gate, and already the command a
//! Rust change runs locally. It needs no new wiring and cannot be forgotten.
//!
//! Every assertion here was verified by planting a violation and watching it fail, and two of them
//! turned out to need a more careful violation than the obvious one:
//!
//! - Registering a command that does not exist is a **compile** error, not a test failure —
//!   `generate_handler!` expands to a reference to `tags::__cmd__invent_a_tag`. rustc owns that
//!   direction; the assertion below is kept because it states the intent, not because it is what
//!   protects you.
//! - The error-contract check only fires on a command that is *self-consistently* stringly-typed.
//!   Changing a return type to `String` while the body still produces `CommandError` does not
//!   compile, so the realistic failure — a new command written with `Result<T, String>` throughout
//!   — is the one the probe had to use.
//!
//! What none of them can defend is the rule that `commands/` holds no logic: a helper function in a
//! command module breaks nothing mechanical. The checker enforces direction, not cohesion.

use std::collections::BTreeSet;
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
                stack.push(path);
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

/// Names of every function carrying `#[tauri::command]`.
fn declared_commands() -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for file in rust_files(&crate_root().join("src/commands")) {
        let source = read(&file);
        let lines: Vec<&str> = source.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            // Attributes and comments may sit between the marker and the signature — `pull`
            // carries an `#[allow(clippy::too_many_arguments)]` with a comment explaining it,
            // because a command's parameter list is its wire API and grouping the parameters to
            // satisfy the lint would change what the frontend sends.
            let signature = lines[index + 1..]
                .iter()
                .find(|candidate| {
                    let candidate = candidate.trim_start();
                    !candidate.is_empty()
                        && !candidate.starts_with('#')
                        && !candidate.starts_with("//")
                })
                .unwrap_or_else(|| {
                    panic!(
                        "{}: #[tauri::command] with no item after it",
                        file.display()
                    )
                });
            let name = signature
                .split("fn ")
                .nth(1)
                .and_then(|rest| rest.split('(').next())
                .unwrap_or_else(|| {
                    panic!("{}: cannot read a name from {signature:?}", file.display())
                });
            names.insert(name.trim().to_owned());
        }
    }
    names
}

/// Names listed in `lib.rs`'s `generate_handler!`.
fn registered_commands() -> BTreeSet<String> {
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

    let unregistered: Vec<_> = declared.difference(&registered).collect();
    assert!(
        unregistered.is_empty(),
        "these commands are declared but never reach generate_handler!, so the frontend cannot \
         call them: {unregistered:?}"
    );

    let unresolved: Vec<_> = registered.difference(&declared).collect();
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
        "commands/git/ may not name crate::platform — a command that needs both is composing, and \
         composition belongs in lib.rs: {offenders:?}"
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

        let sources = crate_root().join("crates").join(crate_name).join("src");
        for file in rust_files(&sources) {
            assert!(
                !code_only(&read(&file)).contains("tauri"),
                "{} names tauri; the crates must not depend on the app's framework",
                file.display()
            );
        }
    }
}

/// `.map_err(|e| e.to_string())` discards the `GitErrorKind` classification and leaves the frontend
/// pattern-matching on English prose. `CommandError` exists so it does not have to.
#[test]
fn commands_return_the_error_contract_rather_than_strings() {
    let mut offenders = Vec::new();
    for file in rust_files(&crate_root().join("src/commands")) {
        let source = code_only(&read(&file));
        for (number, line) in source.lines().enumerate() {
            let stringly = line.contains("e.to_string()") && line.contains("map_err");
            let returns_string = line.contains("Result<") && line.contains(", String>");
            if stringly || returns_string {
                offenders.push(format!("{}:{}", file.display(), number + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "commands must return CommandError, never a String — see commands/error.rs: {offenders:?}"
    );
}
