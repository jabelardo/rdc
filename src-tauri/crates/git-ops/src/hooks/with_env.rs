//! Pointing git at the stand-ins for the duration of one invocation.
//!
//! Ported from `desktop-plus/app/src/lib/hooks/with-hooks-env.ts`. This is the piece that ties the other
//! four together: [`discovery`](crate::hooks::discovery) finds the hooks,
//! [`server`](crate::hooks::server) listens, [`runner`](crate::hooks::runner) executes, and
//! [`shell_env`](crate::hooks::shell_env) supplies the environment.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::error::GitError;
use crate::hooks::discovery::get_repo_hooks;
use crate::hooks::protocol::{generate_token, PORT_ENV, TOKEN_ENV};
use crate::hooks::runner::{run_hook, FailureDecision, HookProgress};
use crate::hooks::server::{runner as make_runner, HookRequest, HookServer, StderrSink};
use crate::hooks::shell::Shell;
use crate::hooks::shell_env::get_shell_env_with_shell;

/// Reports a hook starting, finishing or failing.
pub type ProgressCallback = Arc<dyn Fn(HookProgress) + Send + Sync>;

/// Login-shell environments already loaded during this operation, keyed by working directory.
type ShellEnvCache = Arc<Mutex<HashMap<String, Arc<HashMap<String, String>>>>>;

/// Asks whether a failing hook's result may be ignored.
pub type FailureCallback = Arc<
    dyn Fn(String, Vec<u8>) -> Pin<Box<dyn Future<Output = FailureDecision> + Send>> + Send + Sync,
>;

/// What to intercept, and who to tell about it.
///
/// # Whether to intercept at all is the caller's decision
///
/// Upstream gated this on `getHooksEnvEnabled()` — a feature flag plus a `localStorage` setting. Both are
/// frontend state, so they don't belong in this crate: constructing this at all *is* the decision, and
/// the Phase 7 preferences UI is what decides whether to.
#[derive(Clone)]
pub struct HookInterception {
    /// Hook names to intercept, from the operation being run — `["pre-commit", "commit-msg", …]`.
    ///
    /// A hook the repository doesn't have costs nothing: only what exists gets a stand-in.
    pub hooks: Vec<String>,

    /// The `rdc-hook-proxy` binary.
    ///
    /// A parameter rather than something resolved here: this crate must not know the application
    /// bundle's layout, the same reasoning as the trampoline's paths and `rdc-printenvz`.
    pub proxy_binary: PathBuf,

    /// The `rdc-printenvz` binary, run inside the login shell.
    pub printenvz: PathBuf,

    /// The shell to load the environment from. `None` uses the user's.
    ///
    /// Present because upstream let the user choose one (its four Windows shells), and because a test
    /// must not depend on the developer's `SHELL`.
    pub shell: Option<Shell>,

    /// Called when a hook starts, finishes or fails.
    pub on_progress: ProgressCallback,

    /// Called when a hook fails and the failure is worth asking about.
    pub on_failure: FailureCallback,
}

impl HookInterception {
    /// Intercepts `hooks`, reporting nothing and ignoring nothing.
    ///
    /// The defaults are the conservative ones: a failure the user is never asked about is a failure, so
    /// git aborts the operation exactly as it would have without rdc involved.
    pub fn new(
        hooks: impl IntoIterator<Item = String>,
        proxy_binary: impl Into<PathBuf>,
        printenvz: impl Into<PathBuf>,
    ) -> Self {
        Self {
            hooks: hooks.into_iter().collect(),
            proxy_binary: proxy_binary.into(),
            printenvz: printenvz.into(),
            shell: None,
            on_progress: Arc::new(|_| {}),
            on_failure: Arc::new(|_, _| Box::pin(async { FailureDecision::Fail })),
        }
    }

    /// Reports progress to `callback`.
    pub fn with_progress<F>(mut self, callback: F) -> Self
    where
        F: Fn(HookProgress) + Send + Sync + 'static,
    {
        self.on_progress = Arc::new(callback);
        self
    }

