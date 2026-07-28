//! End-to-end: the real `rdc-printenvz` binary, run by a real shell.
//!
//! The unit tests in `hooks::shell_env` cover the parser against constructed output. What they cannot
//! cover is the half that only exists at runtime: that the binary's framing is what the parser expects,
//! that a shell's init-file chatter really is excluded, and that the child gets a *clean* environment
//! rather than this process's.
//!
//! `CARGO_BIN_EXE_rdc-printenvz` is set by Cargo for integration tests, so the binary under test is the
//! one just built — never a stale copy from a bundle.
//!
//! # No test here mutates the process environment
//!
//! The obvious way to give the shell an init file is to set `ENV` or `BASH_ENV` on this process. That is
//! the pattern `MIGRATION_MAP.md` §8 already records as a mistake in the original's `rev-parse` tests:
//! process-wide state leaks into whatever runs next. Instead each test writes a small **wrapper script**
//! that plays the part of a shell — it exports what the test wants, then runs the command it was handed.
//! That is exactly the contract `get_shell_env` depends on, and it is hermetic.

use std::path::{Path, PathBuf};

use git_ops::hooks::shell::Shell;
use git_ops::hooks::shell_env::get_shell_env_with_shell;

fn printenvz() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_rdc-printenvz"))
}

/// Writes a stand-in shell whose "init file" is `body`, and returns it as a [`Shell`].
///
/// The script receives the same arguments a real shell would — `-ilc` and then one quoted command — so
/// `$2` is the command to run, and running it through `sh -c` is what a shell does with `-c`.
///
/// # `/bin/sh <script>` rather than executing the script
///
/// `Shell::path` is `/bin/sh` with the script as its first argument, so the interpreter **reads** the
/// script instead of the kernel executing it. Executing a file that was just written races with `fork` in
/// another thread — Linux answers `ETXTBSY`, "Text file busy" — and with tests running in parallel that is
/// frequent enough to fail CI while passing when run alone. `ETXTBSY` applies to `execve` only, so reading
/// the script sidesteps it entirely, the same reasoning as the symlinked stand-ins in
/// `hooks::with_env::install_stand_in`.
fn shell_that_exports(dir: &Path, body: &str) -> Shell {
    let path = dir.join("stand-in-shell");
    std::fs::write(&path, format!("{body}\nexec /bin/sh -c \"$2\"\n"))
        .expect("failed to write the stand-in shell");

    Shell {
        path: PathBuf::from("/bin/sh"),
        args: vec![path.to_string_lossy().into_owned(), "-ilc".to_owned()],
    }
}

#[tokio::test]
async fn reads_the_environment_the_shell_builds() {
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(dir.path(), "export HOOK_TEST_VAR=from-the-init-file");

    let loaded = get_shell_env_with_shell(shell, None, &printenvz())
        .await
        .expect("loading the environment should succeed");

    assert_eq!(
        loaded.vars.get("HOOK_TEST_VAR").map(String::as_str),
        Some("from-the-init-file"),
        "a variable the shell exports must arrive"
    );
}

#[tokio::test]
async fn excludes_what_an_init_file_prints() {
    // The reason the markers exist. A version manager announcing itself, or a MOTD, would otherwise be
    // parsed as environment variables — proven end to end rather than against a fixture.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(
        dir.path(),
        "echo 'Welcome!'\necho 'NOT_A_VAR=surprise'\nexport REAL_VAR=yes",
    );

    let loaded = get_shell_env_with_shell(shell, None, &printenvz())
        .await
        .expect("loading the environment should succeed");

    assert_eq!(loaded.vars.get("REAL_VAR").map(String::as_str), Some("yes"));
    assert!(
        !loaded.vars.contains_key("NOT_A_VAR"),
        "printed text is not an environment variable: {:?}",
        loaded.vars
    );
}

#[tokio::test]
async fn a_value_spanning_lines_survives() {
    // Why the entries are NUL-delimited, end to end: a line-based protocol would split this in two.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(dir.path(), "export MULTI='one\ntwo'");

    let loaded = get_shell_env_with_shell(shell, None, &printenvz())
        .await
        .expect("loading the environment should succeed");

    assert_eq!(
        loaded.vars.get("MULTI").map(String::as_str),
        Some("one\ntwo")
    );
}

