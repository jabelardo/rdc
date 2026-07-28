//! End-to-end: the real `rdc-hook-proxy` binary talking to a real server.
//!
//! The unit tests in `hooks::server` drive the client half in-process. What they cannot cover is the part
//! that only exists when a separate program is involved: that a copy of the binary named after a hook
//! reports *that* hook, that stderr reaches the process's own stderr, that the exit code becomes the
//! process's exit code, and that it fails closed when the app isn't there.
//!
//! `CARGO_BIN_EXE_rdc-hook-proxy` is set by Cargo for integration tests, so the binary under test is the
//! one just built.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use git_ops::hooks::protocol::{generate_token, PORT_ENV, TOKEN_ENV};
use git_ops::hooks::server::{runner, HookRequest, HookServer, ServerHandle, StderrSink};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

/// Puts a stand-in for `hook` in `dir`, the way `core.hooksPath` will need it.
///
/// A **symlink**, for the reason `hooks::with_env::install_stand_in` documents: copying an executable and
/// then running it races with `fork` in another thread, and Linux answers `ETXTBSY`. These tests spawn
/// many processes at once, which is where that first showed up.
fn stand_in(dir: &Path, hook: &str) -> PathBuf {
    let path = dir.join(hook);
    let binary = Path::new(env!("CARGO_BIN_EXE_rdc-hook-proxy"));

    #[cfg(unix)]
    std::os::unix::fs::symlink(binary, &path).expect("failed to link the binary");
    #[cfg(not(unix))]
    std::fs::copy(binary, &path).expect("failed to copy the binary");

    path
}

/// A server that reports what it was asked to run and exits with `code`.
async fn serving(
    token: &str,
    code: i32,
) -> (u16, ServerHandle, mpsc::UnboundedReceiver<HookRequest>) {
    let (seen, received) = mpsc::unbounded_channel();

    let server = HookServer::bind(
        token.to_owned(),
        runner(move |request: HookRequest, sink: StderrSink| {
            let seen = seen.clone();
            async move {
                let _ = sink.send(format!("{}: working\n", request.hook).into_bytes());
                let _ = seen.send(request);
                code
            }
        }),
    )
    .await
    .expect("binding should succeed");

    let port = server.port().expect("a port");
    (port, server.serve(), received)
}

/// Runs a stand-in as git would, and returns its exit code plus what it wrote to stderr.
async fn run_stand_in(
    path: &Path,
    port: u16,
    token: &str,
    arguments: &[&str],
    stdin: Option<&[u8]>,
    cwd: &Path,
) -> (Option<i32>, String) {
    let mut command = tokio::process::Command::new(path);
    command
        .args(arguments)
        .current_dir(cwd)
        .env(PORT_ENV, port.to_string())
        .env(TOKEN_ENV, token)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().expect("failed to spawn the stand-in");

    if let Some(stdin) = stdin {
        let mut pipe = child.stdin.take().expect("stdin was piped");
        pipe.write_all(stdin).await.expect("failed to write stdin");
        drop(pipe);
    }

    let output = child
        .wait_with_output()
        .await
        .expect("the stand-in should exit");

    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[tokio::test]
async fn a_stand_in_reports_the_hook_it_was_named_after() {
    // Why one binary can serve every hook: git runs `<hooksPath>/<name>`, so the file name is the name.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, mut received) = serving(&token, 0).await;

    let (code, stderr) = run_stand_in(
        &stand_in(dir.path(), "prepare-commit-msg"),
        port,
        &token,
        &[],
        None,
        dir.path(),
    )
    .await;

    assert_eq!(code, Some(0));
    assert_eq!(stderr, "prepare-commit-msg: working\n");
    let request = received.recv().await.expect("the server saw it");
    assert_eq!(request.hook, "prepare-commit-msg");
}

#[tokio::test]
async fn forwards_the_arguments_git_passed() {
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, mut received) = serving(&token, 0).await;

    run_stand_in(
        &stand_in(dir.path(), "commit-msg"),
        port,
        &token,
        &[".git/COMMIT_EDITMSG"],
        None,
        dir.path(),
    )
    .await;

    let request = received.recv().await.expect("the server saw it");
    assert_eq!(request.arguments, vec![".git/COMMIT_EDITMSG".to_owned()]);
}

