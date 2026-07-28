//! Cloning a repository.
//!
//! Ported from `desktop-plus/app/src/lib/git/clone.ts`.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::GitOutput;
use crate::progress::GitProgressParser;
use crate::remote_progress::{run_with_progress, ContextLines, RemoteRun};

/// A clone progress update.
///
/// Matches `ICloneProgress` in the ported `src/models/progress.ts`. Unlike the other remote
/// operations there is no `remote` field: a clone has no configured remote yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub kind: CloneProgressKind,
    pub value: f64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloneProgressKind {
    Clone,
}

/// Options for [`clone`].
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloneOptions {
    /// The branch to check out once the clone finishes.
    pub branch: Option<String>,

    /// The branch name to use if the repository turns out to be empty.
    ///
    /// A clone of an empty repository has no branch to adopt, so git falls back to
    /// `init.defaultBranch`. Passing it explicitly means the result doesn't depend on the machine's
    /// global git configuration.
    ///
    /// `None` leaves git's own default in place. The original resolved the app's default here instead;
    /// that is app policy — the same reasoning as `init_repository` in [`crate::init`], where a
    /// `"main"` fallback was deliberately kept above this crate.
    pub default_branch: Option<String>,
}

/// Clones `url` into `path`.
///
/// `login` is inserted into the URL as userinfo when present, which is how the original told the
/// credential helper *which* account to use for a host the user has several of.
///
/// # `GIT_CLONE_PROTECTION_ACTIVE=false`
///
/// This disables a git check, and it is worth being precise about which one. git 2.45 shipped the fix
/// for **CVE-2024-32002** — a malicious repository whose submodule could write into `.git/hooks` and
/// get code executed during `clone --recursive`. Alongside the fix it added a *defense-in-depth* layer:
/// refuse to clone when the repository being cloned has hooks that would run. This variable turns off
/// that layer, **not the CVE fix itself**, which is unconditional.
///
/// The original disabled it, and there is a real reason to: the check is known to break `git clone` for
/// repositories using Git LFS, which cannot be worked around on the LFS side. So this is a tradeoff
/// between a belt-and-braces check and cloning LFS repositories at all, and the original chose the
/// latter.
///
/// Preserved rather than changed, because flipping it would break LFS clones and the primary
/// protection is still in force — but it is a deliberate security-relevant choice, recorded in
/// `MIGRATION_MAP.md` §8 rather than left as an unexplained environment variable.
pub async fn clone<F>(
    url: &str,
    path: impl AsRef<Path>,
    login: Option<&str>,
    options: &CloneOptions,
    env: &HashMap<String, String>,
    on_progress: Option<F>,
) -> Result<GitOutput, GitError>
where
    F: FnMut(CloneProgress) + Send,
{
    let path = path.as_ref();
    let remote_url = url_with_login(url, login);

    let mut args = Vec::new();

    if let Some(default_branch) = &options.default_branch {
        args.extend([
            "-c".to_owned(),
            format!("init.defaultBranch={default_branch}"),
        ]);
    }

    // `--recursive` so submodules are present; that is also why the clone-protection note above
    // matters, since the CVE only applies to recursive clones.
    args.extend(["clone".to_owned(), "--recursive".to_owned()]);

    let title = format!("Cloning into {}", path.display());
    let listening = on_progress.is_some();

    if listening {
        args.push("--progress".to_owned());
    }

    if let Some(branch) = &options.branch {
        args.extend(["-b".to_owned(), branch.clone()]);
    }

    // `--` so a URL or path beginning with a dash can't be read as an option.
    args.extend([
        "--".to_owned(),
        remote_url,
        path.to_string_lossy().into_owned(),
    ]);

    let mut env = env.clone();
    env.insert("GIT_CLONE_PROTECTION_ACTIVE".to_owned(), "false".to_owned());

    // git needs *a* working directory that exists, and the destination doesn't yet. The parent is the
    // most predictable choice; the original used the app's own install directory, which is arbitrary
    // and would make a relative destination resolve somewhere surprising.
    let working_directory = working_directory_for(path)?;

    let run = |parser| RemoteRun {
        args: &args,
        name: "clone",
        env: &env,
        success_exit_codes: &[],
        parser,
        context: ContextLines::Include,
    };

    let Some(mut on_progress) = on_progress else {
        return run_with_progress(
            &working_directory,
            run(GitProgressParser::clone()),
            |_, _| {},
        )
        .await;
    };

    on_progress(CloneProgress {
        kind: CloneProgressKind::Clone,
        value: 0.0,
        title: title.clone(),
        description: None,
    });

    run_with_progress(
        &working_directory,
        run(GitProgressParser::clone()),
        |value, description| {
            on_progress(CloneProgress {
                kind: CloneProgressKind::Clone,
                value,
                title: title.clone(),
                description: Some(description),
            });
        },
    )
    .await
}

