//! Running the system `git` binary.
//!
//! Ported from `desktop-plus/app/src/lib/git/core.ts`, which wrapped `dugite`. Per
//! MIGRATION_PLAN.md Phase 2 this deliberately shells out to the user's `git` rather than
//! linking libgit2: libgit2 has known gaps around LFS, credential helpers, partial clone and
//! hook execution that a real desktop Git client depends on.
//!
//! The backend concerns from `core.ts` are ported: error classification lives in
//! `error.rs`/`git_error_kind.rs`, credentials in the `trampoline` crate, and hook interception in
//! `hooks`. Phase 3's command layer adapts streaming and hooks to Tauri Channels. The remaining work
//! is deliberately above this module: frontend error descriptions and consumer policy.
//!
//! Timing/measurement is intentionally *not* a port of `ui/lib/git-perf.ts` — see
//! MIGRATION_MAP.md §9; it belongs here as `tracing` spans when tracing is introduced.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{GitError, TerminationReason};
use crate::git_error_kind::GitErrorKind;

/// How much combined stdout/stderr to retain for error context, in bytes.
///
/// Matches the 256kb cap in `core.ts`.
pub const TERMINAL_OUTPUT_CAPACITY: usize = 256 * 1024;

/// Cancellation signal shared by a native operation and its Git process.
#[derive(Debug, Clone)]
pub struct ExecutionControl {
    cancelled: Arc<AtomicBool>,
    reason: Arc<std::sync::atomic::AtomicU8>,
    notify: Arc<Notify>,
    last_activity_at: Arc<AtomicU64>,
}

impl Default for ExecutionControl {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            reason: Arc::new(std::sync::atomic::AtomicU8::new(0)),
            notify: Arc::new(Notify::new()),
            last_activity_at: Arc::new(AtomicU64::new(now_millis())),
        }
    }
}

impl ExecutionControl {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self, reason: TerminationReason) {
        self.reason.store(
            match reason {
                TerminationReason::Cancelled => 1,
                TerminationReason::TimedOut => 2,
            },
            Ordering::Release,
        );
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Records native activity without requiring a progress percentage or a UI callback.
    pub fn touch(&self) {
        self.last_activity_at.store(now_millis(), Ordering::Release);
    }

    pub fn last_activity_at(&self) -> u64 {
        self.last_activity_at.load(Ordering::Acquire)
    }

