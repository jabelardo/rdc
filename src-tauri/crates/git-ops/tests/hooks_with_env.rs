//! End-to-end: real git, running real hooks through the stand-ins.
//!
//! Everything else about hooks is tested against one layer at a time. This drives the whole chain the way
//! the app will: `with_hooks_env` installs stand-ins, git runs one, the stand-in calls back, the runner
//! executes the hook through `git hook run`, and git acts on the exit code.
//!
//! The shell is a stand-in too — a small script that exports a known variable and runs what it's given —
//! so the tests don't depend on the developer's `SHELL` or their init files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git_ops::commit::{create_commit, CommitOptions};
use git_ops::exec::{git, GitOptions};
use git_ops::hooks::runner::{supports_to_stdin, FailureDecision, HookStatus};
use git_ops::hooks::shell::Shell;
use git_ops::hooks::with_env::{with_hooks_env, HookInterception, HookSupport};
use git_ops::update_index::FileToStage;

fn proxy_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_rdc-hook-proxy"))
}

fn printenvz() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_rdc-printenvz"))
}

/// A [`Shell`] that runs `script` through `/bin/sh` rather than executing it.
///
/// `$2` is still the command, as it would be for a real shell invoked with `-ilc <command>`.
fn script_shell(script: &Path) -> Shell {
    Shell {
        path: PathBuf::from("/bin/sh"),
        args: vec![script.to_string_lossy().into_owned(), "-ilc".to_owned()],
    }
}

/// A repository with one commit, plus a stand-in shell that exports `FROM_THE_SHELL=yes`.
struct Fixture {
    repository: tempfile::TempDir,
    shell: Shell,
}

impl Fixture {
    async fn new() -> Self {
        let repository = tempfile::Builder::new()
            .prefix("rdc-hooks-test-")
            .tempdir()
            .expect("failed to create a temporary directory");
        let path = repository.path().to_path_buf();

        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            git(&args, &path, "test", GitOptions::default())
                .await
                .unwrap_or_else(|error| panic!("git {args:?} should succeed: {error}"));
        }

        std::fs::write(path.join("a.txt"), "one\n").expect("failed to write");
        git(&["add", "."], &path, "test", GitOptions::default())
            .await
            .expect("add should succeed");
        git(
            &["commit", "-m", "first"],
            &path,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("commit should succeed");

        // Plays the part of a login shell: exports something recognizable, then runs the command it was
        // handed. Keeps the tests independent of whose machine they run on.
        //
        // Passed to `/bin/sh` as a script rather than made executable: executing a freshly-written file
        // races with `fork` in another thread and Linux answers `ETXTBSY`. See
        // `hooks::with_env::install_stand_in`.
        let script = repository.path().join("stand-in-shell");
        std::fs::write(
            &script,
            "export FROM_THE_SHELL=yes\nexec /bin/sh -c \"$2\"\n",
        )
        .expect("failed to write the stand-in shell");

        Self {
            repository,
            shell: script_shell(&script),
        }
    }

    fn path(&self) -> PathBuf {
        self.repository.path().to_path_buf()
    }

    /// Writes an executable hook.
    fn write_hook(&self, hook: &str, script: &str) {
        let hooks = self.path().join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("failed to create the hooks directory");
        let path = hooks.join(hook);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("failed to write the hook");
        make_executable(&path);
    }

    fn interception(&self, hooks: &[&str]) -> HookInterception {
        HookInterception::new(
            hooks.iter().map(|hook| (*hook).to_owned()),
            proxy_binary(),
            printenvz(),
        )
        .with_shell(self.shell.clone())
    }

