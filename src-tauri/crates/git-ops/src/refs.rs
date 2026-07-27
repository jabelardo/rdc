//! Ref name formatting and symbolic ref lookup.
//!
//! Ported from `desktop-plus/app/src/lib/git/refs.ts`.

use std::path::Path;

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// Fully qualifies a local branch name as a ref.
///
/// git usually reports the short name, but will include a `heads/` prefix when a short name would
/// be ambiguous with a remote ref of the same name — hence the three cases.
///
/// ```text
/// main                     -> refs/heads/main
/// heads/Microsoft/main     -> refs/heads/Microsoft/main
/// refs/heads/main          -> refs/heads/main
/// ```
pub fn format_as_local_ref(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("heads/") {
        // git reported it this way to disambiguate from a remote ref.
        format!("refs/heads/{rest}")
    } else if !name.starts_with("refs/heads/") {
        format!("refs/heads/{name}")
    } else {
        name.to_owned()
    }
}

/// Resolves a symbolic ref, or `None` if it doesn't exist or isn't symbolic.
pub async fn get_symbolic_ref(
    repository: impl AsRef<Path>,
    ref_name: &str,
) -> Result<Option<String>, GitError> {
    let result = git(
        &["symbolic-ref", "-q", ref_name],
        repository,
        "getSymbolicRef",
        // 1: not a symbolic ref (in -q mode). 128: git couldn't find it at all.
        GitOptions::default().with_success_exit_codes([1, 128]),
    )
    .await?;

    Ok(if result.exit_code == 0 {
        Some(result.stdout_trimmed())
    } else {
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    #[test]
    fn qualifies_a_short_branch_name() {
        assert_eq!(format_as_local_ref("main"), "refs/heads/main");
    }

    #[test]
    fn qualifies_a_heads_prefixed_name() {
        assert_eq!(
            format_as_local_ref("heads/Microsoft/main"),
            "refs/heads/Microsoft/main"
        );
    }

    #[test]
    fn leaves_an_already_qualified_ref_alone() {
        assert_eq!(format_as_local_ref("refs/heads/main"), "refs/heads/main");
    }

    #[test]
    fn qualifies_a_name_containing_slashes() {
        assert_eq!(
            format_as_local_ref("feature/thing"),
            "refs/heads/feature/thing"
        );
    }

    #[tokio::test]
    async fn resolves_head_to_the_current_branch() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");

        assert_eq!(
            get_symbolic_ref(repo.path(), "HEAD")
                .await
                .expect("should not error")
                .as_deref(),
            Some("refs/heads/main")
        );
    }

    #[tokio::test]
    async fn returns_none_for_a_ref_that_is_not_symbolic() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents", "first");

        // A branch ref points at a commit, not another ref.
        assert_eq!(
            get_symbolic_ref(repo.path(), "refs/heads/main")
                .await
                .expect("should not error"),
            None
        );
    }
}
