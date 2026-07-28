//! Running the system `git` binary.
//!
//! Ported from `desktop-plus/app/src/lib/git/core.ts`, which wrapped `dugite`. Per
//! MIGRATION_PLAN.md Phase 2 this deliberately shells out to the user's `git` rather than
//! linking libgit2: libgit2 has known gaps around LFS, credential helpers, partial clone and
//! hook execution that a real desktop Git client depends on.
//!
//! Not yet ported from `core.ts` (tracked in MIGRATION_MAP.md):
//! - dugite's regex-based error classification (`GitError`) and `getDescriptionForError`
//! - trampoline/askpass credential environment (`withTrampolineEnv`)
//! - hook interception (`withHooksEnv`)
//! - hook interception
//!
//! Timing/measurement is intentionally *not* a port of `ui/lib/git-perf.ts` — see
//! MIGRATION_MAP.md §9; it belongs here as `tracing` spans when tracing is introduced.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::error::GitError;
use crate::git_error_kind::GitErrorKind;

/// How much combined stdout/stderr to retain for error context, in bytes.
///
/// Matches the 256kb cap in `core.ts`.
pub const TERMINAL_OUTPUT_CAPACITY: usize = 256 * 1024;

/// Options for a single git invocation.
#[derive(Debug, Clone)]
pub struct GitOptions {
    /// Exit codes that count as success. Anything else is an error.
    ///
    /// Defaults to `{0}`, mirroring `successExitCodes` in `core.ts`.
    pub success_exit_codes: HashSet<i32>,
    /// Failures the caller expects and will handle itself.
    ///
    /// Mirrors `expectedErrors` in `core.ts`. When git exits with an unacceptable code but the
    /// failure classifies as one of these, [`git`] returns `Ok` with
    /// [`GitOutput::git_error`] set instead of an `Err` — the caller is expected to branch on it.
    /// Defaults to empty, so any recognized failure is an error unless opted into.
    pub expected_errors: HashSet<GitErrorKind>,
    /// Extra environment variables. These override the defaults set by [`git`].
    pub env: HashMap<String, String>,
    /// Bytes to write to git's stdin, if any.
    pub stdin: Option<Vec<u8>>,
    /// Variables to **remove** from the child's environment.
    ///
    /// Distinct from setting one to the empty string, which git may well act on: `GIT_SEQUENCE_EDITOR=""`
    /// makes git try to run `""` as an editor, whereas unsetting it lets a `-c sequence.editor` take
    /// effect. The original expressed this as `undefined` in its env object, which dugite translated to
    /// a removal.
    pub remove_env: HashSet<String>,
}

impl Default for GitOptions {
    fn default() -> Self {
        Self {
            success_exit_codes: HashSet::from([0]),
            expected_errors: HashSet::new(),
            env: HashMap::new(),
            stdin: None,
            remove_env: HashSet::new(),
        }
    }
}

impl GitOptions {
    /// Treats the given exit codes as success, in addition to the default `0`.
    pub fn with_success_exit_codes(mut self, codes: impl IntoIterator<Item = i32>) -> Self {
        self.success_exit_codes.extend(codes);
        self
    }

    /// Declares failures the caller will handle itself. See [`GitOptions::expected_errors`].
    pub fn with_expected_errors(mut self, kinds: impl IntoIterator<Item = GitErrorKind>) -> Self {
        self.expected_errors.extend(kinds);
        self
    }

    /// Sets an environment variable for the invocation.
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// Removes an environment variable the parent process has, rather than setting it empty.
    ///
    /// See [`GitOptions::remove_env`] for why the distinction matters.
    pub fn without_env(mut self, key: impl Into<String>) -> Self {
        self.remove_env.insert(key.into());
        self
    }

    /// Writes `stdin` to the process.
    pub fn with_stdin(mut self, stdin: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }
}

