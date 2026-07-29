//! Running a hook with the environment a terminal would have given it.
//!
//! Ported from the server half of `desktop-plus/app/src/lib/hooks/hooks-proxy.ts`. The transport that
//! delivers the invocation is [`crate::hooks::server`]; this is what happens once it arrives.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::hooks::protocol::HookRequest;
use crate::hooks::server::StderrSink;

/// Hooks whose failure the user is **not** asked about.
///
/// Upstream's list, and its reasoning: for these, git either ignores the exit code or the consequence
/// isn't worth interrupting anyone over. Note what this does *not* mean — the code is still passed back
/// to git unchanged. `post-checkout`'s code, for instance, doesn't stop the checkout but does become the
/// command's exit code, and `pre-auto-gc`'s only stops git from running garbage collection.
const NOT_WORTH_ASKING_ABOUT: [&str; 6] = [
    "post-applypatch",
    "post-commit",
    "post-checkout",
    "post-merge",
    "pre-auto-gc",
    "post-rewrite",
];

/// `GIT_*` variables that must not reach a hook, even though the prefix rule would pass them.
///
/// Upstream's set, with its reasons:
///
/// - `GIT_SYSTEM_CONFIG`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR` — dugite set these to point at its own
///   bundled git. rdc runs the system git, so they are unlikely to be present at all; excluded anyway,
///   because if something upstream of us sets them they would still be wrong for the hook.
/// - `GIT_CONFIG_PARAMETERS` — **the important one.** It is how `core.hooksPath` is pointed at the
///   stand-in directory, so leaking it into the hook's environment would make any git command the hook
///   runs use the stand-ins too, and the hook would recurse into itself.
/// - `GIT_ASKPASS`, `GIT_SSH_COMMAND`, `GIT_USER_AGENT` — ours, aimed at the trampoline. A hook that
///   pushes should use the user's own credential setup, not rdc's prompt.
const EXCLUDED_FROM_HOOKS: [&str; 7] = [
    "GIT_SYSTEM_CONFIG",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "GIT_USER_AGENT",
];

/// Prefixes of variables a hook is allowed to see from git's environment.
///
/// `GIT_*` is how a hook knows what it is acting on. `GITHEAD_*` is set by `git merge` — one variable
/// per merged ref — and a merge hook needs it.
const SAFE_PREFIXES: [&str; 2] = ["GIT_", "GITHEAD_"];

/// Where a hook is in its life.
///
/// Serializes to the original's `onHookProgress` strings — `started`, `finished`, `failed` — because that
/// is what the frontend is typed against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookStatus {
    Started,
    Finished,
    /// Exited non-zero, and the user either wasn't asked or chose not to ignore it.
    Failed,
}

/// A hook starting, finishing or failing.
#[derive(Debug, Clone)]
pub struct HookProgress {
    pub hook: String,
    pub status: HookStatus,
    /// Stops the hook. Only meaningful on [`HookStatus::Started`].
    pub abort: HookAbort,
}

/// Hook progress as it crosses IPC.
///
/// [`HookProgress`] itself cannot: it carries a [`HookAbort`], which is a live handle rather than data. So
/// the wire carries an **id** the app can look that handle up by — the trade every callback makes when it
/// has to become a message. The app owns the table; this is only the shape.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookProgressUpdate {
    /// Identifies this run of this hook, so a start can be matched to its end and either can be aborted.
    pub id: u64,

    /// The hook's name, e.g. `pre-commit`.
    pub hook: String,

    pub status: HookStatus,
}

/// A handle that stops a running hook.
///
/// # What it can and cannot stop
///
/// It kills the `git hook run` process. A hook that has spawned children of its own may leave them
/// running — upstream had the same limitation with its `AbortController`, because neither runtime tracks
/// a process group here. Killing the parent is enough for git to report the hook as terminated, which is
/// what the operation depends on.
#[derive(Debug, Clone, Default)]
pub struct HookAbort {
    notify: Arc<Notify>,
}

impl HookAbort {
    /// Requests that the hook be stopped.
    ///
    /// Safe to call before the hook starts: the request is remembered rather than lost.
    pub fn abort(&self) {
        // `notify_one` stores a permit, unlike `notify_waiters` — so an abort that arrives before the
        // runner waits still takes effect.
        self.notify.notify_one();
    }
}

