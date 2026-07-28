//! Tags.
//!
//! Ported from `desktop-plus/app/src/lib/git/tag.ts`.

use std::collections::HashMap;
use std::path::Path;

use crate::authentication::AUTHENTICATION_ERRORS;
use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::remote_progress::remote_env;

/// Creates an annotated tag pointing at `target_commit`.
///
/// `-a -m ""` makes it annotated with an empty message. Annotated rather than lightweight because a tag
/// object records who made it and when, which a lightweight tag — a bare ref — does not.
pub async fn create_tag(
    repository: impl AsRef<Path>,
    name: &str,
    target_commit: &str,
) -> Result<(), GitError> {
    git(
        &["tag", "-a", "-m", "", name, target_commit],
        repository,
        "createTag",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

/// Deletes a local tag.
pub async fn delete_tag(repository: impl AsRef<Path>, name: &str) -> Result<(), GitError> {
    git(
        &["tag", "-d", name],
        repository,
        "deleteTag",
        GitOptions::default(),
    )
    .await?;

    Ok(())
}

/// Every local tag, mapped to the commit it points at.
///
/// Exit code 1 means there are no tags, which is not a failure.
pub async fn get_all_tags(
    repository: impl AsRef<Path>,
) -> Result<HashMap<String, String>, GitError> {
    let output = git(
        &["show-ref", "--tags", "-d"],
        repository,
        "getAllTags",
        GitOptions::default().with_success_exit_codes([1]),
    )
    .await?;

    Ok(parse_tags(&output.stdout_lossy()))
}

/// Parses `git show-ref --tags -d` into tag name → commit.
///
/// The `-d` is what makes this correct, and the reason is easy to miss. An **annotated** tag produces two
/// lines:
///
/// ```text
/// deadbeef refs/tags/annotated
/// de510b99 refs/tags/annotated^{}
/// ```
///
/// The first SHA is the *tag object*, not the commit — the original's comment said "blob object", which
/// is the wrong object type but the right instinct. The `^{}` line is the dereferenced commit, and it
/// sorts after the plain one, so normalising both names to `annotated` and letting the later entry win
/// leaves the **commit** in the map. Without `-d` the second line wouldn't exist and every annotated tag
/// would map to its tag object instead.
fn parse_tags(stdout: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }

        let Some((sha, raw_name)) = line.split_once(' ') else {
            continue;
        };

        let name = raw_name
            .strip_prefix("refs/tags/")
            .unwrap_or(raw_name)
            .strip_suffix("^{}")
            .unwrap_or_else(|| raw_name.strip_prefix("refs/tags/").unwrap_or(raw_name));

        tags.insert(name.to_owned(), sha.to_owned());
    }

    tags
}

/// The tags a push would send, without sending them.
///
/// `--dry-run --porcelain` with `--follow-tags` asks git what it *would* do. **Contacts the remote**, so
/// it needs the credential environment.
///
/// Exit codes 0 and 1 both produce parseable output; anything else does not, so it is reported as an
/// error rather than parsed. The original threw `result.gitError` here — which is `null` when the failure
/// wasn't classified, so it threw `null`. This returns a real error instead.
pub async fn fetch_tags_to_push(
    repository: impl AsRef<Path>,
    remote_name: &str,
    branch_name: &str,
    env: &HashMap<String, String>,
) -> Result<Vec<String>, GitError> {
    let mut options = GitOptions::default()
        .with_success_exit_codes([1, 128])
        .with_expected_errors(AUTHENTICATION_ERRORS);

    for (key, value) in remote_env(env) {
        options = options.with_env(key, value);
    }

    let output = git(
        &[
            "push",
            remote_name,
            branch_name,
            "--follow-tags",
            "--dry-run",
            "--no-verify",
            "--porcelain",
        ],
        repository,
        "fetchTagsToPush",
        options,
    )
    .await?;

    if output.exit_code != 0 && output.exit_code != 1 {
        return Err(GitError::UnexpectedExitCode {
            name: "fetchTagsToPush".to_owned(),
            path: output.path.clone(),
            exit_code: output.exit_code,
            kind: output.git_error,
            stderr: output.stderr.clone(),
        });
    }

    Ok(parse_tags_to_push(&output.stdout_lossy()))
}