    /// Asks `callback` about a failing hook.
    pub fn with_failure_prompt<F, Fut>(mut self, callback: F) -> Self
    where
        F: Fn(String, Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = FailureDecision> + Send + 'static,
    {
        self.on_failure = Arc::new(move |hook, output| Box::pin(callback(hook, output)));
        self
    }

    /// Loads the environment from `shell` instead of the user's.
    pub fn with_shell(mut self, shell: Shell) -> Self {
        self.shell = Some(shell);
        self
    }
}

/// Runs `operation` with git pointed at stand-ins for the repository's hooks.
///
/// `env` is the environment the git invocation would otherwise use; `operation` receives it with the
/// interception variables layered on. The layering order is upstream's — the hooks variables win, which is
/// why any existing `GIT_CONFIG_PARAMETERS` is *prefixed* rather than replaced.
///
/// Three short-circuits, all upstream's, and each avoids paying for something nobody asked for:
///
/// 1. No [`HookInterception`] — the caller didn't ask.
/// 2. No hook names to look for.
/// 3. The repository has none of the named hooks. This is the common case, and it means the usual git
///    invocation involves no temporary directory, no server and no token.
///
/// # Setting up and failing
///
/// If the temporary directory, the stand-ins or the server can't be created, this **fails** rather than
/// running git without interception. Silently skipping means the user's `pre-commit` hook doesn't run and
/// nothing says so, which is the one outcome worse than a failed commit.
pub async fn with_hooks_env<T, F, Fut>(
    repository: impl AsRef<Path>,
    interception: Option<&HookInterception>,
    env: HashMap<String, String>,
    operation: F,
) -> Result<T, GitError>
where
    F: FnOnce(HashMap<String, String>) -> Fut,
    Fut: Future<Output = T>,
{
    let repository = repository.as_ref();

    let Some(interception) = interception else {
        return Ok(operation(env).await);
    };
    if interception.hooks.is_empty() {
        return Ok(operation(env).await);
    }

    let hooks = get_repo_hooks(repository, Some(&interception.hooks)).await?;
    if hooks.is_empty() {
        return Ok(operation(env).await);
    }

    let directory = tempfile::Builder::new()
        .prefix("rdc-hooks-")
        .tempdir()
        .map_err(|error| GitError::Parse {
            context: "withHooksEnv".to_owned(),
            message: format!("could not create a directory for the hook stand-ins: {error}"),
        })?;

    // Resolved once, before the loop: a dangling symlink is perfectly legal, so the binary has to be
    // verified rather than assumed — and a relative path would resolve against the wrong directory once
    // it is the target of a link in a temporary one.
    let binary =
        std::fs::canonicalize(&interception.proxy_binary).map_err(|error| GitError::Parse {
            context: "withHooksEnv".to_owned(),
            message: format!(
                "could not find the hook stand-in binary at {}: {error}",
                interception.proxy_binary.display()
            ),
        })?;

    for hook in &hooks {
        install_stand_in(&binary, directory.path(), hook).map_err(|error| GitError::Parse {
            context: "withHooksEnv".to_owned(),
            message: format!(
                "could not install the stand-in for the {hook} hook from {}: {error}",
                binary.display()
            ),
        })?;
    }

    let token = generate_token();
    let server = HookServer::bind(token.clone(), hook_runner(interception))
        .await
        .map_err(|error| GitError::Parse {
            context: "withHooksEnv".to_owned(),
            message: format!("could not listen for hook connections: {error}"),
        })?;
    let port = server.port().map_err(|error| GitError::Parse {
        context: "withHooksEnv".to_owned(),
        message: format!("could not read the hook server's port: {error}"),
    })?;
    // Dropped at the end of this function, which is what bounds the token's usefulness to this operation.
    let _handle = server.serve();

    let mut env = env;
    env.insert(
        "GIT_CONFIG_PARAMETERS".to_owned(),
        config_parameters(
            env.get("GIT_CONFIG_PARAMETERS").map(String::as_str),
            directory.path(),
        ),
    );
    env.insert(PORT_ENV.to_owned(), port.to_string());
    env.insert(TOKEN_ENV.to_owned(), token);

    let result = operation(env).await;

    // Explicit, so it reads as the end of the interception rather than as an unused binding: the
    // directory is removed and the server stops accepting.
    drop(directory);
    Ok(result)
}

/// Puts a stand-in for `hook` in `directory`.
///
/// # A symlink rather than a copy, because copying races with executing
///
/// Copying looked obvious and was wrong. On Linux, `execve` fails with **`ETXTBSY` ("Text file busy") if
/// any process holds the file open for writing** — and a `fork` in *another thread* inherits the copy's
/// still-open descriptor, which `CLOEXEC` closes only *after* the kernel has already made that check. So a
/// commit could fail with "Text file busy" whenever another thread happened to spawn something while the
/// stand-ins were being written. It showed up as an intermittent CI failure in the tests, where many
/// processes are spawned at once; in the app the window is smaller but not absent, and git runs plenty of
/// its own subprocesses.
///
/// A symlink has no such window: the inode git executes is never opened for writing at all. It also
/// avoids copying a multi-megabyte binary once per hook, though that is a side benefit rather than the
/// reason.
///
/// Falls back to copying where symlinks aren't available — Windows needs a privilege for them — which
/// restores the original hazard on that platform only, and only there does it need thinking about again.
fn install_stand_in(binary: &Path, directory: &Path, hook: &str) -> std::io::Result<()> {
    let destination = directory.join(hook);

    #[cfg(unix)]
    if std::os::unix::fs::symlink(binary, &destination).is_ok() {
        return Ok(());
    }

    // `fs::copy` carries the executable bit, which is what git checks before running a hook.
    std::fs::copy(binary, &destination).map(|_| ())
}

/// The runner the server dispatches to, with the shell environment loaded at most once per directory.
///
/// Upstream memoized the same lookup, and the reason is that it is *slow*: starting an interactive login
/// shell runs the user's init files, which for a machine with several version managers is measured in
/// hundreds of milliseconds. A commit runs up to six hooks, and paying that once is the difference between
/// interception being usable and being noticed.
///
/// Keyed by directory rather than cached outright, because a hook's working directory is the repository's
/// and directory-local tooling makes the answer differ. Only successes are cached: a shell that failed to
/// start may be a transient failure, and remembering it would make one bad moment last the whole
/// operation.
fn hook_runner(interception: &HookInterception) -> crate::hooks::server::HookRunner {
    let printenvz = interception.printenvz.clone();
    let shell = interception.shell.clone();
    let on_progress = Arc::clone(&interception.on_progress);
    let on_failure = Arc::clone(&interception.on_failure);
    let cache: ShellEnvCache = Arc::new(Mutex::new(HashMap::new()));

    make_runner(move |request: HookRequest, sink: StderrSink| {
        let printenvz = printenvz.clone();
        let shell = shell.clone();
        let on_progress = Arc::clone(&on_progress);
        let on_failure = Arc::clone(&on_failure);
        let cache = Arc::clone(&cache);

        async move {
            let shell_env = {
                // Held across the load so two hooks starting together don't both run a login shell.
                let mut cache = cache.lock().await;
                match cache.get(&request.cwd) {
                    Some(cached) => Arc::clone(cached),
                    None => {
                        let shell = shell.clone().unwrap_or_else(Shell::for_user);
                        let loaded = get_shell_env_with_shell(
                            shell.clone(),
                            Some(Path::new(&request.cwd)),
                            &printenvz,
                        )
                        .await;

                        match loaded {
                            Ok(loaded) => {
                                let vars = Arc::new(loaded.vars);
                                cache.insert(request.cwd.clone(), Arc::clone(&vars));
                                vars
                            }
                            Err(error) => {
                                // Upstream's wording and reasoning: the user has to be told which shell
                                // failed, because the fix is a setting rather than anything in the
                                // repository.
                                let _ = sink.send(
                                    format!(
                                        "Failed to load the shell environment for the {} hook \
                                         using {}: {error}\n\nConfigure the shell to use in \
                                         Preferences > Git > Hooks.\n",
                                        request.hook,
                                        shell.path.display()
                                    )
                                    .into_bytes(),
                                );
                                // The hook did not run, so it did not pass.
                                return 1;
                            }
                        }
                    }
                }
            };

            let outcome = run_hook(
                &request,
                &shell_env,
                &sink,
                |progress| on_progress(progress),
                |hook, output| on_failure(hook, output),
            )
            .await;

            outcome.exit_code
        }
    })
}

/// The `GIT_CONFIG_PARAMETERS` value pointing `core.hooksPath` at `directory`.
///
/// Any existing value is kept **in front**, because git reads the list left to right and a later entry
/// wins — so ours has to come last, and the caller's own configuration has to survive.
///
/// # Quoting, which upstream left as a TODO
///
/// The original wrote `'core.hooksPath=${tmpHooksDir}'` with a comment asking whether the directory could
/// contain a single quote ("probably not?"). It can: the parent is `TMPDIR`, which is the user's to set.
/// git parses this variable with its shell-style `sq_dequote`, so a quote is escaped as `'\''` — the same
/// rule as [`crate::hooks::shell::quote_command`], applied here to a value rather than a command.
fn config_parameters(existing: Option<&str>, directory: &Path) -> String {
    let quoted = sq_quote(&format!("core.hooksPath={}", directory.to_string_lossy()));

    match existing {
        Some(existing) if !existing.is_empty() => format!("{existing} {quoted}"),
        _ => quoted,
    }
}

/// Quotes a value the way git's `sq_dequote` reads it.
fn sq_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for character in value.chars() {
        if character == '\'' {
            // Close, escape, reopen — the only way a single quote survives single quoting.
            quoted.push_str("'\\''");
        } else {
            quoted.push(character);
        }
    }
    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_the_hooks_path_at_the_directory() {
        let value = config_parameters(None, Path::new("/tmp/rdc-hooks-abc"));

        assert_eq!(value, "'core.hooksPath=/tmp/rdc-hooks-abc'");
    }