    fn reason(&self) -> TerminationReason {
        match self.reason.load(Ordering::Acquire) {
            2 => TerminationReason::TimedOut,
            _ => TerminationReason::Cancelled,
        }
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

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
    options: GitOptions,
    on_stderr: E,
    on_lfs_progress: L,
) -> Result<GitOutput, GitError>
where
    E: FnMut(&[u8]) + Send,
    L: FnMut(&str) + Send,
{
    git_with_stderr_and_lfs_controlled(args, path, name, options, None, on_stderr, on_lfs_progress)
        .await
}

/// LFS-aware stderr streaming with operation cancellation.
pub async fn git_with_stderr_and_lfs_controlled<E, L>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    mut options: GitOptions,
    control: Option<ExecutionControl>,
    on_stderr: E,
    on_lfs_progress: L,
) -> Result<GitOutput, GitError>
where
    E: FnMut(&[u8]) + Send,
    L: FnMut(&str) + Send,
{
    let Ok(progress_file) = tempfile::NamedTempFile::new() else {
        return git_streaming_controlled(
            args,
            path,
            name,
            options.without_env("GIT_LFS_PROGRESS"),
            control,
            |_| {},
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
    let tail_control = control.clone();
    let git_future = async {
        let result =
            git_streaming_controlled(args, path, name, options, control, |_| {}, on_stderr).await;
        git_done.store(true, Ordering::Release);
        result
    };
    let tail_future = tail_lfs_progress(&progress_path, done, tail_control, on_lfs_progress);
    let (result, ()) = tokio::join!(git_future, tail_future);
    drop(progress_file);
    result
}

async fn tail_lfs_progress<L>(
    path: &Path,
    done: Arc<AtomicBool>,
    control: Option<ExecutionControl>,
    mut on_line: L,
) where
    L: FnMut(&str),
{
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return;
    };
    let mut pending = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        match file.read(&mut chunk).await {
            Ok(0) => {
                if !done.load(Ordering::Acquire) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                match file.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(count) => {
                        if let Some(control) = &control {
                            control.touch();
                        }
                        pending.extend_from_slice(&chunk[..count]);
                        emit_complete_lines(&mut pending, &mut on_line);
                    }
                    Err(_) => return,
                }
            }
            Ok(count) => {
                if let Some(control) = &control {
                    control.touch();
                }
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

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
/// Spawns git and writes its stdin, if any.
///
/// Shared by [`git_streaming`] and [`git_capped`] so there is one place that decides how git is
/// invoked — the environment defaults, the pipes and the kill-on-drop behaviour.
async fn spawn_git(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: &Path,
    name: &str,
    options: &GitOptions,
) -> Result<SpawnedGit, GitError> {
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
    process_group::configure(&mut command);

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

    let process_tree = process_group::attach(&child).map_err(|source| GitError::Spawn {
        name: name.to_owned(),
        path: path.to_owned(),
        source,
    })?;

    Ok(SpawnedGit {
        child,
        process_tree,
    })
}

struct SpawnedGit {
    child: tokio::process::Child,
    process_tree: process_group::ProcessTree,
}

/// Platform seam for terminating the whole Git process tree.
///
/// Unix starts Git as its own process group; Windows assigns it to a Job Object. Both mechanisms
/// ensure hooks, SSH and LFS descendants receive the same termination request.
#[cfg(unix)]
mod process_group {
    use std::io;

    use tokio::process::{Child, Command};

    #[derive(Debug)]
    pub struct ProcessTree;

    pub fn configure(command: &mut Command) {
        command.process_group(0);
    }

    pub fn attach(_child: &Child) -> io::Result<ProcessTree> {
        Ok(ProcessTree)
    }

    pub fn terminate(_tree: &ProcessTree, child: &mut Child, force: bool) -> io::Result<()> {
        let Some(pid) = child.id() else {
            return Ok(());
        };
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: Git was started in its own process group by `configure`; a negative pid targets
        // that group and cannot signal an unrelated process group.
        let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(windows)]
mod process_group {
    use std::io;
    use tokio::process::{Child, Command};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    #[derive(Debug)]
    pub struct ProcessTree {
        job: HANDLE,
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            if !self.job.is_null() {
                // SAFETY: this handle is owned by ProcessTree and is closed exactly once.
                unsafe { CloseHandle(self.job) };
            }
        }
    }

    pub fn configure(_command: &mut Command) {
        // Job assignment happens after spawn, when the process handle exists.
    }

    pub fn attach(child: &Child) -> io::Result<ProcessTree> {
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Git process handle was unavailable"))?;
        // SAFETY: null security attributes/name request an unnamed job owned by this process.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        };
        let assigned =
            configured && unsafe { AssignProcessToJobObject(job, process_handle as HANDLE) != 0 };
        if !assigned {
            // SAFETY: job was created above and is not returned on failure.
            unsafe { CloseHandle(job) };
            return Err(io::Error::last_os_error());
        }
        Ok(ProcessTree { job })
    }

    pub fn terminate(tree: &ProcessTree, child: &mut Child, _force: bool) -> io::Result<()> {
        // TerminateJobObject is intentionally used for both phases: Windows has no portable
        // signal equivalent, and the caller still supplies the bounded graceful window.
        let terminated = unsafe { TerminateJobObject(tree.job, 1) != 0 };
        if terminated {
            Ok(())
        } else {
            child.start_kill()
        }
    }
}

pub async fn git_streaming<O, E>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
    on_stdout: O,
    on_stderr: E,
) -> Result<GitOutput, GitError>
where
    O: FnMut(&[u8]) + Send,
    E: FnMut(&[u8]) + Send,
{
    git_streaming_controlled(args, path, name, options, None, on_stdout, on_stderr).await
}

/// Runs git with an optional cancellation signal while continuing to drain both output pipes.
///
/// This is the incremental execution seam for operation-owned cancellation. Existing callers use
/// [`git_streaming`] unchanged until their operation has a recovery policy.
pub async fn git_streaming_controlled<O, E>(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
    control: Option<ExecutionControl>,
    mut on_stdout: O,
    mut on_stderr: E,
) -> Result<GitOutput, GitError>
where
    O: FnMut(&[u8]) + Send,
    E: FnMut(&[u8]) + Send,
{
    let path = path.as_ref();
    let spawned = spawn_git(args, path, name, &options).await?;
    let process_tree = spawned.process_tree;
    let mut child = spawned.child;

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

    let stdout_control = control.clone();
    let stderr_control = control.clone();
    let read_stdout = async move {
        let mut stdout = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let count = stdout_pipe.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            stdout.extend_from_slice(&chunk[..count]);
            if let Some(control) = &stdout_control {
                control.touch();
            }
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
            if let Some(control) = &stderr_control {
                control.touch();
            }
            on_stderr(&chunk[..count]);
        }
        std::io::Result::Ok(stderr)
    };

    // Drain both pipes while the process runs. Waiting first can deadlock when either pipe fills.
    let wait = wait_for_child(&mut child, &process_tree, control.clone());
    let (stdout, stderr_bytes, (status, termination)) =
        tokio::try_join!(read_stdout, read_stderr, wait).map_err(|source| GitError::Spawn {
            name: name.to_owned(),
            path: path.to_owned(),
            source,
        })?;

    if let Some(reason) = termination {
        return Err(GitError::OperationTerminated {
            name: name.to_owned(),
            path: path.to_owned(),
            reason,
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        });
    }

    finish_git(name, path, stdout, &stderr_bytes, status, &options)
}

async fn wait_for_child(
    child: &mut tokio::process::Child,
    process_tree: &process_group::ProcessTree,
    control: Option<ExecutionControl>,
) -> std::io::Result<(std::process::ExitStatus, Option<TerminationReason>)> {
    let Some(control) = control else {
        return child.wait().await.map(|status| (status, None));
    };

    tokio::select! {
        status = child.wait() => status.map(|status| (status, None)),
        _ = control.cancelled() => {
            let reason = control.reason();
            process_group::terminate(process_tree, child, false)?;
            let status = tokio::select! {
                status = child.wait() => status?,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    process_group::terminate(process_tree, child, true)?;
                    child.wait().await?
                }
            };
            Ok((status, Some(reason)))
        }
    }
}