    /// Commits through the interception, returning what git said.
    async fn commit_with(
        &self,
        interception: &HookInterception,
        message: &str,
    ) -> Result<String, String> {
        let path = self.path();
        let for_git = path.clone();

        with_hooks_env(
            &path,
            Some(interception),
            HashMap::new(),
            |env| async move {
                let path = for_git;
                let mut options = GitOptions::default();
                for (name, value) in env {
                    options = options.with_env(name, value);
                }

                git(
                    &["commit", "--allow-empty", "-m", message],
                    &path,
                    "test",
                    options,
                )
                .await
                .map(|output| format!("{}{}", output.stdout_lossy(), output.stderr))
                .map_err(|error| format!("{error}"))
            },
        )
        .await
        .expect("setting up the interception should succeed")
    }

    async fn commit_count(&self) -> usize {
        git(
            &["rev-list", "--count", "HEAD"],
            self.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-list should succeed")
        .stdout_lossy()
        .trim()
        .parse()
        .expect("a count")
    }
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .expect("failed to set permissions");
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

#[tokio::test]
async fn a_hook_runs_with_the_shell_environment() {
    // The whole point of the subsystem, proven through real git: the hook sees what a terminal would have
    // given it, not what rdc was launched with.
    let fixture = Fixture::new().await;
    fixture.write_hook(
        "pre-commit",
        "echo \"shell=$FROM_THE_SHELL\" > \"$(git rev-parse --show-toplevel)/hook-ran.txt\"",
    );

    fixture
        .commit_with(&fixture.interception(&["pre-commit"]), "second")
        .await
        .expect("the commit should succeed");

    let recorded = std::fs::read_to_string(fixture.path().join("hook-ran.txt"))
        .expect("the hook should have run");
    assert_eq!(recorded.trim(), "shell=yes");
    assert_eq!(fixture.commit_count().await, 2);
}

#[tokio::test]
async fn a_failing_hook_aborts_the_operation() {
    // git has to act on the exit code exactly as if it had run the hook itself.
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "echo 'refusing' >&2\nexit 1");

    let error = fixture
        .commit_with(&fixture.interception(&["pre-commit"]), "second")
        .await
        .expect_err("the commit should be refused");

    assert!(error.contains("refusing"), "the hook's own output: {error}");
    assert_eq!(fixture.commit_count().await, 1, "nothing was committed");
}

#[tokio::test]
async fn a_failure_the_user_ignores_lets_the_operation_through() {
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "echo 'warning' >&2\nexit 1");
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&asked);

    let interception =
        fixture
            .interception(&["pre-commit"])
            .with_failure_prompt(move |hook, output| {
                let seen = Arc::clone(&seen);
                async move {
                    seen.lock()
                        .expect("not poisoned")
                        .push((hook, String::from_utf8_lossy(&output).into_owned()));
                    FailureDecision::Ignore
                }
            });

    fixture
        .commit_with(&interception, "second")
        .await
        .expect("the commit should go through");

    assert_eq!(fixture.commit_count().await, 2);
    let asked = asked.lock().expect("not poisoned");
    assert_eq!(asked.len(), 1, "the user is asked once");
    assert_eq!(asked[0].0, "pre-commit");
    assert!(asked[0].1.contains("warning"), "{:?}", asked[0].1);
}

#[tokio::test]
async fn reports_each_hook_starting_and_finishing() {
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 0");
    fixture.write_hook("post-commit", "exit 0");
    let progress = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&progress);

    let interception = fixture
        .interception(&["pre-commit", "post-commit"])
        .with_progress(move |update| {
            recorded
                .lock()
                .expect("not poisoned")
                .push((update.hook, update.status))
        });

    fixture
        .commit_with(&interception, "second")
        .await
        .expect("the commit should succeed");

    let progress = progress.lock().expect("not poisoned");
    assert_eq!(
        *progress,
        vec![
            ("pre-commit".to_owned(), HookStatus::Started),
            ("pre-commit".to_owned(), HookStatus::Finished),
            ("post-commit".to_owned(), HookStatus::Started),
            ("post-commit".to_owned(), HookStatus::Finished),
        ],
        "in the order git ran them"
    );
}