    #[test]
    fn keeps_an_existing_value_in_front() {
        // git reads the list left to right and the last entry wins, so ours has to come last — and the
        // caller's own configuration has to survive.
        let value = config_parameters(
            Some("'protocol.version=2'"),
            Path::new("/tmp/rdc-hooks-abc"),
        );

        assert_eq!(
            value,
            "'protocol.version=2' 'core.hooksPath=/tmp/rdc-hooks-abc'"
        );
    }

    #[test]
    fn treats_an_empty_existing_value_as_absent() {
        assert_eq!(
            config_parameters(Some(""), Path::new("/tmp/hooks")),
            "'core.hooksPath=/tmp/hooks'"
        );
    }

    #[test]
    fn escapes_a_quote_in_the_directory_path() {
        // Upstream left this as a TODO. `TMPDIR` is the user's to set, so the path can contain a quote,
        // and an unescaped one would end the quoted item early — git would then read the rest of the path
        // as further configuration.
        let value = config_parameters(None, Path::new("/tmp/it's here/hooks"));

        assert_eq!(value, r"'core.hooksPath=/tmp/it'\''s here/hooks'");
    }

    #[test]
    fn quotes_a_path_with_spaces_without_escaping_anything_else() {
        let value = config_parameters(None, Path::new("/Users/me/Application Support/hooks"));

        assert_eq!(
            value,
            "'core.hooksPath=/Users/me/Application Support/hooks'"
        );
    }
}