/// Parses `push --porcelain --dry-run` output for tags that would be created.
///
/// The first line is `To <remote>` and the last is `Done`, so both are skipped. A new tag appears as
/// `*\t<local>:<remote>\t[new tag]`.
fn parse_tags_to_push(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .skip(1)
        .take_while(|line| *line != "Done")
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();

            if parts.first() != Some(&"*") || parts.get(2) != Some(&"[new tag]") {
                return None;
            }

            let refs = parts.get(1)?;
            let local = refs.split(':').next()?;
            Some(local.strip_prefix("refs/tags/").unwrap_or(local).to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    // --- show-ref parsing ---

    #[test]
    fn maps_a_lightweight_tag_to_its_commit() {
        let stdout = "aaaaaaa refs/tags/light\n";
        assert_eq!(
            parse_tags(stdout).get("light").map(String::as_str),
            Some("aaaaaaa")
        );
    }

    #[test]
    fn maps_an_annotated_tag_to_its_commit_not_its_tag_object() {
        // The subtlety `-d` exists for: the dereferenced entry comes second and must win.
        let stdout = "tagobject refs/tags/annotated\ncommitsha refs/tags/annotated^{}\n";
        let tags = parse_tags(stdout);

        assert_eq!(tags.len(), 1, "both lines describe one tag");
        assert_eq!(
            tags.get("annotated").map(String::as_str),
            Some("commitsha"),
            "the dereferenced commit wins over the tag object"
        );
    }

    #[test]
    fn parses_several_tags() {
        let stdout = concat!(
            "aaaaaaa refs/tags/one\n",
            "bbbbbbb refs/tags/two\n",
            "ccccccc refs/tags/two^{}\n",
        );
        let tags = parse_tags(stdout);

        assert_eq!(tags.len(), 2);
        assert_eq!(tags.get("one").map(String::as_str), Some("aaaaaaa"));
        assert_eq!(tags.get("two").map(String::as_str), Some("ccccccc"));
    }

    #[test]
    fn parses_no_tags_from_empty_output() {
        assert!(parse_tags("").is_empty());
    }

    #[test]
    fn keeps_a_tag_name_containing_a_slash() {
        let stdout = "aaaaaaa refs/tags/release/1.0\n";
        assert!(parse_tags(stdout).contains_key("release/1.0"));
    }

    // --- porcelain parsing ---

    #[test]
    fn finds_the_tags_a_push_would_create() {
        let stdout = concat!(
            "To https://github.com/o/r.git\n",
            "*\trefs/tags/v1.0:refs/tags/v1.0\t[new tag]\n",
            "*\trefs/tags/v2.0:refs/tags/v2.0\t[new tag]\n",
            "Done\n",
        );

        assert_eq!(
            parse_tags_to_push(stdout),
            vec!["v1.0".to_owned(), "v2.0".to_owned()]
        );
    }

    #[test]
    fn ignores_branch_updates_and_up_to_date_tags() {
        let stdout = concat!(
            "To https://github.com/o/r.git\n",
            "=\trefs/heads/main:refs/heads/main\t[up to date]\n",
            "*\trefs/tags/v1.0:refs/tags/v1.0\t[new tag]\n",
            "Done\n",
        );

        assert_eq!(parse_tags_to_push(stdout), vec!["v1.0".to_owned()]);
    }

    #[test]
    fn stops_at_the_done_line() {
        // Anything after `Done` is not a ref update.
        let stdout = concat!(
            "To https://github.com/o/r.git\n",
            "*\trefs/tags/v1.0:refs/tags/v1.0\t[new tag]\n",
            "Done\n",
            "*\trefs/tags/never:refs/tags/never\t[new tag]\n",
        );

        assert_eq!(parse_tags_to_push(stdout), vec!["v1.0".to_owned()]);
    }

    #[test]
    fn finds_no_tags_when_there_are_none_to_push() {
        let stdout = "To https://github.com/o/r.git\nDone\n";
        assert!(parse_tags_to_push(stdout).is_empty());
    }

    // --- against real repositories ---

    #[tokio::test]
    async fn creates_and_lists_a_tag() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        let head = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        create_tag(repo.path(), "v1.0", &head)
            .await
            .expect("creating should succeed");

        let tags = get_all_tags(repo.path()).await.expect("should succeed");
        assert_eq!(
            tags.get("v1.0").map(String::as_str),
            Some(head.as_str()),
            "an annotated tag maps to its commit, not its tag object: {tags:?}"
        );
    }

    #[tokio::test]
    async fn a_repository_with_no_tags_lists_none() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert!(get_all_tags(repo.path())
            .await
            .expect("no tags is not an error")
            .is_empty());
    }

    #[tokio::test]
    async fn deletes_a_tag() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        create_tag(repo.path(), "v1.0", "HEAD")
            .await
            .expect("creating should succeed");

        delete_tag(repo.path(), "v1.0")
            .await
            .expect("deleting should succeed");

        assert!(get_all_tags(repo.path())
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn deleting_a_tag_that_does_not_exist_fails() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");

        assert!(delete_tag(repo.path(), "nosuchtag").await.is_err());
    }

    #[tokio::test]
    async fn reports_the_tags_a_push_would_send() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        create_tag(repo.path(), "v1.0", "HEAD")
            .await
            .expect("creating should succeed");

        // A bare repository as the remote, so nothing touches the network.
        let remote = tempfile::tempdir().expect("failed to create a temporary directory");
        git(
            &["init", "--bare", "--initial-branch=main"],
            remote.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("init --bare should succeed");
        git(
            &["remote", "add", "origin", &remote.path().to_string_lossy()],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("remote add should succeed");

        let tags = fetch_tags_to_push(repo.path(), "origin", "main", &HashMap::new())
            .await
            .expect("should succeed");

        assert_eq!(tags, vec!["v1.0".to_owned()]);
    }

    #[tokio::test]
    async fn reports_no_tags_to_push_once_they_are_pushed() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "a.txt", "one\n", "first");
        create_tag(repo.path(), "v1.0", "HEAD")
            .await
            .expect("creating should succeed");

        let remote = tempfile::tempdir().expect("failed to create a temporary directory");
        git(
            &["init", "--bare", "--initial-branch=main"],
            remote.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("init --bare should succeed");
        git(
            &["remote", "add", "origin", &remote.path().to_string_lossy()],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("remote add should succeed");
        git(
            &["push", "origin", "main", "--follow-tags"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("push should succeed");

        assert!(
            fetch_tags_to_push(repo.path(), "origin", "main", &HashMap::new())
                .await
                .expect("should succeed")
                .is_empty()
        );
    }
}