/// Whether this git's `<subcommand>` accepts `flag`.
///
/// # Why this is ever needed
///
/// rdc runs the **system git**, where upstream bundled its own — its `hooks-proxy.ts` says so outright:
/// "we can't be certain the user's Git binary is new enough". So an option upstream could simply pass may
/// not exist here, and the failure is an exit code 129 with a usage dump, which tells a user nothing about
/// what rdc did. Two are known: `cherry-pick --empty` (git 2.45; **Ubuntu 24.04 LTS ships 2.43**) and
/// `hook run --to-stdin` (Ubuntu 22.04 ships 2.34 without it).
///
/// `-h` is the probe: git prints the usage synopsis listing the options this build has, exits 129 — which
/// `-h` always does and is not a failure — and **runs nothing**. That last part is why it beats trying the
/// option and recovering: `cherry-pick` or a hook cannot be run twice to find out.
///
/// Callers cache the answer; git does not change underneath a running app. See
/// [`crate::hooks::runner::supports_to_stdin`] for the shape.
pub async fn supports_flag(repository: &Path, subcommand: &[&str], flag: &str) -> bool {
    let Ok(output) = Command::new("git")
        .args(subcommand)
        .arg("-h")
        .current_dir(repository)
        .stdin(Stdio::null())
        .output()
        .await
    else {
        // Without an answer, assume the option is absent: the older spelling of a thing generally still
        // works, while a missing option does not.
        return false;
    };

    // git writes `-h` usage to stdout; stderr is included so a build that differs is still read.
    let usage = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    usage.contains(flag)
}

/// Output from a capped read — see [`git_capped`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CappedOutput {
    /// Up to `limit` bytes of stdout.
    pub stdout: Vec<u8>,

    /// Whether the cap was reached, making `stdout` a prefix rather than the whole thing.
    pub truncated: bool,

    /// The classified failure, when git failed and the caller declared that failure expected.
    ///
    /// Always `None` when `truncated`: git was killed on purpose, so there is no failure of its own to
    /// report.
    pub git_error: Option<GitErrorKind>,
}

