//! Running a remote operation while streaming its progress.
//!
//! `push`, `fetch` and `pull` differ in their arguments and step weights but share everything else:
//! stream stderr and the `GIT_LFS_PROGRESS` side channel, parse both, and report a fraction plus a
//! description. That common part lives here so the three modules stay close to their originals.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::authentication::{env_for_authentication, AUTHENTICATION_ERRORS};
use crate::error::GitError;
use crate::exec::{git_with_stderr_and_lfs, GitOptions, GitOutput};
use crate::progress::{
    parse_progress_line, GitLfsProgressParser, GitProgress, GitProgressParser, ProgressLineSplitter,
};

/// Which non-progress lines are worth reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContextLines {
    /// Report every line, including messages that aren't progress. What `push` does.
    Include,

    /// Report only `remote: Counting objects`.
    ///
    /// What `fetch` and `pull` do, and the original explained why: their stderr also carries ref-update
    /// summaries, which are not progress and would otherwise be shown as though they were. Counting is
    /// let through because it is the first sign of life on a slow connection, before any percentage
    /// exists to report.
    OnlyCountingObjects,
}

impl ContextLines {
    fn allows(self, text: &str) -> bool {
        match self {
            Self::Include => true,
            Self::OnlyCountingObjects => text.starts_with("remote: Counting objects"),
        }
    }
}

/// The environment for a remote operation: git's own requirements plus whatever the caller adds.
///
/// `extra` wins, so a caller can override `GIT_TRACE` or supply the trampoline variables.
pub(crate) fn remote_env(extra: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = env_for_authentication();
    env.extend(extra.iter().map(|(k, v)| (k.clone(), v.clone())));
    env
}

/// One remote invocation: everything about it except where it runs and who watches it.
pub(crate) struct RemoteRun<'a> {
    pub args: &'a [String],
    /// Identifies the operation in errors, as elsewhere in this crate.
    pub name: &'a str,
    /// The credential/proxy environment from the caller. Merged over git's own requirements.
    pub env: &'a HashMap<String, String>,
    /// Exit codes to accept beyond `0`.
    pub success_exit_codes: &'a [i32],
    pub parser: GitProgressParser,
    pub context: ContextLines,
}

/// Runs git, reporting progress as it arrives.
///
/// `on_progress` receives `(fraction, description)`. It is called **only** for lines the parser or
/// `context` accepts, so a caller never has to filter.
///
/// Authentication failures are declared expected, so they arrive as
/// [`GitOutput::git_error`] rather than an `Err` — the caller decides whether to prompt and retry.
pub(crate) async fn run_with_progress<F>(
    repository: impl AsRef<Path>,
    run: RemoteRun<'_>,
    on_progress: F,
) -> Result<GitOutput, GitError>
where
    F: FnMut(f64, String) + Send,
{
    let RemoteRun {
        args,
        name,
        env: extra_env,
        success_exit_codes,
        mut parser,
        context,
    } = run;

    let mut options = GitOptions::default()
        .with_expected_errors(AUTHENTICATION_ERRORS)
        .with_success_exit_codes(success_exit_codes.iter().copied());

    for (key, value) in remote_env(extra_env) {
        options = options.with_env(key, value);
    }

    let on_progress = Arc::new(Mutex::new(on_progress));
    let regular_callback = Arc::clone(&on_progress);
    let lfs_callback = Arc::clone(&on_progress);
    let lfs_active = Arc::new(AtomicBool::new(false));
    let regular_lfs_active = Arc::clone(&lfs_active);
    let lfs_lfs_active = Arc::clone(&lfs_active);
    let mut splitter = ProgressLineSplitter::new();
    let mut lfs_parser = GitLfsProgressParser::default();

    let output = git_with_stderr_and_lfs(
        args,
        repository,
        name,
        options,
        |chunk| {
            for line in splitter.push(chunk) {
                with_callback(&regular_callback, |callback| {
                    report(&mut parser, context, &line, &regular_lfs_active, callback);
                });
            }
        },
        |line| {
            let progress = lfs_parser.parse(line);
            if matches!(progress, GitProgress::Progress { .. }) {
                lfs_lfs_active.store(true, Ordering::Release);
                with_callback(&lfs_callback, |callback| {
                    callback(progress.percent(), progress.description().to_owned());
                });
            }
        },
    )
    .await?;

    // git's last progress line may arrive without a trailing delimiter.
    if let Some(line) = splitter.flush() {
        with_callback(&on_progress, |callback| {
            report(&mut parser, context, &line, &lfs_active, callback);
        });
    }

    Ok(output)
}