#[tokio::test]
async fn forwards_the_directory_git_ran_it_in() {
    // The hook has to run where the repository is, and git's own cwd is the only source of that.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let workdir = dir.path().join("repo");
    std::fs::create_dir(&workdir).expect("failed to create the directory");
    let token = generate_token();
    let (port, _handle, mut received) = serving(&token, 0).await;

    run_stand_in(
        &stand_in(dir.path(), "post-commit"),
        port,
        &token,
        &[],
        None,
        &workdir,
    )
    .await;

    let request = received.recv().await.expect("the server saw it");
    assert_eq!(
        std::fs::canonicalize(&request.cwd).expect("the path exists"),
        std::fs::canonicalize(&workdir).expect("the path exists")
    );
}

#[tokio::test]
async fn forwards_stdin_for_a_hook_that_receives_it() {
    // `pre-push` gets one line per ref on stdin. It has to arrive byte for byte, because the app writes
    // it to a file for `git hook run --to-stdin`.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, mut received) = serving(&token, 0).await;
    let piped = b"refs/heads/main abc123 refs/heads/main def456\n";

    let (code, _) = run_stand_in(
        &stand_in(dir.path(), "pre-push"),
        port,
        &token,
        &["origin", "git@example.invalid:repo.git"],
        Some(piped),
        dir.path(),
    )
    .await;

    assert_eq!(code, Some(0));
    let request = received.recv().await.expect("the server saw it");
    assert_eq!(request.stdin, piped.to_vec());
}

#[tokio::test]
async fn does_not_read_stdin_for_a_hook_that_gets_none() {
    // The trap `rdc-trampoline` documents: reading stdin unconditionally blocks until git closes the
    // pipe, which for a hook git never writes to means hanging the whole operation. Passing at all is
    // the assertion — a regression here shows up as this test timing out.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, _received) = serving(&token, 0).await;

    let path = stand_in(dir.path(), "pre-commit");
    let mut child = tokio::process::Command::new(&path)
        .current_dir(dir.path())
        .env(PORT_ENV, port.to_string())
        .env(TOKEN_ENV, &token)
        // Piped and never written to, nor closed until after the wait below — exactly what git does for
        // a hook it has no data for.
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn");
    let _pipe = child.stdin.take().expect("stdin was piped");

    let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
        .await
        .expect("the stand-in must not wait on stdin it will never receive")
        .expect("it should exit");

    assert!(status.success());
}

#[tokio::test]
async fn exits_with_the_hook_exit_code() {
    // What makes git behave as if it had run the hook itself: a non-zero code from `pre-commit` aborts
    // the commit, and that decision is git's to make from this number.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, _received) = serving(&token, 3).await;

    let (code, _) = run_stand_in(
        &stand_in(dir.path(), "pre-commit"),
        port,
        &token,
        &[],
        None,
        dir.path(),
    )
    .await;

    assert_eq!(code, Some(3));
}

#[tokio::test]
async fn writes_the_hook_output_to_its_own_stderr() {
    // git captures hook output from stderr, so that is where it has to land — not stdout.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();

    let server = HookServer::bind(
        token.clone(),
        runner(|_request, sink: StderrSink| async move {
            let _ = sink.send(b"line one\n".to_vec());
            let _ = sink.send(b"line two\n".to_vec());
            0
        }),
    )
    .await
    .expect("binding should succeed");
    let port = server.port().expect("a port");
    let _handle = server.serve();

    let path = stand_in(dir.path(), "pre-commit");
    let output = tokio::process::Command::new(&path)
        .current_dir(dir.path())
        .env(PORT_ENV, port.to_string())
        .env(TOKEN_ENV, &token)
        .stdin(Stdio::null())
        .output()
        .await
        .expect("the stand-in should exit");

    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "line one\nline two\n"
    );
    assert!(
        output.stdout.is_empty(),
        "nothing may go to stdout: git reads hook output from stderr"
    );
}