/// A directory that exists, from which to run the clone.
///
/// Creates the destination's parent if it is missing, matching the original's promise that the path
/// will be created — git creates the final directory but the clone has to *run* somewhere first.
fn working_directory_for(path: &Path) -> Result<std::path::PathBuf, GitError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());

    match parent {
        Some(parent) => {
            std::fs::create_dir_all(parent).map_err(|source| GitError::Spawn {
                name: "clone".to_owned(),
                path: parent.to_owned(),
                source,
            })?;
            Ok(parent.to_owned())
        }
        // A bare relative destination such as `repo`: run where we already are.
        None => std::env::current_dir().map_err(|source| GitError::Spawn {
            name: "clone".to_owned(),
            path: path.to_owned(),
            source,
        }),
    }
}

/// Inserts `login` into `url` as userinfo.
///
/// Only for the schemes the original listed, and only immediately after the scheme separator. A URL
/// that already carries userinfo is left alone — replacing it would override an explicit choice, and
/// producing `a@b@host` would be worse.
fn url_with_login(url: &str, login: Option<&str>) -> String {
    let Some(login) = login.filter(|login| !login.is_empty()) else {
        return url.to_owned();
    };

    const SCHEMES: [&str; 6] = [
        "https://",
        "http://",
        "git+ssh://",
        "git://",
        "ssh://",
        "file://",
    ];

    for scheme in SCHEMES {
        // Case-insensitively, as the original's `/i` flag.
        if url.len() >= scheme.len() && url[..scheme.len()].eq_ignore_ascii_case(scheme) {
            let rest = &url[scheme.len()..];

            // Userinfo already present — only when the `@` precedes the first `/`, so an `@` inside a
            // path doesn't count.
            let authority_end = rest.find('/').unwrap_or(rest.len());
            if rest[..authority_end].contains('@') {
                return url.to_owned();
            }

            return format!("{}{login}@{rest}", &url[..scheme.len()]);
        }
    }

    // An scp-style address (`git@host:path`) or anything else: left untouched, as the original's
    // anchored pattern also did.
    url.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{git, GitOptions};
    use crate::test_support::{commit_file, empty_repository};

    // --- login insertion ---

    #[test]
    fn inserts_a_login_after_the_scheme() {
        assert_eq!(
            url_with_login("https://github.com/o/r.git", Some("octocat")),
            "https://octocat@github.com/o/r.git"
        );
    }

    #[test]
    fn inserts_a_login_for_every_supported_scheme() {
        for scheme in ["https", "http", "git+ssh", "git", "ssh", "file"] {
            let url = format!("{scheme}://host/path");
            assert_eq!(
                url_with_login(&url, Some("me")),
                format!("{scheme}://me@host/path"),
                "{scheme} should be handled"
            );
        }
    }

    #[test]
    fn matches_the_scheme_case_insensitively() {
        assert_eq!(
            url_with_login("HTTPS://github.com/o/r", Some("me")),
            "HTTPS://me@github.com/o/r"
        );
    }

    #[test]
    fn leaves_a_url_that_already_has_userinfo_alone() {
        // Replacing it would override an explicit choice, and appending would produce `a@b@host`.
        assert_eq!(
            url_with_login("https://someone@github.com/o/r", Some("me")),
            "https://someone@github.com/o/r"
        );
    }

    #[test]
    fn is_not_fooled_by_an_at_sign_in_the_path() {
        // Only an `@` inside the authority counts as userinfo.
        assert_eq!(
            url_with_login("https://github.com/o/r@v1", Some("me")),
            "https://me@github.com/o/r@v1"
        );
    }

    #[test]
    fn leaves_an_scp_style_address_alone() {
        // `git@github.com:o/r.git` has no scheme, and the original's pattern was anchored too.
        assert_eq!(
            url_with_login("git@github.com:o/r.git", Some("me")),
            "git@github.com:o/r.git"
        );
    }

    #[test]
    fn does_nothing_without_a_login() {
        assert_eq!(
            url_with_login("https://github.com/o/r", None),
            "https://github.com/o/r"
        );
        assert_eq!(
            url_with_login("https://github.com/o/r", Some("")),
            "https://github.com/o/r"
        );
    }

    // --- cloning ---

    /// A repository on disk to clone from, so nothing touches the network.
    async fn source_repository() -> crate::test_support::TempRepository {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        repo
    }

    #[tokio::test]
    async fn clones_a_repository() {
        let source = source_repository().await;
        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("cloned");

        clone(
            &source.path().to_string_lossy(),
            &target,
            None,
            &CloneOptions::default(),
            &HashMap::new(),
            None::<fn(CloneProgress)>,
        )
        .await
        .expect("clone should succeed");

        assert!(target.join(".git").exists());
        let contents = std::fs::read_to_string(target.join("a.txt")).expect("failed to read back");
        assert_eq!(contents, "one\n");
    }

    #[tokio::test]
    async fn creates_missing_parent_directories() {
        // The original promised the path would be created; git makes the final directory but the clone
        // has to run somewhere that already exists.
        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("deeply/nested/cloned");
        let source = source_repository().await;

        clone(
            &source.path().to_string_lossy(),
            &target,
            None,
            &CloneOptions::default(),
            &HashMap::new(),
            None::<fn(CloneProgress)>,
        )
        .await
        .expect("clone should succeed");

        assert!(target.join(".git").exists());
    }

    #[tokio::test]
    async fn checks_out_the_requested_branch() {
        let source = source_repository().await;
        git(
            &["branch", "topic"],
            source.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("branch should succeed");

        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("cloned");

        clone(
            &source.path().to_string_lossy(),
            &target,
            None,
            &CloneOptions {
                branch: Some("topic".to_owned()),
                ..CloneOptions::default()
            },
            &HashMap::new(),
            None::<fn(CloneProgress)>,
        )
        .await
        .expect("clone should succeed");

        let head = git(
            &["symbolic-ref", "--short", "HEAD"],
            &target,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("symbolic-ref should succeed")
        .stdout_trimmed();
        assert_eq!(head, "topic");
    }

    #[tokio::test]
    async fn cloning_an_empty_repository_adopts_the_sources_branch_name() {
        // Verified against real git, and narrower than the original implies: a clone of an empty
        // repository takes the *source's* unborn branch name when the remote advertises it, which a
        // local or modern-protocol remote does. `init.defaultBranch` only decides when the remote
        // doesn't — so passing it is a fallback for a case that rarely fires, not the usual path.
        //
        // The original called `getDefaultBranch()` on every clone for this, which is why the value is a
        // caller-supplied option here rather than something resolved inside the crate.
        let source = empty_repository().await;
        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("cloned");

        clone(
            &source.path().to_string_lossy(),
            &target,
            None,
            &CloneOptions {
                default_branch: Some("trunk".to_owned()),
                ..CloneOptions::default()
            },
            &HashMap::new(),
            None::<fn(CloneProgress)>,
        )
        .await
        .expect("cloning an empty repository should succeed");

        let source_head = git(
            &["symbolic-ref", "--short", "HEAD"],
            source.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("symbolic-ref should succeed")
        .stdout_trimmed();

        let cloned_head = git(
            &["symbolic-ref", "--short", "HEAD"],
            &target,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("symbolic-ref should succeed")
        .stdout_trimmed();

        assert_eq!(
            cloned_head, source_head,
            "the source's name wins over init.defaultBranch"
        );
    }

    #[tokio::test]
    async fn passing_a_default_branch_does_not_disturb_a_normal_clone() {
        // The option is inert when the remote has commits, so supplying it is always safe.
        let source = source_repository().await;
        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("cloned");

        clone(
            &source.path().to_string_lossy(),
            &target,
            None,
            &CloneOptions {
                default_branch: Some("trunk".to_owned()),
                ..CloneOptions::default()
            },
            &HashMap::new(),
            None::<fn(CloneProgress)>,
        )
        .await
        .expect("clone should succeed");

        let head = git(
            &["symbolic-ref", "--short", "HEAD"],
            &target,
            "test",
            GitOptions::default(),
        )
        .await
        .expect("symbolic-ref should succeed")
        .stdout_trimmed();
        assert_eq!(head, "main");
    }

    #[tokio::test]
    async fn reports_progress_starting_at_zero() {
        let source = source_repository().await;
        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("cloned");
        let mut updates: Vec<CloneProgress> = Vec::new();

        clone(
            &source.path().to_string_lossy(),
            &target,
            None,
            &CloneOptions::default(),
            &HashMap::new(),
            Some(|progress: CloneProgress| updates.push(progress)),
        )
        .await
        .expect("clone should succeed");

        assert!(!updates.is_empty());
        assert_eq!(updates[0].value, 0.0);
        assert_eq!(updates[0].description, None);
        assert!(updates[0].title.starts_with("Cloning into "));
        assert!(updates.iter().all(|u| u.kind == CloneProgressKind::Clone));
    }

    #[tokio::test]
    async fn fails_for_a_source_that_does_not_exist() {
        let destination = tempfile::tempdir().expect("failed to create a temporary directory");
        let target = destination.path().join("cloned");

        assert!(clone(
            "/no/such/repository",
            &target,
            None,
            &CloneOptions::default(),
            &HashMap::new(),
            None::<fn(CloneProgress)>,
        )
        .await
        .is_err());
    }

    #[test]
    fn progress_omits_the_description_rather_than_sending_null() {
        let value = serde_json::to_value(CloneProgress {
            kind: CloneProgressKind::Clone,
            value: 0.0,
            title: "Cloning into /tmp/x".to_owned(),
            description: None,
        })
        .expect("serializes");

        assert!(value.get("description").is_none());
        assert_eq!(value["kind"], "clone");
    }
}