#[tokio::test]
async fn a_hook_that_runs_git_does_not_recurse() {
    // The failure mode `GIT_CONFIG_PARAMETERS` is excluded to prevent: a hook that runs git would
    // otherwise send that git back through the stand-ins, and so on. The hook records what its own git
    // saw, and `core.hooksPath` must be unset there.
    let fixture = Fixture::new().await;
    fixture.write_hook(
        "pre-commit",
        "root=$(git rev-parse --show-toplevel)\n\
         echo \"hooksPath=[$(git config --get core.hooksPath)]\" > \"$root/inner.txt\"\n\
         echo \"params=[$GIT_CONFIG_PARAMETERS]\" >> \"$root/inner.txt\"\n\
         git status --porcelain >> \"$root/inner.txt\"",
    );

    fixture
        .commit_with(&fixture.interception(&["pre-commit"]), "second")
        .await
        .expect("the commit should succeed");

    let inner = std::fs::read_to_string(fixture.path().join("inner.txt"))
        .expect("the hook should have run");
    assert!(
        inner.contains("hooksPath=[]"),
        "the hook's own git must not use the stand-ins: {inner}"
    );
    assert!(inner.contains("params=[]"), "{inner}");
}

#[tokio::test]
async fn only_the_named_hooks_are_intercepted() {
    // `commit-msg` exists and would refuse the commit, but the operation didn't ask for it — so git never
    // sees a stand-in for it and runs it itself. That it runs at all is git's business; what matters here
    // is that the interception is limited to what was asked for.
    let fixture = Fixture::new().await;
    fixture.write_hook(
        "pre-commit",
        "echo 'pre' > \"$(git rev-parse --show-toplevel)/which.txt\"",
    );
    fixture.write_hook(
        "commit-msg",
        "echo 'msg' >> \"$(git rev-parse --show-toplevel)/which.txt\"",
    );

    fixture
        .commit_with(&fixture.interception(&["pre-commit"]), "second")
        .await
        .expect("the commit should succeed");

    let which =
        std::fs::read_to_string(fixture.path().join("which.txt")).expect("a hook should have run");
    assert!(which.contains("pre"), "{which}");
    assert!(
        !which.contains("msg"),
        "git looks only in the stand-in directory, so an un-intercepted hook is skipped entirely: {which}"
    );
}

#[tokio::test]
async fn a_repository_without_the_named_hooks_is_left_alone() {
    // The common case: no temporary directory, no server, no token — and no `GIT_CONFIG_PARAMETERS`.
    let fixture = Fixture::new().await;
    let path = fixture.path();
    let interception = fixture.interception(&["pre-commit"]);

    let seen = with_hooks_env(
        &path,
        Some(&interception),
        HashMap::new(),
        |env| async move { env },
    )
    .await
    .expect("it should succeed");

    assert!(
        !seen.contains_key("GIT_CONFIG_PARAMETERS"),
        "nothing should be configured: {seen:?}"
    );
    assert!(!seen.contains_key("RDC_HOOK_PROXY_PORT"));
}