#[tokio::test]
async fn does_not_inherit_this_process_environment() {
    // The property the subsystem depends on: were the app's environment to leak in, the shell's own
    // `PATH` would be masked by the one rdc was launched with — the very difference being looked for.
    //
    // `CARGO_PKG_NAME` is set by Cargo for this test process and is not something any shell would set,
    // so it makes a clean tracer without touching the environment.
    assert!(
        std::env::var_os("CARGO_PKG_NAME").is_some(),
        "the tracer must be present in this process, or the assertion below proves nothing"
    );

    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(dir.path(), "");

    let loaded = get_shell_env_with_shell(shell, None, &printenvz())
        .await
        .expect("loading the environment should succeed");

    assert!(
        !loaded.vars.contains_key("CARGO_PKG_NAME"),
        "the child's environment must be built by the shell, not inherited: {:?}",
        loaded.vars
    );
}

#[tokio::test]
async fn runs_in_the_directory_it_is_given() {
    // Why `cwd` is passed: directory-local tooling (`.nvmrc`, `direnv`) only applies if the shell starts
    // where the repository is.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(dir.path(), "export SEEN_PWD=\"$PWD\"");
    let workdir = dir.path().join("work");
    std::fs::create_dir(&workdir).expect("failed to create the directory");

    let loaded = get_shell_env_with_shell(shell, Some(&workdir), &printenvz())
        .await
        .expect("loading the environment should succeed");

    let seen = loaded
        .vars
        .get("SEEN_PWD")
        .expect("the shell recorded its working directory");
    assert_eq!(
        std::fs::canonicalize(seen).expect("the recorded path exists"),
        std::fs::canonicalize(&workdir).expect("the work directory exists")
    );
}

#[tokio::test]
async fn a_path_with_a_space_or_a_quote_still_runs() {
    // What the quoting is for. The binary's path is ours, but a user's application directory is not.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let awkward = dir.path().join("bin dir's");
    std::fs::create_dir(&awkward).expect("failed to create the directory");
    let copied = awkward.join("rdc-printenvz");
    // Linked rather than copied: running an executable that was just written races with `fork` in another
    // thread and Linux answers `ETXTBSY`. See `hooks::with_env::install_stand_in`.
    #[cfg(unix)]
    std::os::unix::fs::symlink(printenvz(), &copied).expect("failed to link the binary");
    #[cfg(not(unix))]
    std::fs::copy(printenvz(), &copied).expect("failed to copy the binary");

    let shell = shell_that_exports(dir.path(), "export QUOTED_OK=yes");

    let loaded = get_shell_env_with_shell(shell, None, &copied)
        .await
        .expect("a path with a space and a quote must still run");

    assert_eq!(
        loaded.vars.get("QUOTED_OK").map(String::as_str),
        Some("yes")
    );
}

#[tokio::test]
async fn reports_a_shell_that_cannot_be_run() {
    // A real `Shell` here, not the `/bin/sh <script>` harness: this is about the shell itself missing.
    let shell = Shell {
        path: PathBuf::from("/nonexistent/shell"),
        args: vec!["-ilc".to_owned()],
    };

    let error = get_shell_env_with_shell(shell, None, &printenvz())
        .await
        .expect_err("a missing shell is an error, not an empty environment");

    assert!(
        format!("{error}").contains("/nonexistent/shell"),
        "the message must name the shell, so the user can fix the setting: {error}"
    );
}

#[tokio::test]
async fn reports_a_shell_that_could_not_run_the_helper() {
    // Handing back an empty environment here would give hooks a broken `PATH` and call it success.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(dir.path(), "");

    get_shell_env_with_shell(shell, None, Path::new("/nonexistent/rdc-printenvz"))
        .await
        .expect_err("no markers means no environment");
}

#[tokio::test]
async fn reports_a_shell_whose_init_file_failed() {
    // An init file that exits non-zero takes the whole invocation down with it, and the user needs to be
    // told rather than handed a partial environment.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let shell = shell_that_exports(dir.path(), "echo 'broken init' >&2\nexit 3");

    let error = get_shell_env_with_shell(shell, None, &printenvz())
        .await
        .expect_err("a failing shell is an error");

    assert!(
        format!("{error}").contains("broken init"),
        "the shell's own diagnostics are the only clue the user has: {error}"
    );
}