fn report<F>(
    parser: &mut GitProgressParser,
    context: ContextLines,
    line: &str,
    lfs_active: &AtomicBool,
    on_progress: &mut F,
) where
    F: FnMut(f64, String),
{
    let progress = parser.parse(line);

    match &progress {
        GitProgress::Progress { .. } => {
            on_progress(progress.percent(), progress.description().to_owned());
        }
        GitProgress::Context { text, .. } => {
            if lfs_active.load(Ordering::Acquire) {
                if let Some(details) = parse_progress_line(line) {
                    if details.title == "Filtering content" && details.done {
                        lfs_active.store(false, Ordering::Release);
                    }
                }
                return;
            }
            if context.allows(text) {
                on_progress(progress.percent(), text.clone());
            }
        }
    }
}

fn with_callback<F, R>(callback: &Mutex<F>, invoke: impl FnOnce(&mut F) -> R) -> R {
    let mut callback = callback
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    invoke(&mut callback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_reports_every_line() {
        assert!(ContextLines::Include.allows("Everything up-to-date"));
        assert!(ContextLines::Include.allows("remote: Counting objects: 5"));
    }

    #[test]
    fn fetch_reports_only_counting_objects() {
        // Ref-update summaries are not progress; showing them as such was what the original guarded
        // against.
        let context = ContextLines::OnlyCountingObjects;
        assert!(context.allows("remote: Counting objects: 5"));
        assert!(!context.allows(" * [new branch] main -> origin/main"));
        assert!(!context.allows("From https://github.com/o/r"));
    }

    #[test]
    fn the_callers_environment_overrides_the_defaults() {
        // So a caller can turn tracing on, or add the trampoline variables.
        let env = remote_env(&HashMap::from([("GIT_TRACE".to_owned(), "1".to_owned())]));

        assert_eq!(env.get("GIT_TRACE").map(String::as_str), Some("1"));
        assert_eq!(
            env.get("GIT_TERMINAL_PROMPT").map(String::as_str),
            Some("0"),
            "the defaults it didn't override are still present"
        );
    }

    #[test]
    fn reports_progress_and_allowed_context_only() {
        let mut reported = Vec::new();
        let mut parser = GitProgressParser::fetch();

        for line in [
            "remote: Counting objects: 5",
            "From https://github.com/o/r",
            "Receiving objects:  50% (1/2)",
        ] {
            report(
                &mut parser,
                ContextLines::OnlyCountingObjects,
                line,
                &AtomicBool::new(false),
                &mut |percent, text| reported.push((percent, text)),
            );
        }

        assert_eq!(reported.len(), 2, "got {reported:?}");
        assert_eq!(reported[0].1, "remote: Counting objects: 5");
        assert_eq!(reported[1].1, "Receiving objects:  50% (1/2)");
        assert!(reported[1].0 > reported[0].0);
    }

    #[tokio::test]
    async fn reports_live_lfs_progress_from_the_side_channel() {
        let repo = crate::test_support::empty_repository().await;
        let args = vec![
            "-c".to_owned(),
            "alias.emit-lfs=!printf 'download 1/1 5/5 file.bin\\n' >> \
             \"$GIT_LFS_PROGRESS\""
                .to_owned(),
            "emit-lfs".to_owned(),
        ];
        let mut updates = Vec::new();

        run_with_progress(
            repo.path(),
            RemoteRun {
                args: &args,
                name: "test",
                env: &HashMap::new(),
                success_exit_codes: &[],
                parser: GitProgressParser::fetch(),
                context: ContextLines::Include,
            },
            |value, description| updates.push((value, description)),
        )
        .await
        .unwrap();

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].0, 0.0);
        assert!(updates[0].1.starts_with("Downloading file.bin"));
    }
}