#[tokio::test]
async fn the_stand_in_directory_is_removed_afterwards() {
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 0");
    let path = fixture.path();
    let interception = fixture.interception(&["pre-commit"]);

    let directory = with_hooks_env(
        &path,
        Some(&interception),
        HashMap::new(),
        |env| async move {
            let value = env
                .get("GIT_CONFIG_PARAMETERS")
                .expect("the hooks path should be configured")
                .clone();
            // 'core.hooksPath=<dir>'
            let start = value.find('=').expect("an assignment") + 1;
            PathBuf::from(value[start..value.len() - 1].to_owned())
        },
    )
    .await
    .expect("it should succeed");

    assert!(
        !directory.exists(),
        "the stand-ins must not outlive the operation: {}",
        directory.display()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_stand_in_is_a_link_rather_than_a_copy() {
    // Pins the mechanism, not the implementation for its own sake: copying an executable and then running
    // it races with `fork` in another thread, and Linux answers `ETXTBSY` — an intermittent "Text file
    // busy" failure in the middle of a commit. A change back to copying should fail here, with the reason
    // attached, rather than in CI a week later.
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 0");
    let path = fixture.path();
    let interception = fixture.interception(&["pre-commit"]);

    let kind = with_hooks_env(
        &path,
        Some(&interception),
        HashMap::new(),
        |env| async move {
            let value = env
                .get("GIT_CONFIG_PARAMETERS")
                .expect("the hooks path should be configured")
                .clone();
            let start = value.find('=').expect("an assignment") + 1;
            let directory = PathBuf::from(value[start..value.len() - 1].to_owned());

            std::fs::symlink_metadata(directory.join("pre-commit"))
                .expect("the stand-in should exist")
                .file_type()
        },
    )
    .await
    .expect("it should succeed");

    assert!(kind.is_symlink(), "the stand-in must not be a written file");
}

#[tokio::test]
async fn an_existing_config_parameter_survives() {
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 0");
    let path = fixture.path();
    let interception = fixture.interception(&["pre-commit"]);

    let value = with_hooks_env(
        &path,
        Some(&interception),
        HashMap::from([(
            "GIT_CONFIG_PARAMETERS".to_owned(),
            "'protocol.version=2'".to_owned(),
        )]),
        |env| async move { env["GIT_CONFIG_PARAMETERS"].clone() },
    )
    .await
    .expect("it should succeed");

    assert!(value.starts_with("'protocol.version=2' "), "{value}");
    assert!(value.contains("core.hooksPath="), "{value}");
}

#[tokio::test]
async fn the_shell_environment_is_loaded_once_per_operation() {
    // Starting an interactive login shell is slow — hundreds of milliseconds on a machine with version
    // managers — and a commit runs several hooks. The shell counts its own invocations.
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 0");
    fixture.write_hook("commit-msg", "exit 0");
    fixture.write_hook("post-commit", "exit 0");

    let counter = fixture.path().join("shell-invocations.txt");
    let script = fixture.path().join("counting-shell");
    std::fs::write(
        &script,
        format!(
            "echo x >> {}\nexport FROM_THE_SHELL=yes\nexec /bin/sh -c \"$2\"\n",
            counter.display()
        ),
    )
    .expect("failed to write the shell");

    let interception = HookInterception::new(
        ["pre-commit", "commit-msg", "post-commit"]
            .iter()
            .map(|hook| (*hook).to_owned()),
        proxy_binary(),
        printenvz(),
    )
    .with_shell(script_shell(&script));

    fixture
        .commit_with(&interception, "second")
        .await
        .expect("the commit should succeed");

    let invocations = std::fs::read_to_string(&counter)
        .expect("the shell should have run at least once")
        .lines()
        .count();
    assert_eq!(
        invocations, 1,
        "three hooks ran, and the environment was loaded once"
    );
}

#[tokio::test]
async fn a_hook_that_needs_stdin_gets_it() {
    // `pre-push` reads its refs from stdin. The chain has to carry them from git, through the stand-in and
    // the protocol, into the file `git hook run --to-stdin` reads.
    //
    // That option is **newer than `git hook run` itself** — Debian bookworm's git 2.39 has the command and
    // not the option — and it is the only way to give a hook stdin, since git otherwise runs one with none.
    // So this asserts whichever of the two documented behaviours the local git allows: the refs arrive, or
    // the operation fails saying why. Upstream never had to make that distinction because it bundles its
    // own git.
    let fixture = Fixture::new().await;
    fixture.write_hook(
        "pre-push",
        "cat > \"$(git rev-parse --show-toplevel)/pushed.txt\"",
    );

    let remote = tempfile::tempdir().expect("failed to create a temporary directory");
    git(
        &["init", "--bare", "--initial-branch=main"],
        remote.path(),
        "test",
        GitOptions::default(),
    )
    .await
    .expect("init --bare should succeed");

    let path = fixture.path();
    let interception = fixture.interception(&["pre-push"]);
    let remote_path = remote.path().to_string_lossy().into_owned();

    let pushed = with_hooks_env(&path, Some(&interception), HashMap::new(), |env| {
        let path = path.clone();
        async move {
            let mut options = GitOptions::default();
            for (name, value) in env {
                options = options.with_env(name, value);
            }

            git(&["push", &remote_path, "main"], &path, "test", options)
                .await
                .map_err(|error| format!("{error}"))
        }
    })
    .await
    .expect("setting up the interception should succeed");

    if supports_to_stdin(&fixture.path()).await {
        pushed.expect("the push should succeed");
        let refs = std::fs::read_to_string(fixture.path().join("pushed.txt"))
            .expect("the hook should have run");
        assert!(
            refs.contains("refs/heads/main"),
            "the refs git piped in must reach the hook: {refs:?}"
        );
    } else {
        let error = pushed.expect_err("without --to-stdin the hook cannot be given its refs");
        assert!(
            error.contains("expects data on stdin"),
            "the failure has to explain itself: {error}"
        );
        assert!(
            !fixture.path().join("pushed.txt").exists(),
            "the hook must not run without the data it expects"
        );
    }
}

#[tokio::test]
async fn a_missing_proxy_binary_fails_the_operation_rather_than_skipping_hooks() {
    // Running git without interception would mean the user's pre-commit hook silently doesn't run, which
    // is worse than a failed commit.
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 1");
    let path = fixture.path();

    let interception = HookInterception::new(
        ["pre-commit".to_owned()],
        "/nonexistent/rdc-hook-proxy",
        printenvz(),
    )
    .with_shell(fixture.shell.clone());

    let error = with_hooks_env(&path, Some(&interception), HashMap::new(), |_env| async {
        panic!("the operation must not run");
    })
    .await
    .expect_err("setting up the interception should fail");

    // The message names the *binary*, not a hook: the stand-in path is resolved and verified once, before
    // any hook is considered, and the missing path is the actionable detail.
    assert!(
        format!("{error}").contains("/nonexistent/rdc-hook-proxy"),
        "{error}"
    );
}

#[tokio::test]
async fn a_shell_that_cannot_be_loaded_fails_the_hook_and_says_why() {
    // The user has to be told which shell failed, because the fix is a setting rather than anything in the
    // repository.
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "exit 0");

    let interception =
        HookInterception::new(["pre-commit".to_owned()], proxy_binary(), printenvz()).with_shell(
            Shell {
                path: PathBuf::from("/nonexistent/shell"),
                args: vec!["-ilc".to_owned()],
            },
        );

    let error = fixture
        .commit_with(&interception, "second")
        .await
        .expect_err("the commit should be refused");

    assert!(
        error.contains("shell environment") && error.contains("/nonexistent/shell"),
        "{error}"
    );
    assert_eq!(fixture.commit_count().await, 1);
}

// --- the operations that intercept ---
//
// The chain above is driven directly. These drive it the way the app does: through the git operation, which
// owns the list of hooks it can reach. Upstream intercepts in exactly four modules — commit, merge, push and
// pull — and `rebase.ts` deliberately does not.

/// The machinery, with a stand-in shell, as the command layer supplies it.
fn support(fixture: &Fixture) -> HookSupport {
    HookSupport::new(proxy_binary(), printenvz()).with_shell(fixture.shell.clone())
}

#[tokio::test]
async fn create_commit_runs_the_repository_hooks() {
    // The whole point, through the real entry point: the hook sees the shell's environment, and the commit
    // completes.
    let fixture = Fixture::new().await;
    fixture.write_hook(
        "pre-commit",
        "echo \"shell=$FROM_THE_SHELL\" > \"$(git rev-parse --show-toplevel)/hook-ran.txt\"",
    );
    std::fs::write(fixture.path().join("b.txt"), "two\n").expect("failed to write");

    let sha = create_commit(
        fixture.path(),
        "with hooks",
        &[FileToStage::new("b.txt")],
        CommitOptions::default(),
        Some(&support(&fixture)),
    )
    .await
    .expect("the commit should succeed");

    assert_eq!(sha.len(), 40);
    let recorded = std::fs::read_to_string(fixture.path().join("hook-ran.txt"))
        .expect("the hook should have run");
    assert_eq!(recorded.trim(), "shell=yes");
}

#[tokio::test]
async fn a_refusing_pre_commit_hook_stops_the_commit() {
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "echo 'refusing' >&2\nexit 1");
    std::fs::write(fixture.path().join("b.txt"), "two\n").expect("failed to write");
    let before = fixture.commit_count().await;

    let error = create_commit(
        fixture.path(),
        "should be refused",
        &[FileToStage::new("b.txt")],
        CommitOptions::default(),
        Some(&support(&fixture)),
    )
    .await
    .expect_err("the hook refused it");

    assert!(format!("{error}").contains("refusing"), "{error}");
    assert_eq!(
        fixture.commit_count().await,
        before,
        "nothing was committed"
    );
}