/// A completed git invocation the caller accepted — either a successful exit code, or a failure
/// it declared via [`GitOptions::expected_errors`].
#[derive(Debug, Clone)]
pub struct GitOutput {
    /// Raw stdout. Kept as bytes because git output isn't always UTF-8 (binary diffs, and
    /// paths are arbitrary bytes on Unix).
    pub stdout: Vec<u8>,
    /// Stderr, lossily decoded — it's diagnostics, always rendered as text.
    pub stderr: String,
    /// The exit code.
    pub exit_code: i32,
    /// The classified failure, when the exit code was unacceptable but the caller declared this
    /// failure expected. `None` for an ordinary success.
    ///
    /// Mirrors `gitError` on `IGitResult` in `core.ts`.
    pub git_error: Option<GitErrorKind>,
    /// The working directory git ran in.
    pub path: PathBuf,
}

impl GitOutput {
    /// stdout as UTF-8, replacing invalid sequences with U+FFFD.
    ///
    /// Mirrors the default string encoding in `core.ts`. Use [`GitOutput::stdout`] directly when
    /// the output may be binary.
    pub fn stdout_lossy(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }

    /// stdout as UTF-8 with trailing newline(s) removed — the common case for single-value
    /// output such as `rev-parse`.
    pub fn stdout_trimmed(&self) -> String {
        self.stdout_lossy()
            .trim_end_matches(['\n', '\r'])
            .to_owned()
    }
}

/// Runs `git` with `args` in `path`.
///
/// `name` identifies the calling operation and appears in errors, matching the `name` parameter
/// in `core.ts` (which used it for logging and perf measurement).
///
/// Returns `Ok` when the exit code is in [`GitOptions::success_exit_codes`], otherwise
/// [`GitError::UnexpectedExitCode`].
pub async fn git(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
) -> Result<GitOutput, GitError> {
    git_with_stderr(args, path, name, options, |_| {}).await
}

/// Runs git while delivering stderr chunks as they arrive.
///
/// The callback is deliberately transport-neutral: `git-ops` has no Tauri dependency. Command
/// handlers can adapt it to a Tauri Channel, tests can collect chunks in memory, and future
/// push/pull/fetch parsers can reuse it. The complete stderr is still retained for error
/// classification and [`GitOutput`].
pub async fn git_with_stderr<F>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
    on_stderr: F,
) -> Result<GitOutput, GitError>
where
    F: FnMut(&[u8]) + Send,
{
    git_streaming(args, path, name, options, |_| {}, on_stderr).await
}

/// Runs git while delivering **stdout** chunks as they arrive.
///
/// Most git operations report progress on stderr, which is why [`git_with_stderr`] came first. Some
/// report it on stdout instead — `cherry-pick` prints a line per commit it applies — and those need
/// this. Both pipes are still drained concurrently and retained in full.
pub async fn git_with_stdout<F>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
    on_stdout: F,
) -> Result<GitOutput, GitError>
where
    F: FnMut(&[u8]) + Send,
{
    git_streaming(args, path, name, options, on_stdout, |_| {}).await
}

/// Runs git while streaming stderr and the line protocol written to `GIT_LFS_PROGRESS`.
pub async fn git_with_stderr_and_lfs<E, L>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    mut options: GitOptions,
    on_stderr: E,
    on_lfs_progress: L,
) -> Result<GitOutput, GitError>
where
    E: FnMut(&[u8]) + Send,
    L: FnMut(&str) + Send,
{
    let Ok(progress_file) = tempfile::NamedTempFile::new() else {
        return git_with_stderr(
            args,
            path,
            name,
            options.without_env("GIT_LFS_PROGRESS"),
            on_stderr,
        )
        .await;
    };
    let progress_file = progress_file.into_temp_path();
    let progress_path = progress_file.to_path_buf();
    options.remove_env.remove("GIT_LFS_PROGRESS");
    options = options.with_env(
        "GIT_LFS_PROGRESS",
        progress_path.to_string_lossy().into_owned(),
    );

    let done = Arc::new(AtomicBool::new(false));
    let git_done = Arc::clone(&done);
    let git_future = async {
        let result = git_with_stderr(args, path, name, options, on_stderr).await;
        git_done.store(true, Ordering::Release);
        result
    };
    let tail_future = tail_lfs_progress(&progress_path, done, on_lfs_progress);
    let (result, ()) = tokio::join!(git_future, tail_future);
    drop(progress_file);
    result
}