/// What the user chose about a failing hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureDecision {
    /// Report the failure to git, aborting the operation.
    Fail,
    /// Treat it as success and let the operation continue.
    Ignore,
}

/// How a hook ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookOutcome {
    /// What the stand-in should exit with — zero if a failure was ignored.
    pub exit_code: i32,

    /// Everything the hook wrote, plus the closing status line.
    ///
    /// Captured as well as streamed because the failure prompt needs it: the user is being asked whether
    /// to ignore *this* output, and it has to be complete by the time they see it.
    pub terminal_output: Vec<u8>,

    /// Whether a non-zero exit was ignored on the user's instruction.
    pub ignored: bool,
}

/// Runs the hook an invocation stands in for.
///
/// `shell_env` is the environment from the user's login shell — see [`crate::hooks::shell_env`]. It is
/// the base, with git's own `GIT_*`/`GITHEAD_*` variables layered on top, because those describe the
/// operation in progress and must win.
///
/// `on_progress` is called once at the start and once at the end. `on_failure` is consulted only for a
/// hook whose failure is worth asking about, and only when it actually failed.
///
/// # `git hook run` rather than executing the file
///
/// git decides what running a hook means — which interpreter, whether it exists, what the arguments look
/// like — and `git hook run` is the supported way to ask for that. Executing the file directly would put
/// a second implementation of git's rules here.
///
/// Upstream needed a helper (`ensureGitExecPathEnv`) to repair `GIT_EXEC_PATH` because it invoked its own
/// *bundled* git, built without a prefix, which set the variable to a path that doesn't exist. rdc runs
/// the system git, so there is nothing to repair and no equivalent here.
pub async fn run_hook<P, F, Fut>(
    request: &HookRequest,
    shell_env: &HashMap<String, String>,
    sink: &StderrSink,
    mut on_progress: P,
    on_failure: F,
) -> HookOutcome
where
    P: FnMut(HookProgress),
    F: FnOnce(String, Vec<u8>) -> Fut,
    Fut: Future<Output = FailureDecision>,
{
    let started_at = Instant::now();
    let hook = request.hook.clone();
    let abort = HookAbort::default();

    // Announced before anything can go wrong, so the UI shows the hook even if it fails to start.
    let _ = sink.send(format!("Running {hook} hook...\n").into_bytes());
    on_progress(HookProgress {
        hook: hook.clone(),
        status: HookStatus::Started,
        abort: abort.clone(),
    });

    if !request.stdin.is_empty() && !supports_to_stdin(Path::new(&request.cwd)).await {
        // Running the hook without its stdin is not an option: a `pre-push` hook that reads no refs
        // could approve a push it was written to reject. Failing closed is the only safe answer.
        return fail_before_running(
            &hook,
            format!(
                "the {hook} hook expects data on stdin, and this git's `hook run` has no \
                 `--to-stdin` option to deliver it. Upgrading git enables it; until then this hook \
                 cannot be run from rdc, and rdc will not run it without the data it expects.\n"
            ),
            started_at,
            sink,
            &mut on_progress,
            on_failure,
        )
        .await;
    }

    // Held for the duration: dropping it removes the spooled stdin.
    let spool = match spool_stdin(&request.stdin) {
        Ok(spool) => spool,
        Err(error) => {
            return fail_before_running(
                &hook,
                format!("could not write the hook's stdin: {error}\n"),
                started_at,
                sink,
                &mut on_progress,
                on_failure,
            )
            .await;
        }
    };

    let mut command = tokio::process::Command::new(git_binary());
    command
        .arg("hook")
        .arg("run")
        .arg(&hook)
        .current_dir(&request.cwd)
        .stdin(std::process::Stdio::null())
        // git-hook-run puts hook output on stderr, and keeps stdout for its own use.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    if hook == "pre-auto-gc" {
        // A stand-in is installed for `pre-auto-gc` whether or not the user wrote one, so that a commit
        // held up by garbage collection can say so. `--ignore-missing` is what keeps that from being
        // reported as a failure when they didn't.
        command.arg("--ignore-missing");
    }
    if let Some(spool) = &spool {
        // git wants the data as a file, not on its own stdin.
        command.arg(format!("--to-stdin={}", spool.path.display()));
    }
    command.arg("--");
    command.args(request.arguments.iter().map(OsStr::new));

    // Replaced, not extended: a hook must see the terminal's environment, not rdc's.
    command.env_clear();
    for (name, value) in hook_environment(shell_env, &request.environment) {
        command.env(name, value);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return fail_before_running(
                &hook,
                format!("could not run the {hook} hook: {error}\n"),
                started_at,
                sink,
                &mut on_progress,
                on_failure,
            )
            .await;
        }
    };

    let mut pipe = child.stderr.take().expect("stderr was piped");
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    let status = loop {
        tokio::select! {
            read = pipe.read(&mut buffer) => match read {
                // The hook closed its stderr; wait for the process itself.
                Ok(0) | Err(_) => break child.wait().await.ok(),
                Ok(read) => {
                    let chunk = &buffer[..read];
                    captured.extend_from_slice(chunk);
                    // Streamed as it arrives: this is what makes a slow hook visible.
                    let _ = sink.send(chunk.to_vec());
                }
            },
            _ = abort.notify.notified() => {
                let _ = child.start_kill();
                break child.wait().await.ok();
            }
        }
    };

    let code = status.as_ref().and_then(std::process::ExitStatus::code);
    let signal = status.as_ref().and_then(signal_of);

    finish(
        &hook,
        code,
        signal,
        captured,
        started_at,
        sink,
        &mut on_progress,
        on_failure,
    )
    .await
}