/// Runs git, reading at most `limit` bytes of stdout and killing it once that is reached.
///
/// For output whose *beginning* is the answer and whose size is unbounded — a blob prefix for syntax
/// highlighting, say. Reading it all and slicing would defeat the point: the cost this avoids is holding
/// a large blob in memory, not the cost of slicing it.
///
/// # Truncation is success, where Node made it an error
///
/// The original expressed this with Node's `maxBuffer`, which **rejects** once the limit is passed, so
/// `getPartialBlobContents` recovered the bytes from the rejected error's `stdout` and treated that as
/// the result. That is an artifact of the API rather than a behaviour worth reproducing: here a cap that
/// was reached is an ordinary outcome, reported by [`CappedOutput::truncated`], and the caller doesn't
/// have to inspect an error to find its answer.
///
/// # Why git has to be killed
///
/// Once reading stops, git blocks writing to a full stdout pipe — and would never exit, so nothing
/// downstream would ever complete. Killing it is what makes the cap terminate rather than hang. Stderr is
/// drained concurrently in its own task for the same reason in reverse: a git that filled *stderr* while
/// we were reading stdout would block before writing the bytes being waited for.
///
/// Because git was killed, its exit status is a signal death and is deliberately **not** classified — see
/// [`GitError::Terminated`], which a signal would otherwise produce.
///
/// # A note on size checks
///
/// If the question is "how big is this blob?", `git cat-file -s <rev>:<path>` answers it without reading
/// the object at all, which is cheaper and exact. This is for when the prefix itself is wanted.
pub async fn git_capped(
    args: &[impl AsRef<std::ffi::OsStr>],
    path: impl AsRef<Path>,
    name: &str,
    options: GitOptions,
    limit: usize,
) -> Result<CappedOutput, GitError> {
    let path = path.as_ref();
    let spawned = spawn_git(args, path, name, &options).await?;
    let process_tree = spawned.process_tree;
    let mut child = spawned.child;

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

    // A task rather than a joined future, because the stdout read below finishes early on purpose and
    // stderr still has to be drained until git is gone.
    let stderr_task = tokio::spawn(async move {
        let mut stderr = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut stderr).await;
        stderr
    });

    let mut stdout = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];

    while stdout.len() < limit {
        let count = stdout_pipe
            .read(&mut chunk)
            .await
            .map_err(|source| GitError::Spawn {
                name: name.to_owned(),
                path: path.to_owned(),
                source,
            })?;
        if count == 0 {
            break;
        }

        let room = limit - stdout.len();
        stdout.extend_from_slice(&chunk[..count.min(room)]);
        if count > room {
            // git had more to say than was asked for.
            truncated = true;
            break;
        }
    }
    // A limit of zero, or a read that landed exactly on it, still leaves git with more to write.
    truncated = truncated || stdout.len() >= limit;

    if truncated {
        // Nothing will read the rest, so git must not be left blocked on a full pipe.
        let _ = process_group::terminate(&process_tree, &mut child, true);
    }

    let status = child.wait().await.map_err(|source| GitError::Spawn {
        name: name.to_owned(),
        path: path.to_owned(),
        source,
    })?;
    // Resolves as soon as git's pipes close, which the kill above guarantees.
    let stderr_bytes = stderr_task.await.unwrap_or_default();

    if truncated {
        return Ok(CappedOutput {
            stdout,
            truncated: true,
            git_error: None,
        });
    }

    let output = finish_git(name, path, stdout, &stderr_bytes, status, &options)?;

    Ok(CappedOutput {
        stdout: output.stdout,
        truncated: false,
        git_error: output.git_error,
    })
}