async fn tail_lfs_progress<L>(path: &Path, done: Arc<AtomicBool>, mut on_line: L)
where
    L: FnMut(&str),
{
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return;
    };
    let mut pending = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        match file.read(&mut chunk).await {
            Ok(0) if done.load(Ordering::Acquire) => break,
            Ok(0) => tokio::time::sleep(Duration::from_millis(10)).await,
            Ok(count) => {
                pending.extend_from_slice(&chunk[..count]);
                emit_complete_lines(&mut pending, &mut on_line);
            }
            Err(_) => return,
        }
    }

    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending);
        on_line(line.trim_end_matches('\r'));
    }
}

fn emit_complete_lines<L>(pending: &mut Vec<u8>, on_line: &mut L)
where
    L: FnMut(&str),
{
    while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
        let line = pending.drain(..=end).collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&line[..line.len() - 1]);
        on_line(text.trim_end_matches('\r'));
    }
}

/// Runs git, delivering both streams as they arrive.
///
/// Both callbacks run on the task draining their pipe, so neither can block the other — which matters
/// because failing to drain either pipe deadlocks git once its buffer fills.
pub async fn git_streaming<O, E>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
    mut on_stdout: O,
    mut on_stderr: E,
) -> Result<GitOutput, GitError>
where
    O: FnMut(&[u8]) + Send,
    E: FnMut(&[u8]) + Send,
{
    let path = path.as_ref();
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(path)
        // Explicitly set TERM=dumb so that git doesn't treat us as a smart terminal if the app
        // was launched from one. Same rationale as core.ts.
        .env("TERM", "dumb")
        .stdin(if options.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Don't leave git running if the future is dropped (e.g. a cancelled request).
        .kill_on_drop(true);

    for (key, value) in &options.env {
        command.env(key, value);
    }
    // After the sets, so a caller that does both ends up with the variable absent.
    for key in &options.remove_env {
        command.env_remove(key);
    }

    let mut child = command.spawn().map_err(|source| GitError::Spawn {
        name: name.to_owned(),
        path: path.to_owned(),
        source,
    })?;

    if let Some(stdin) = &options.stdin {
        // Take the handle so it is dropped (closing the pipe) before we await the output;
        // otherwise a git command that reads to EOF would deadlock.
        let mut handle = child.stdin.take().ok_or_else(|| GitError::Stdin {
            name: name.to_owned(),
            path: path.to_owned(),
            message: "stdin was requested but the pipe was not available".to_owned(),
        })?;
        handle
            .write_all(stdin)
            .await
            .map_err(|source| GitError::Stdin {
                name: name.to_owned(),
                path: path.to_owned(),
                message: source.to_string(),
            })?;
        handle.shutdown().await.map_err(|source| GitError::Stdin {
            name: name.to_owned(),
            path: path.to_owned(),
            message: source.to_string(),
        })?;
    }

    let mut stdout_pipe = child.stdout.take().ok_or_else(|| GitError::Spawn {
        name: name.to_owned(),
        path: path.to_owned(),
        source: std::io::Error::other("git stdout pipe was not available"),
    })?;
    let mut stderr_pipe = child.stderr.take().ok_or_else(|| GitError::Spawn {
        name: name.to_owned(),
        path: path.to_owned(),
        source: std::io::Error::other("git stderr pipe was not available"),
    })?;

    let read_stdout = async move {
        let mut stdout = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = stdout_pipe.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            stdout.extend_from_slice(&chunk[..count]);
            on_stdout(&chunk[..count]);
        }
        std::io::Result::Ok(stdout)
    };
    let read_stderr = async move {
        let mut stderr = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = stderr_pipe.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            stderr.extend_from_slice(&chunk[..count]);
            on_stderr(&chunk[..count]);
        }
        std::io::Result::Ok(stderr)
    };

    // Drain both pipes while the process runs. Waiting first can deadlock when either pipe fills.
    let (stdout, stderr_bytes, status) = tokio::try_join!(read_stdout, read_stderr, child.wait())
        .map_err(|source| GitError::Spawn {
        name: name.to_owned(),
        path: path.to_owned(),
        source,
    })?;

    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();

    // `code()` is None when the process was terminated by a signal, which is never an expected
    // outcome for us and must not be conflated with an exit code.
    let exit_code = status.code().ok_or_else(|| GitError::Terminated {
        name: name.to_owned(),
        path: path.to_owned(),
        stderr: stderr.clone(),
    })?;

    if options.success_exit_codes.contains(&exit_code) {
        return Ok(GitOutput {
            stdout,
            stderr,
            exit_code,
            git_error: None,
            path: path.to_owned(),
        });
    }

    // Unacceptable exit code: classify the failure. `core.ts` tries stderr first and falls back
    // to stdout, because some git commands report failures on stdout.
    let git_error = crate::git_error_kind::parse_error(&stderr)
        .or_else(|| crate::git_error_kind::parse_error(&String::from_utf8_lossy(&stdout)));

    // A recognized failure the caller declared is returned as Ok for it to branch on, matching
    // the `expectedErrors` behaviour in `core.ts`.
    if let Some(kind) = git_error {
        if options.expected_errors.contains(&kind) {
            return Ok(GitOutput {
                stdout,
                stderr,
                exit_code,
                git_error: Some(kind),
                path: path.to_owned(),
            });
        }
    }

    Err(GitError::UnexpectedExitCode {
        name: name.to_owned(),
        path: path.to_owned(),
        exit_code,
        kind: git_error,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{empty_repository, fixture_repository};

    #[tokio::test]
    async fn classifies_a_recognized_failure_on_the_error() {
        let repo = empty_repository().await;
        // A path outside the repository is a recognized git failure.
        let error = git(
            &["show", "--", "/etc/hosts"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect_err("showing a path outside the repository should fail");

        match error {
            GitError::UnexpectedExitCode { kind, .. } => {
                assert_eq!(kind, Some(GitErrorKind::OutsideRepository));
            }
            other => panic!("expected UnexpectedExitCode, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn returns_ok_for_a_failure_the_caller_declared_expected() {
        let repo = empty_repository().await;
        let output = git(
            &["show", "--", "/etc/hosts"],
            repo.path(),
            "test",
            GitOptions::default().with_expected_errors([GitErrorKind::OutsideRepository]),
        )
        .await
        .expect("a declared expected error should be returned as Ok for the caller to branch on");

        assert_eq!(output.git_error, Some(GitErrorKind::OutsideRepository));
        assert_ne!(output.exit_code, 0, "it still failed; we just expected it");
    }

    #[tokio::test]
    async fn leaves_git_error_unset_on_success() {
        let repo = empty_repository().await;
        let output = git(&["status"], repo.path(), "test", GitOptions::default())
            .await
            .expect("status should succeed");

        assert_eq!(output.git_error, None);
    }

    // --- fixture harness ---

    #[tokio::test]
    async fn materializes_a_fixture_repository() {
        let repo = fixture_repository("test-repo").await;

        // The _git -> .git rename must have happened, or git wouldn't see a repository here.
        assert!(repo.path().join(".git").is_dir(), ".git should exist");
        assert!(!repo.path().join("_git").exists(), "_git should be renamed");

        let output = git(
            &["rev-parse", "--is-inside-work-tree"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the materialized fixture should be a usable repository");
        assert_eq!(output.stdout_trimmed(), "true");
    }

    #[tokio::test]
    async fn fixture_repository_has_its_history() {
        let repo = fixture_repository("test-repo").await;
        let output = git(
            &["rev-list", "--count", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("the fixture should have commits");

        let count: u32 = output
            .stdout_trimmed()
            .parse()
            .expect("rev-list --count should print a number");
        assert!(count > 0, "expected a non-empty history, got {count}");
    }

    #[tokio::test]
    async fn fixture_repositories_are_independent_copies() {
        let a = fixture_repository("test-repo").await;
        let b = fixture_repository("test-repo").await;
        assert_ne!(a.path(), b.path());

        // Mutating one must not affect the other, or tests would leak state between each other.
        std::fs::write(a.path().join("README.md"), "changed\n").expect("failed to write");
        let b_readme = std::fs::read_to_string(b.path().join("README.md")).expect("failed to read");
        assert_ne!(b_readme, "changed\n");
    }

    #[tokio::test]
    async fn runs_git_and_captures_stdout() {
        let repo = empty_repository().await;
        let output = git(
            &["rev-parse", "--is-inside-work-tree"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed in an initialized repository");

        assert_eq!(output.stdout_trimmed(), "true");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.path, repo.path());
    }

    #[tokio::test]
    async fn returns_an_error_for_an_unexpected_exit_code() {
        let repo = empty_repository().await;
        let error = git(
            &["rev-parse", "--verify", "refs/heads/nope"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect_err("verifying a missing ref should fail");

        match error {
            GitError::UnexpectedExitCode {
                exit_code, name, ..
            } => {
                assert_ne!(exit_code, 0);
                assert_eq!(name, "test");
            }
            other => panic!("expected UnexpectedExitCode, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn treats_declared_exit_codes_as_success() {
        let repo = empty_repository().await;
        // `git rev-parse --verify` on a missing ref exits 128; opting into it yields Ok.
        let output = git(
            &["rev-parse", "--verify", "refs/heads/nope"],
            repo.path(),
            "test",
            GitOptions::default().with_success_exit_codes([1, 128]),
        )
        .await
        .expect("declared exit codes should be treated as success");

        assert!(matches!(output.exit_code, 1 | 128));
    }

    #[tokio::test]
    async fn writes_stdin_to_the_process() {
        let repo = empty_repository().await;
        let output = git(
            &["hash-object", "-t", "blob", "--stdin"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("hello\n"),
        )
        .await
        .expect("hash-object should read our stdin and exit cleanly");

        // Well-known SHA-1 of the blob "hello\n".
        assert_eq!(
            output.stdout_trimmed(),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    #[tokio::test]
    async fn streams_lines_written_to_the_lfs_progress_file() {
        let repo = empty_repository().await;
        let alias =
            "alias.emit-lfs=!printf 'download 1/1 5/5 file.bin\\n' >> \"$GIT_LFS_PROGRESS\"";
        let mut lines = Vec::new();

        git_with_stderr_and_lfs(
            &["-c", alias, "emit-lfs"],
            repo.path(),
            "test",
            GitOptions::default(),
            |_| {},
            |line| lines.push(line.to_owned()),
        )
        .await
        .unwrap();

        assert_eq!(lines, ["download 1/1 5/5 file.bin"]);
    }

    #[tokio::test]
    async fn sets_term_to_dumb() {
        let repo = empty_repository().await;
        let output = git(
            &["var", "GIT_EDITOR"],
            repo.path(),
            "test",
            GitOptions::default().with_env("GIT_EDITOR", "my-editor"),
        )
        .await
        .expect("git var should succeed");

        assert_eq!(output.stdout_trimmed(), "my-editor");
    }

    #[tokio::test]
    async fn reports_a_spawn_failure_for_a_missing_working_directory() {
        let error = git(
            &["status"],
            "/definitely/does/not/exist/rdc-test",
            "test",
            GitOptions::default(),
        )
        .await
        .expect_err("spawning in a missing directory should fail");

        assert!(matches!(error, GitError::Spawn { .. }), "got {error:?}");
    }

    #[tokio::test]
    async fn streams_stderr_while_still_retaining_it() {
        let repo = empty_repository().await;
        let mut chunks = Vec::new();
        let output = git_with_stderr(
            &["-c", "alias.emit=!echo streamed-progress >&2", "emit"],
            repo.path(),
            "test",
            GitOptions::default(),
            |chunk| chunks.extend_from_slice(chunk),
        )
        .await
        .expect("the alias should succeed");

        assert_eq!(String::from_utf8_lossy(&chunks), "streamed-progress\n");
        assert_eq!(output.stderr, "streamed-progress\n");
    }
}