/// Reports a hook that could not be run at all.
///
/// `reason` is **both streamed and captured**, which is the point of having this rather than calling
/// [`finish`] directly: git shows the user whatever reaches the hook's stderr, so a reason that was only
/// captured would leave them with "the hook failed" and no explanation. Captured too, because that is what
/// a failure prompt is shown.
async fn fail_before_running<P, F, Fut>(
    hook: &str,
    reason: String,
    started_at: Instant,
    sink: &StderrSink,
    on_progress: &mut P,
    on_failure: F,
) -> HookOutcome
where
    P: FnMut(HookProgress),
    F: FnOnce(String, Vec<u8>) -> Fut,
    Fut: Future<Output = FailureDecision>,
{
    let _ = sink.send(reason.clone().into_bytes());

    finish(
        hook,
        Some(1),
        None,
        reason.into_bytes(),
        started_at,
        sink,
        on_progress,
        on_failure,
    )
    .await
}

/// Writes the closing status line, asks about a failure, and reports the outcome.
#[allow(clippy::too_many_arguments)]
async fn finish<P, F, Fut>(
    hook: &str,
    code: Option<i32>,
    signal: Option<i32>,
    mut captured: Vec<u8>,
    started_at: Instant,
    sink: &StderrSink,
    on_progress: &mut P,
    on_failure: F,
) -> HookOutcome
where
    P: FnMut(HookProgress),
    F: FnOnce(String, Vec<u8>) -> Fut,
    Fut: Future<Output = FailureDecision>,
{
    let duration = format!("after {:.2}s", started_at.elapsed().as_secs_f64());
    let message = match (signal, code) {
        (Some(signal), _) => format!("{hook} hook killed by signal {signal} {duration}"),
        (None, Some(0)) => format!("{hook} hook done {duration}"),
        (None, Some(code)) => format!("{hook} hook failed with code {code} {duration}"),
        // No code and no signal: the process didn't report either, which is a failure we can't name.
        (None, None) => format!("{hook} hook ended unexpectedly {duration}"),
    };

    // Appended to the captured output *before* the prompt, because the user is being asked about output
    // that should include how it ended. Upstream noted the same ordering: written to the stream
    // afterwards, it wouldn't have arrived in time.
    captured.extend_from_slice(message.as_bytes());
    captured.push(b'\n');

    let failed = code != Some(0);
    let ignored = if failed && !NOT_WORTH_ASKING_ABOUT.contains(&hook) {
        on_failure(hook.to_owned(), captured.clone()).await == FailureDecision::Ignore
    } else {
        false
    };

    let _ = sink.send(format!("{message}\n").into_bytes());
    if ignored {
        let _ = sink.send(format!("{hook} hook failure ignored by user\n").into_bytes());
    }

    // A signal or a missing code still has to become an exit code; 1 is the honest answer for "it did
    // not succeed".
    let exit_code = if ignored { 0 } else { code.unwrap_or(1) };

    on_progress(HookProgress {
        hook: hook.to_owned(),
        status: if exit_code == 0 {
            HookStatus::Finished
        } else {
            HookStatus::Failed
        },
        abort: HookAbort::default(),
    });

    HookOutcome {
        exit_code,
        terminal_output: captured,
        ignored,
    }
}