#[tokio::test]
async fn without_interception_the_hook_still_runs_but_not_through_us() {
    // git runs hooks regardless — interception only changes *how*. So a commit with no machinery passed must
    // still honour the hook, just with whatever environment the app happens to have.
    let fixture = Fixture::new().await;
    fixture.write_hook("pre-commit", "echo 'refusing' >&2\nexit 1");
    std::fs::write(fixture.path().join("b.txt"), "two\n").expect("failed to write");

    let error = create_commit(
        fixture.path(),
        "should be refused",
        &[FileToStage::new("b.txt")],
        CommitOptions::default(),
        None,
    )
    .await
    .expect_err("git runs the hook itself");

    assert!(format!("{error}").contains("refusing"), "{error}");
}

#[tokio::test]
async fn amending_also_intercepts_post_rewrite() {
    // The one hook whose presence depends on the flags: only an amend rewrites a commit. Which is why the
    // hook list belongs to the operation rather than to the caller.
    let fixture = Fixture::new().await;
    fixture.write_hook(
        "post-rewrite",
        "echo ran > \"$(git rev-parse --show-toplevel)/rewrote.txt\"",
    );

    create_commit(
        fixture.path(),
        "amended",
        &[],
        CommitOptions {
            amend: true,
            allow_empty: true,
            ..CommitOptions::default()
        },
        Some(&support(&fixture)),
    )
    .await
    .expect("the amend should succeed");

    assert!(
        fixture.path().join("rewrote.txt").exists(),
        "post-rewrite is intercepted when amending"
    );
}

#[tokio::test]
async fn reports_every_hook_a_commit_reaches() {
    // Confirms the list the operation passes, by writing one of each and seeing which are reported.
    let fixture = Fixture::new().await;
    for hook in [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
    ] {
        fixture.write_hook(hook, "exit 0");
    }
    std::fs::write(fixture.path().join("b.txt"), "two\n").expect("failed to write");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);

    create_commit(
        fixture.path(),
        "with hooks",
        &[FileToStage::new("b.txt")],
        CommitOptions::default(),
        Some(&support(&fixture).with_progress(move |update| {
            if update.status == HookStatus::Started {
                recorded.lock().expect("not poisoned").push(update.hook)
            }
        })),
    )
    .await
    .expect("the commit should succeed");

    assert_eq!(
        *seen.lock().expect("not poisoned"),
        vec![
            "pre-commit".to_owned(),
            "prepare-commit-msg".to_owned(),
            "commit-msg".to_owned(),
            "post-commit".to_owned(),
        ],
        "in the order git runs them"
    );
}