#[tokio::test]
async fn fails_closed_when_the_app_cannot_be_reached() {
    // A hook that didn't run is not a hook that passed. Reporting success here would let a commit through
    // that the user's pre-commit hook would have blocked.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");

    let (code, stderr) = run_stand_in(
        &stand_in(dir.path(), "pre-commit"),
        // Privileged and nothing of ours listens there.
        1,
        &generate_token(),
        &[],
        None,
        dir.path(),
    )
    .await;

    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("pre-commit"),
        "the message must name the hook, since git only says one failed: {stderr}"
    );
}

#[tokio::test]
async fn fails_closed_with_the_wrong_token() {
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, _received) = serving(&token, 0).await;

    let (code, stderr) = run_stand_in(
        &stand_in(dir.path(), "pre-commit"),
        port,
        &generate_token(),
        &[],
        None,
        dir.path(),
    )
    .await;

    assert_eq!(code, Some(1), "{stderr}");
}

#[tokio::test]
async fn explains_itself_when_run_outside_a_git_operation() {
    // A stand-in left behind in a hooks directory — a crash mid-operation — must produce a message a user
    // can act on rather than a silent failure or a panic.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let path = stand_in(dir.path(), "pre-commit");

    let output = tokio::process::Command::new(&path)
        .current_dir(dir.path())
        .env_remove(PORT_ENV)
        .env_remove(TOKEN_ENV)
        .stdin(Stdio::null())
        .output()
        .await
        .expect("the stand-in should exit");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(PORT_ENV), "{stderr}");
    assert!(stderr.contains("pre-commit"), "{stderr}");
}

#[tokio::test]
async fn forwards_the_environment_git_set() {
    // The `GIT_*` variables are how a hook knows what it is acting on — `GIT_INDEX_FILE`, `GITHEAD_*`.
    // The app filters them; this only has to carry them across.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, mut received) = serving(&token, 0).await;

    let path = stand_in(dir.path(), "pre-commit");
    tokio::process::Command::new(&path)
        .current_dir(dir.path())
        .env(PORT_ENV, port.to_string())
        .env(TOKEN_ENV, &token)
        .env("GIT_INDEX_FILE", "/repo/.git/index")
        .env("GIT_AUTHOR_NAME", "Someone")
        .stdin(Stdio::null())
        .output()
        .await
        .expect("the stand-in should exit");

    let request = received.recv().await.expect("the server saw it");
    assert_eq!(
        request
            .environment
            .get("GIT_INDEX_FILE")
            .map(String::as_str),
        Some("/repo/.git/index")
    );
    assert_eq!(
        request
            .environment
            .get("GIT_AUTHOR_NAME")
            .map(String::as_str),
        Some("Someone")
    );
    // And the token reached it through the environment, which is how it got there in the first place.
    assert_eq!(
        request.environment.get(TOKEN_ENV).map(String::as_str),
        Some(token.as_str())
    );
}

#[tokio::test]
async fn several_hooks_run_over_one_operation() {
    // git runs each hook as a fresh process within a single operation; the server outlives all of them.
    let dir = tempfile::tempdir().expect("failed to create a temporary directory");
    let token = generate_token();
    let (port, _handle, mut received) = serving(&token, 0).await;

    for hook in [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
    ] {
        let (code, stderr) = run_stand_in(
            &stand_in(dir.path(), hook),
            port,
            &token,
            &[],
            None,
            dir.path(),
        )
        .await;

        assert_eq!(code, Some(0), "{hook}: {stderr}");
        assert_eq!(stderr, format!("{hook}: working\n"));
    }

    let mut seen = Vec::new();
    while let Ok(request) = received.try_recv() {
        seen.push(request.hook);
    }
    assert_eq!(seen.len(), 4, "{seen:?}");
}