/// The environment a hook runs with.
///
/// The login shell's environment is the base — that is the whole point of the exercise — and git's
/// description of the operation is layered over it, filtered to the safe prefixes minus the exclusions.
///
/// `RDC=1` tells a hook it is running from rdc rather than a terminal. `GITHUB_DESKTOP=1` is set as well
/// and is **compatibility, not identity**: hooks in the wild test for it (upstream added it for
/// desktop/desktop#19001), and dropping it would silently change how those behave. rdc is not GitHub
/// Desktop, which is why `RDC` is the variable to test for from here on.
fn hook_environment(
    shell_env: &HashMap<String, String>,
    git_env: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut env = shell_env.clone();

    for (name, value) in git_env {
        let safe = SAFE_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
            && !EXCLUDED_FROM_HOOKS.contains(&name.as_str());
        if safe {
            env.insert(name.clone(), value.clone());
        }
    }

    env.insert("RDC".to_owned(), "1".to_owned());
    env.insert("GITHUB_DESKTOP".to_owned(), "1".to_owned());
    env
}

/// A spooled copy of the hook's stdin.
struct Spool {
    path: PathBuf,
    /// Removes the file and its directory when dropped.
    _directory: tempfile::TempDir,
}

/// Writes stdin to a file for `git hook run --to-stdin`, or `None` when there was none.
fn spool_stdin(stdin: &[u8]) -> std::io::Result<Option<Spool>> {
    if stdin.is_empty() {
        return Ok(None);
    }

    let directory = tempfile::Builder::new()
        .prefix("rdc-hook-stdin-")
        .tempdir()?;
    let path = directory.path().join("stdin");
    std::fs::write(&path, stdin)?;

    Ok(Some(Spool {
        path,
        _directory: directory,
    }))
}

/// Whether this git's `hook run` accepts `--to-stdin`.
///
/// # Why this has to be asked at all
///
/// It is the only way to give a hook its stdin: without it git runs the hook with **no stdin** — verified
/// on 2.39 and 2.50 — so piping is not an alternative. And the option is newer than `git hook run` itself,
/// so a git that has the command may still not have the option (Debian bookworm's 2.39.5 does not).
///
/// Upstream never had to ask, because it **bundles its own git** and says so: "we can't be certain the
/// user's Git binary is new enough to support the hook run command". rdc runs the system git, so the
/// question is live — and a Linux container found it, having passed on a developer machine with a newer
/// git.
///
/// Probed with [`crate::exec::supports_flag`], which explains the technique, and cached for the process.
///
/// Public so the app can say *in advance* that a `pre-push` hook won't be intercepted on this machine,
/// rather than only when one fails.
pub async fn supports_to_stdin(repository: &Path) -> bool {
    static SUPPORTED: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();

    *SUPPORTED
        .get_or_init(|| crate::exec::supports_flag(repository, &["hook", "run"], "--to-stdin"))
        .await
}

/// The git binary to run, resolved **before** the environment is replaced.
///
/// This matters: Rust resolves a bare program name through the *child's* `PATH`, so leaving it as `git`
/// would let the user's shell environment decide which git runs the hook — and if that environment had
/// no `PATH` at all, nothing would run. Resolving against rdc's own `PATH` keeps hook execution on the
/// same git as every other operation in this crate, while the hook itself still sees the shell's `PATH`.
fn git_binary() -> PathBuf {
    use std::sync::OnceLock;

    static RESOLVED: OnceLock<PathBuf> = OnceLock::new();

    RESOLVED
        .get_or_init(|| {
            let Some(path) = std::env::var_os("PATH") else {
                return PathBuf::from("git");
            };

            std::env::split_paths(&path)
                .map(|directory| directory.join("git"))
                .find(|candidate| is_executable_file(candidate))
                // Falling back to the bare name keeps the failure git's to report rather than ours to
                // guess at.
                .unwrap_or_else(|| PathBuf::from("git"))
        })
        .clone()
}

#[cfg(unix)]
fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &std::path::Path) -> bool {
    path.is_file()
}