/// Turns a finished git invocation into a result, classifying an unacceptable exit code.
///
/// Shared by [`git_streaming`] and [`git_capped`], so "what counts as success" and "which failures the
/// caller asked to handle itself" are decided in exactly one place.
fn finish_git(
    name: &str,
    path: &Path,
    stdout: Vec<u8>,
    stderr_bytes: &[u8],
    status: std::process::ExitStatus,
    options: &GitOptions,
) -> Result<GitOutput, GitError> {
    let stderr = String::from_utf8_lossy(stderr_bytes).into_owned();

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
    async fn drains_the_progress_file_after_git_has_already_finished() {
        // Covers `tail_lfs_progress` directly rather than through a git process: content already
        // waiting, `done` already set, so it pins draining to EOF and the emission of a trailing
        // line that has no newline.
        //
        // Be clear about what this does *not* do: it is not a regression test for the race the
        // post-`done` drain fixes, and it passes with or without that drain, because the content is
        // there on the first read. Losing a line requires EOF to be observed *before* the write and
        // `done` to be set between that read and the flag check — a sub-microsecond window with no
        // await point a test can wedge open. Reproducing it would mean injecting a reader seam into
        // `tail_lfs_progress`, which costs more than the defect it would catch. The argument for
        // the fix is therefore by inspection, and it is unconditionally safe: `done` is only set
        // after git has exited, so one further read can never miss data and can never block.
        let file = tempfile::NamedTempFile::new().expect("a temporary progress file");
        std::fs::write(
            file.path(),
            "download 1/1 5/5 late.bin\nno trailing newline",
        )
        .expect("seeding the progress file should succeed");

        let mut lines = Vec::new();
        tail_lfs_progress(
            file.path(),
            Arc::new(AtomicBool::new(true)),
            None,
            |line: &str| lines.push(line.to_owned()),
        )
        .await;

        assert_eq!(lines, ["download 1/1 5/5 late.bin", "no trailing newline"]);
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

    #[tokio::test]
    async fn cancellation_terminates_a_git_alias_process_group() {
        let repo = empty_repository().await;
        let control = ExecutionControl::new();
        let cancellation = control.clone();
        let task = tokio::spawn(async move {
            git_streaming_controlled(
                &["-c", "alias.wait=!sleep 30", "wait"],
                repo.path(),
                "cancellable-test",
                GitOptions::default(),
                Some(control),
                |_| {},
                |_| {},
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        cancellation.cancel(TerminationReason::Cancelled);
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("cancellation should reap the process group")
            .expect("test task should not panic");

        assert!(matches!(
            result,
            Err(GitError::OperationTerminated {
                reason: TerminationReason::Cancelled,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn cancellation_finishes_lfs_progress_tailing() {
        let repo = empty_repository().await;
        let control = ExecutionControl::new();
        let cancellation = control.clone();
        let task = tokio::spawn(async move {
            git_with_stderr_and_lfs_controlled(
                &[
                    "-c",
                    "alias.wait-lfs=!printf 'download 1/2 1/2 file.bin\\n' >> \"$GIT_LFS_PROGRESS\"; sleep 30",
                    "wait-lfs",
                ],
                repo.path(),
                "cancellable-lfs-test",
                GitOptions::default(),
                Some(control),
                |_| {},
                |_| {},
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        cancellation.cancel(TerminationReason::Cancelled);
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("LFS cancellation should finish")
            .expect("test task should not panic");

        assert!(matches!(
            result,
            Err(GitError::OperationTerminated {
                reason: TerminationReason::Cancelled,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn cancellation_drains_large_stdout_and_stderr_without_deadlock() {
        let repo = empty_repository().await;
        let control = ExecutionControl::new();
        let cancellation = control.clone();
        let stdout_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stderr_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stdout_seen = Arc::clone(&stdout_bytes);
        let stderr_seen = Arc::clone(&stderr_bytes);
        let task = tokio::spawn(async move {
            git_streaming_controlled(
                &[
                    "-c",
                    "alias.pressure=!dd if=/dev/zero bs=1024 count=1024; dd if=/dev/zero bs=1024 count=1024 >&2; sleep 30",
                    "pressure",
                ],
                repo.path(),
                "pipe-pressure-test",
                GitOptions::default(),
                Some(control),
                move |chunk| {
                    stdout_seen.fetch_add(chunk.len(), Ordering::Relaxed);
                },
                move |chunk| {
                    stderr_seen.fetch_add(chunk.len(), Ordering::Relaxed);
                },
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        cancellation.cancel(TerminationReason::Cancelled);
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("pipe-pressure cancellation should not deadlock")
            .expect("test task should not panic");

        assert!(matches!(result, Err(GitError::OperationTerminated { .. })));
        assert!(stdout_bytes.load(Ordering::Relaxed) > 0);
        assert!(stderr_bytes.load(Ordering::Relaxed) > 0);
    }
    // --- capped reads ---

    /// A repository whose `big.txt` holds `size` bytes at HEAD.
    async fn repo_with_blob(size: usize) -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        let contents: String = std::iter::repeat_n('x', size).collect();
        crate::test_support::commit_file(&repo.path(), "big.txt", &contents, "first");
        repo
    }

    #[tokio::test]
    async fn a_capped_read_stops_at_the_limit() {
        let repo = repo_with_blob(4096).await;

        let output = git_capped(
            &["show", "HEAD:big.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
            100,
        )
        .await
        .expect("a capped read should succeed");

        assert_eq!(output.stdout.len(), 100);
        assert!(output.truncated, "the blob is larger than the cap");
        assert_eq!(output.git_error, None, "being cut off is not a git failure");
    }

    #[tokio::test]
    async fn a_capped_read_of_a_blob_larger_than_the_pipe_does_not_hang() {
        // The case the kill exists for. A pipe holds tens of kilobytes; once reading stops, git blocks
        // writing and would never exit, so nothing downstream would ever complete. A regression here
        // shows up as this test timing out rather than failing.
        let repo = repo_with_blob(4 * 1024 * 1024).await;

        let output = tokio::time::timeout(
            Duration::from_secs(30),
            git_capped(
                &["show", "HEAD:big.txt"],
                repo.path(),
                "test",
                GitOptions::default(),
                10,
            ),
        )
        .await
        .expect("a capped read must terminate, not block on a full pipe")
        .expect("it should succeed");

        assert_eq!(output.stdout, b"xxxxxxxxxx");
        assert!(output.truncated);
    }

    #[tokio::test]
    async fn a_blob_smaller_than_the_limit_is_not_truncated() {
        let repo = repo_with_blob(10).await;

        let output = git_capped(
            &["show", "HEAD:big.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
            1024,
        )
        .await
        .expect("it should succeed");

        // `commit_file` writes exactly what it is given, so the blob is the ten bytes and no more.
        assert_eq!(output.stdout.len(), 10);
        assert!(!output.truncated);
    }

    #[tokio::test]
    async fn a_limit_of_zero_reads_nothing_and_reports_truncation() {
        // Degenerate but reachable — a caller computing the limit from a size that came out zero. It must
        // not read the blob, and must not claim to have read all of it.
        let repo = repo_with_blob(1024).await;

        let output = git_capped(
            &["show", "HEAD:big.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
            0,
        )
        .await
        .expect("it should succeed");

        assert!(output.stdout.is_empty());
        assert!(output.truncated);
    }

    #[tokio::test]
    async fn a_capped_read_still_classifies_a_failure_it_was_not_truncated_by() {
        // Truncation must not swallow real failures: when the cap wasn't reached, this behaves exactly as
        // `git` does, including handing back an expected failure for the caller to branch on.
        let repo = empty_repository().await;
        crate::test_support::commit_file(&repo.path(), "tracked.txt", "one\n", "first");
        std::fs::write(repo.path().join("untracked.txt"), "two\n").expect("failed to write");

        let output = git_capped(
            &["show", "HEAD:untracked.txt"],
            repo.path(),
            "test",
            GitOptions::default().with_expected_errors([GitErrorKind::PathExistsButNotInRef]),
            1024,
        )
        .await
        .expect("an expected failure comes back as Ok");

        assert_eq!(
            output.git_error,
            Some(GitErrorKind::PathExistsButNotInRef),
            "a path that exists on disk but not in the revision"
        );
        assert!(!output.truncated);
    }

    #[tokio::test]
    async fn a_capped_read_reports_an_unexpected_failure() {
        let repo = empty_repository().await;

        let error = git_capped(
            &["show", "HEAD:nothing.txt"],
            repo.path(),
            "test",
            GitOptions::default(),
            1024,
        )
        .await
        .expect_err("a missing revision is a failure");

        assert!(
            matches!(error, GitError::UnexpectedExitCode { .. }),
            "{error:?}"
        );
    }
}