/// The signal that killed a process, if one did.
#[cfg(unix)]
fn signal_of(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;

    status.signal()
}

#[cfg(not(unix))]
fn signal_of(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository, TempRepository};
    use tokio::sync::mpsc;

    /// A repository with one commit and an executable `hook` that runs `script`.
    async fn repo_with_hook(hook: &str, script: &str) -> TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let hooks = repo.path().join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("failed to create the hooks directory");
        let path = hooks.join(hook);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("failed to write the hook");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("failed to make the hook executable");
        }

        repo
    }

    fn request(repo: &TempRepository, hook: &str) -> HookRequest {
        HookRequest {
            token: "token".to_owned(),
            hook: hook.to_owned(),
            arguments: Vec::new(),
            environment: HashMap::new(),
            cwd: repo.path().to_string_lossy().into_owned(),
            stdin: Vec::new(),
        }
    }

    /// A shell environment with just enough to run a `/bin/sh` script.
    fn shell_env() -> HashMap<String, String> {
        HashMap::from([
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("FROM_THE_SHELL".to_owned(), "yes".to_owned()),
        ])
    }

    /// Runs a hook, collecting what was streamed and what progress was reported.
    async fn run(
        request: &HookRequest,
        env: &HashMap<String, String>,
        decision: FailureDecision,
    ) -> (HookOutcome, String, Vec<(String, HookStatus)>) {
        let (sink, mut receiver) = mpsc::unbounded_channel();
        let mut progress = Vec::new();

        let outcome = run_hook(
            request,
            env,
            &sink,
            |update| progress.push((update.hook, update.status)),
            |_hook, _output| async move { decision },
        )
        .await;
        drop(sink);

        let mut streamed = Vec::new();
        while let Some(chunk) = receiver.recv().await {
            streamed.extend_from_slice(&chunk);
        }

        (
            outcome,
            String::from_utf8_lossy(&streamed).into_owned(),
            progress,
        )
    }

    #[tokio::test]
    async fn runs_a_hook_and_reports_success() {
        let repo = repo_with_hook("pre-commit", "echo 'linting' >&2").await;

        let (outcome, streamed, progress) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert_eq!(outcome.exit_code, 0);
        assert!(streamed.contains("linting"), "{streamed}");
        assert!(
            streamed.contains("Running pre-commit hook..."),
            "{streamed}"
        );
        assert!(
            streamed.contains("pre-commit hook done after"),
            "{streamed}"
        );
        assert_eq!(
            progress,
            vec![
                ("pre-commit".to_owned(), HookStatus::Started),
                ("pre-commit".to_owned(), HookStatus::Finished),
            ]
        );
    }

    #[tokio::test]
    async fn reports_a_failing_hook_with_its_exit_code() {
        let repo = repo_with_hook("pre-commit", "echo 'nope' >&2\nexit 2").await;

        let (outcome, streamed, progress) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert_eq!(outcome.exit_code, 2);
        assert!(!outcome.ignored);
        assert!(
            streamed.contains("pre-commit hook failed with code 2"),
            "{streamed}"
        );
        assert_eq!(progress[1].1, HookStatus::Failed);
    }

    #[tokio::test]
    async fn a_failure_the_user_ignores_becomes_a_success() {
        // What the prompt is for: the user has seen the output and decided to commit anyway.
        let repo = repo_with_hook("pre-commit", "exit 1").await;

        let (outcome, streamed, progress) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Ignore,
        )
        .await;

        assert_eq!(outcome.exit_code, 0, "git must be told the hook passed");
        assert!(outcome.ignored);
        assert!(
            streamed.contains("failure ignored by user"),
            "the transcript must say so: {streamed}"
        );
        assert_eq!(
            progress[1].1,
            HookStatus::Finished,
            "an ignored failure reports as finished"
        );
    }

    #[tokio::test]
    async fn the_prompt_sees_the_output_including_how_it_ended() {
        // Ordering that upstream called out: the closing line is appended to the captured output before
        // the prompt, or the user would be asked about an incomplete transcript.
        let repo = repo_with_hook("commit-msg", "echo 'bad message' >&2\nexit 3").await;
        let (sink, _receiver) = mpsc::unbounded_channel();
        let (seen, mut received) = mpsc::unbounded_channel();

        let outcome = run_hook(
            &request(&repo, "commit-msg"),
            &shell_env(),
            &sink,
            |_| {},
            move |hook, output| async move {
                let _ = seen.send((hook, String::from_utf8_lossy(&output).into_owned()));
                FailureDecision::Fail
            },
        )
        .await;

        let (hook, output) = received.recv().await.expect("the prompt was consulted");
        assert_eq!(hook, "commit-msg");
        assert!(output.contains("bad message"), "{output}");
        assert!(output.contains("failed with code 3"), "{output}");
        assert_eq!(outcome.terminal_output, output.into_bytes());
    }

    #[tokio::test]
    async fn does_not_ask_about_hooks_not_worth_asking_about() {
        // `post-commit` runs after the commit exists; there is nothing to abort, so interrupting the user
        // would be noise. The code is still passed back — git decides what it means.
        let repo = repo_with_hook("post-commit", "exit 5").await;
        let (sink, _receiver) = mpsc::unbounded_channel();
        let asked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&asked);

        let outcome = run_hook(
            &request(&repo, "post-commit"),
            &shell_env(),
            &sink,
            |_| {},
            move |_hook, _output| {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                async move { FailureDecision::Ignore }
            },
        )
        .await;

        assert!(
            !asked.load(std::sync::atomic::Ordering::SeqCst),
            "the user must not be prompted about this one"
        );
        assert_eq!(outcome.exit_code, 5, "the code still reaches git unchanged");
        assert!(!outcome.ignored);
    }

    #[tokio::test]
    async fn passes_the_arguments_git_gave_the_hook() {
        let repo = repo_with_hook("commit-msg", "cat \"$1\" >&2").await;
        std::fs::write(repo.path().join("msg.txt"), "the message\n").expect("failed to write");
        let mut request = request(&repo, "commit-msg");
        request.arguments = vec!["msg.txt".to_owned()];

        let (outcome, streamed, _) = run(&request, &shell_env(), FailureDecision::Fail).await;

        assert_eq!(outcome.exit_code, 0, "{streamed}");
        assert!(streamed.contains("the message"), "{streamed}");
    }

    #[tokio::test]
    async fn gives_the_hook_its_stdin_as_a_file() {
        // `pre-push` reads its refs from stdin, and `git hook run` takes them as a path — via
        // `--to-stdin`, which is newer than the command itself. On a git without it the hook is refused
        // with an explanation rather than run blind, so this asserts whichever behaviour the local git
        // allows. See `supports_to_stdin`.
        let repo = repo_with_hook("pre-push", "cat >&2").await;
        let mut request = request(&repo, "pre-push");
        request.stdin = b"refs/heads/main abc refs/heads/main def\n".to_vec();

        let (outcome, streamed, _) = run(&request, &shell_env(), FailureDecision::Fail).await;

        if supports_to_stdin(&repo.path()).await {
            assert_eq!(outcome.exit_code, 0, "{streamed}");
            assert!(streamed.contains("refs/heads/main abc"), "{streamed}");
        } else {
            assert_ne!(outcome.exit_code, 0);
            assert!(streamed.contains("expects data on stdin"), "{streamed}");
        }
    }

    #[tokio::test]
    async fn a_missing_pre_auto_gc_hook_is_not_a_failure() {
        // A stand-in is installed for it whether or not the user wrote one, so that a commit delayed by
        // garbage collection can say why. `--ignore-missing` is what keeps that from looking like a
        // failed hook.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let (outcome, _, progress) = run(
            &request(&repo, "pre-auto-gc"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert_eq!(outcome.exit_code, 0);
        assert_eq!(progress[1].1, HookStatus::Finished);
    }

    #[tokio::test]
    async fn a_missing_hook_of_any_other_name_is_a_failure() {
        // The contrast with `pre-auto-gc`: git reports a missing hook, and only that one hook opts out.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        let (outcome, _, _) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert_ne!(outcome.exit_code, 0);
    }

    #[tokio::test]
    async fn the_hook_sees_the_shell_environment() {
        // The reason the whole subsystem exists.
        let repo = repo_with_hook("pre-commit", "echo \"shell=$FROM_THE_SHELL\" >&2").await;

        let (_, streamed, _) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert!(streamed.contains("shell=yes"), "{streamed}");
    }

    #[tokio::test]
    async fn the_hook_sees_gits_own_variables() {
        let repo = repo_with_hook("pre-commit", "echo \"index=$GIT_INDEX_FILE\" >&2").await;
        let mut request = request(&repo, "pre-commit");
        request.environment =
            HashMap::from([("GIT_INDEX_FILE".to_owned(), "/repo/.git/index".to_owned())]);

        let (_, streamed, _) = run(&request, &shell_env(), FailureDecision::Fail).await;

        assert!(streamed.contains("index=/repo/.git/index"), "{streamed}");
    }

    #[tokio::test]
    async fn the_hook_is_told_it_is_running_from_rdc() {
        let repo = repo_with_hook(
            "pre-commit",
            "echo \"rdc=$RDC desktop=$GITHUB_DESKTOP\" >&2",
        )
        .await;

        let (_, streamed, _) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert!(streamed.contains("rdc=1"), "{streamed}");
        assert!(
            streamed.contains("desktop=1"),
            "kept for compatibility with hooks that test for it: {streamed}"
        );
    }

    #[tokio::test]
    async fn the_hook_does_not_inherit_this_process_environment() {
        // A hook must see the terminal's environment, not rdc's — `CARGO_PKG_NAME` is a tracer Cargo sets
        // for this test process and no shell would.
        assert!(std::env::var_os("CARGO_PKG_NAME").is_some());
        let repo = repo_with_hook("pre-commit", "echo \"leaked=[$CARGO_PKG_NAME]\" >&2").await;

        let (_, streamed, _) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        assert!(streamed.contains("leaked=[]"), "{streamed}");
    }

    #[tokio::test]
    async fn a_hook_cannot_recurse_through_the_stand_in_configuration() {
        // The most important exclusion. `GIT_CONFIG_PARAMETERS` is how `core.hooksPath` is pointed at the
        // stand-ins, so a hook that saw it would send any git command it runs back through them.
        let repo = repo_with_hook(
            "pre-commit",
            "echo \"params=[$GIT_CONFIG_PARAMETERS] askpass=[$GIT_ASKPASS]\" >&2",
        )
        .await;
        let mut request = request(&repo, "pre-commit");
        request.environment = HashMap::from([
            (
                "GIT_CONFIG_PARAMETERS".to_owned(),
                "'core.hooksPath=/tmp/stand-ins'".to_owned(),
            ),
            (
                "GIT_ASKPASS".to_owned(),
                "/opt/rdc/rdc-trampoline".to_owned(),
            ),
        ]);

        let (_, streamed, _) = run(&request, &shell_env(), FailureDecision::Fail).await;

        assert!(streamed.contains("params=[]"), "{streamed}");
        assert!(
            streamed.contains("askpass=[]"),
            "a hook that pushes should use the user's own credential setup: {streamed}"
        );
    }

    #[tokio::test]
    async fn a_running_hook_can_be_aborted() {
        let repo = repo_with_hook("pre-commit", "sleep 30").await;
        let (sink, _receiver) = mpsc::unbounded_channel();

        let outcome = run_hook(
            &request(&repo, "pre-commit"),
            &shell_env(),
            &sink,
            |update| {
                if update.status == HookStatus::Started {
                    // What the UI's cancel button does.
                    update.abort.abort();
                }
            },
            |_hook, _output| async move { FailureDecision::Fail },
        )
        .await;

        assert_ne!(outcome.exit_code, 0);
        let transcript = String::from_utf8_lossy(&outcome.terminal_output);
        assert!(
            transcript.contains("killed by signal") || transcript.contains("failed with code"),
            "{transcript}"
        );
    }

    #[tokio::test]
    async fn output_is_streamed_before_the_hook_finishes() {
        // A slow hook has to be visible while it runs, which is the whole reason the transport is framed.
        let repo = repo_with_hook("pre-commit", "echo 'starting' >&2\nsleep 1").await;
        let (sink, mut receiver) = mpsc::unbounded_channel();

        let invocation = request(&repo, "pre-commit");
        let env = shell_env();

        let (outcome, first) = tokio::join!(
            run_hook(
                &invocation,
                &env,
                &sink,
                |_| {},
                |_hook, _output| async move { FailureDecision::Fail },
            ),
            async {
                // The announcement, then the hook's own first line — both before the sleep ends.
                let mut seen = String::new();
                while let Some(chunk) = receiver.recv().await {
                    seen.push_str(&String::from_utf8_lossy(&chunk));
                    if seen.contains("starting") {
                        break;
                    }
                }
                seen
            }
        );

        assert_eq!(outcome.exit_code, 0);
        assert!(first.contains("starting"), "{first}");
    }

    #[tokio::test]
    async fn runs_the_hook_in_the_repository() {
        let repo = repo_with_hook("pre-commit", "echo \"pwd=$PWD\" >&2").await;

        let (_, streamed, _) = run(
            &request(&repo, "pre-commit"),
            &shell_env(),
            FailureDecision::Fail,
        )
        .await;

        let expected = std::fs::canonicalize(repo.path()).expect("the repository exists");
        assert!(
            streamed.contains(&expected.to_string_lossy().into_owned()),
            "{streamed}"
        );
    }

    #[tokio::test]
    async fn a_hook_that_cannot_be_started_reports_rather_than_hanging() {
        // A cwd that isn't a repository: git refuses, and the outcome has to be a failure with an
        // explanation rather than a silent zero.
        let elsewhere = tempfile::tempdir().expect("failed to create a temporary directory");
        let mut request = HookRequest {
            token: "token".to_owned(),
            hook: "pre-commit".to_owned(),
            arguments: Vec::new(),
            environment: HashMap::new(),
            cwd: elsewhere.path().to_string_lossy().into_owned(),
            stdin: Vec::new(),
        };
        request.hook = "pre-commit".to_owned();

        let (outcome, streamed, progress) =
            run(&request, &shell_env(), FailureDecision::Fail).await;

        assert_ne!(outcome.exit_code, 0);
        assert_eq!(progress[1].1, HookStatus::Failed);
        assert!(!streamed.is_empty());
    }

    // --- environment assembly, without running anything ---

    #[test]
    fn git_variables_win_over_the_shell_ones() {
        // They describe the operation in progress, so a stale value from the shell must not shadow them.
        let env = hook_environment(
            &HashMap::from([("GIT_DIR".to_owned(), "/stale/.git".to_owned())]),
            &HashMap::from([("GIT_DIR".to_owned(), "/current/.git".to_owned())]),
        );

        assert_eq!(env["GIT_DIR"], "/current/.git");
    }

    #[test]
    fn only_git_prefixed_variables_cross_from_git() {
        let env = hook_environment(
            &HashMap::new(),
            &HashMap::from([
                ("GIT_DIR".to_owned(), "/repo/.git".to_owned()),
                ("GITHEAD_abc123".to_owned(), "topic".to_owned()),
                ("RDC_HOOK_PROXY_TOKEN".to_owned(), "secret".to_owned()),
                ("HOME".to_owned(), "/wrong".to_owned()),
            ]),
        );

        assert!(env.contains_key("GIT_DIR"));
        assert!(
            env.contains_key("GITHEAD_abc123"),
            "git merge sets one per merged ref, and a merge hook needs them"
        );
        assert!(
            !env.contains_key("RDC_HOOK_PROXY_TOKEN"),
            "the token must never reach a hook"
        );
        assert!(!env.contains_key("HOME"), "the shell decides what HOME is");
    }

    #[test]
    fn the_excluded_variables_are_dropped_even_though_they_match_the_prefix() {
        let git_env: HashMap<String, String> = EXCLUDED_FROM_HOOKS
            .iter()
            .map(|name| ((*name).to_owned(), "value".to_owned()))
            .collect();

        let env = hook_environment(&HashMap::new(), &git_env);

        for name in EXCLUDED_FROM_HOOKS {
            assert!(!env.contains_key(name), "{name} must not reach a hook");
        }
    }

    #[tokio::test]
    async fn resolves_git_to_an_absolute_path() {
        // Why: the environment is replaced before spawning, and Rust resolves a bare program name through
        // the *child's* PATH — so `git` alone would let a hook's shell environment decide which git runs
        // it, or fail outright if that environment had no PATH.
        let resolved = git_binary();

        assert!(resolved.is_absolute(), "{resolved:?}");
        let version = git(
            &["--version"],
            std::env::temp_dir(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("git should run")
        .stdout_lossy()
        .into_owned();

        let directly = std::process::Command::new(&resolved)
            .arg("--version")
            .output()
            .expect("the resolved binary should run");
        assert_eq!(String::from_utf8_lossy(&directly.stdout), version);
    }
}
