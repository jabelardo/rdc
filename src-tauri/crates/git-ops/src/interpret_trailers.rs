//! Commit-message trailers.
//!
//! Ported from `desktop-plus/app/src/lib/git/interpret-trailers.ts`.
//!
//! Trailers are the `Key: value` lines at the end of a commit message, e.g. `Co-Authored-By`. What
//! counts as a trailer, and how one is formatted, is configurable per repository
//! (`trailer.separators`, and more), which is why this defers to `git interpret-trailers` rather
//! than pattern-matching the message itself.
//!
//! # Split with the frontend
//!
//! The original module mixed two unrelated things: git invocation, and the plain `ITrailer` type
//! plus a one-line `isCoAuthoredByTrailer` predicate. `models/commit.ts` imported only the latter
//! two — which dragged the whole git layer into the commit model and, transitively, into several
//! tests. Those now live in `rdc/src/models/trailer.ts` on the TypeScript side; everything that
//! actually needs to run git is here.

use std::path::Path;

use crate::config::get_config_value;
use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// The default separator between a trailer's token and value.
const DEFAULT_SEPARATORS: &str = ":";

/// A commit-message trailer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trailer {
    pub token: String,
    pub value: String,
}

impl Trailer {
    /// Whether this trailer's token is `Co-Authored-By`, in any casing.
    ///
    /// Does not validate the value.
    pub fn is_co_authored_by(&self) -> bool {
        self.token.eq_ignore_ascii_case("co-authored-by")
    }
}

/// Parses a single unfolded trailer line, or `None` if it isn't one.
///
/// `separators` is a set of *characters*, any of which may separate token from value — see the
/// `trailer.separators` git config option.
///
/// Note the `> 0` bound from the original: a separator at index 0 would mean an empty token, so
/// such a line isn't a trailer.
pub fn parse_single_unfolded_trailer(line: &str, separators: &str) -> Option<Trailer> {
    for separator in separators.chars() {
        // Byte index, which is what splitting needs; `find` returns one on a char boundary.
        if let Some(index) = line.find(separator) {
            if index > 0 {
                return Some(Trailer {
                    token: line[..index].trim().to_owned(),
                    // `separator.len_utf8()` rather than 1: a separator character may be
                    // multi-byte, and the original's `ix + 1` was in UTF-16 units.
                    value: line[index + separator.len_utf8()..].trim().to_owned(),
                });
            }
        }
    }

    None
}

/// Parses a string of unfolded trailers, one per line.
///
/// Expects output from `git interpret-trailers --only-input --only-trailers --unfold` or an
/// equivalent such as `git log --format="%(trailers:only,unfold)"`. Lines that aren't trailers are
/// skipped.
pub fn parse_raw_unfolded_trailers(trailers: &str, separators: &str) -> Vec<Trailer> {
    trailers
        .split('\n')
        .filter_map(|line| parse_single_unfolded_trailer(line, separators))
        .collect()
}

/// The characters this repository may use to separate a trailer's token from its value.
///
/// Falls back to `:` when `trailer.separators` isn't configured.
pub async fn get_trailer_separator_characters(
    repository: impl AsRef<Path>,
) -> Result<String, GitError> {
    let configured = get_config_value(repository, "trailer.separators", false).await?;
    Ok(match configured {
        // An empty configured value falls back too, matching the original's `|| ':'`.
        Some(value) if !value.is_empty() => value,
        _ => DEFAULT_SEPARATORS.to_owned(),
    })
}

/// Extracts the trailers from a commit message.
///
/// Returned trailers are unfolded — whitespace continuations are removed so each is on one line.
/// Runs in `repository` because trailer format and position are configurable per repository.
pub async fn parse_trailers(
    repository: impl AsRef<Path>,
    commit_message: &str,
) -> Result<Vec<Trailer>, GitError> {
    let repository = repository.as_ref();

    let output = git(
        &["interpret-trailers", "--parse"],
        repository,
        "parseTrailers",
        GitOptions::default().with_stdin(commit_message),
    )
    .await?;

    let trailers = output.stdout_lossy();
    if trailers.is_empty() {
        // Skips the config lookup in the common case of a message with no trailers.
        return Ok(Vec::new());
    }

    let separators = get_trailer_separator_characters(repository).await?;
    Ok(parse_raw_unfolded_trailers(&trailers, &separators))
}

/// Merges trailers into a commit message.
///
/// With no trailers this still normalizes any already present, according to the repository's
/// trailer configuration — which may be set to keep or discard duplicates.
pub async fn merge_trailers(
    repository: impl AsRef<Path>,
    commit_message: &str,
    trailers: &[Trailer],
    unfold: bool,
) -> Result<String, GitError> {
    let mut args = vec!["interpret-trailers".to_owned()];

    // Without --no-divider git treats a `---` line in the message as ending the commit message,
    // and would append trailers before it. See git's Documentation/git-interpret-trailers.txt.
    args.push("--no-divider".to_owned());

    if unfold {
        args.push("--unfold".to_owned());
    }

    for trailer in trailers {
        args.push("--trailer".to_owned());
        args.push(format!("{}={}", trailer.token, trailer.value));
    }

    let output = git(
        &args,
        repository,
        "mergeTrailers",
        GitOptions::default().with_stdin(commit_message),
    )
    .await?;

    Ok(output.stdout_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::set_config_value;
    use crate::test_support::empty_repository;

    fn trailer(token: &str, value: &str) -> Trailer {
        Trailer {
            token: token.to_owned(),
            value: value.to_owned(),
        }
    }

    // --- pure parsing ---

    #[test]
    fn parses_a_simple_trailer() {
        assert_eq!(
            parse_single_unfolded_trailer("Co-Authored-By: Jane <jane@example.com>", ":"),
            Some(trailer("Co-Authored-By", "Jane <jane@example.com>"))
        );
    }

    #[test]
    fn trims_whitespace_around_token_and_value() {
        assert_eq!(
            parse_single_unfolded_trailer("  Token  :   value  ", ":"),
            Some(trailer("Token", "value"))
        );
    }

    #[test]
    fn rejects_a_line_with_no_separator() {
        assert_eq!(parse_single_unfolded_trailer("not a trailer", ":"), None);
    }

    #[test]
    fn rejects_a_line_whose_separator_is_first() {
        // A separator at index 0 would mean an empty token, so it isn't a trailer.
        assert_eq!(parse_single_unfolded_trailer(": value", ":"), None);
    }

    #[test]
    fn honours_alternative_separators() {
        // `trailer.separators` can be configured; any listed character may separate.
        assert_eq!(
            parse_single_unfolded_trailer("Token=value", ":="),
            Some(trailer("Token", "value"))
        );
        assert_eq!(
            parse_single_unfolded_trailer("Token#value", ":=#"),
            Some(trailer("Token", "value"))
        );
    }

    #[test]
    fn splits_on_the_first_separator_only() {
        // A value may itself contain the separator, e.g. a URL after "Link:".
        assert_eq!(
            parse_single_unfolded_trailer("Link: https://example.com/x", ":"),
            Some(trailer("Link", "https://example.com/x"))
        );
    }

    #[test]
    fn handles_a_multi_byte_separator_character() {
        // The original advanced by one UTF-16 unit; slicing by byte index here would panic or
        // corrupt the value if the separator weren't handled by its UTF-8 length.
        assert_eq!(
            parse_single_unfolded_trailer("Token→value", "→"),
            Some(trailer("Token", "value"))
        );
    }

    #[test]
    fn parses_several_lines_and_skips_non_trailers() {
        let parsed = parse_raw_unfolded_trailers(
            "Co-Authored-By: Jane <jane@example.com>\nnot a trailer\nSigned-off-by: Bob <bob@example.com>",
            ":",
        );
        assert_eq!(
            parsed,
            vec![
                trailer("Co-Authored-By", "Jane <jane@example.com>"),
                trailer("Signed-off-by", "Bob <bob@example.com>"),
            ]
        );
    }

    #[test]
    fn parses_empty_input_as_no_trailers() {
        assert!(parse_raw_unfolded_trailers("", ":").is_empty());
    }

    #[test]
    fn recognizes_co_authored_by_in_any_casing() {
        assert!(trailer("Co-Authored-By", "x").is_co_authored_by());
        assert!(trailer("co-authored-by", "x").is_co_authored_by());
        assert!(trailer("CO-AUTHORED-BY", "x").is_co_authored_by());
        assert!(!trailer("Signed-off-by", "x").is_co_authored_by());
    }

    // --- against real git ---

    #[tokio::test]
    async fn defaults_the_separator_to_a_colon() {
        let repo = empty_repository().await;
        assert_eq!(
            get_trailer_separator_characters(repo.path())
                .await
                .expect("should succeed"),
            ":"
        );
    }

    #[tokio::test]
    async fn reads_configured_separators() {
        let repo = empty_repository().await;
        set_config_value(repo.path(), "trailer.separators", ":=")
            .await
            .expect("setting config should succeed");

        assert_eq!(
            get_trailer_separator_characters(repo.path())
                .await
                .expect("should succeed"),
            ":="
        );
    }

    #[tokio::test]
    async fn parses_trailers_from_a_commit_message() {
        let repo = empty_repository().await;
        let message =
            "Do the thing\n\nA body paragraph.\n\nCo-Authored-By: Jane <jane@example.com>\n";

        let trailers = parse_trailers(repo.path(), message)
            .await
            .expect("should succeed");

        assert_eq!(
            trailers,
            vec![trailer("Co-Authored-By", "Jane <jane@example.com>")]
        );
    }

    #[tokio::test]
    async fn reports_no_trailers_for_a_message_without_any() {
        let repo = empty_repository().await;
        let trailers = parse_trailers(repo.path(), "Just a subject line\n")
            .await
            .expect("should succeed");
        assert!(trailers.is_empty(), "got {trailers:?}");
    }

    #[tokio::test]
    async fn merges_a_trailer_into_a_message() {
        let repo = empty_repository().await;
        let merged = merge_trailers(
            repo.path(),
            "Do the thing\n",
            &[trailer("Co-Authored-By", "Jane <jane@example.com>")],
            false,
        )
        .await
        .expect("should succeed");

        assert!(merged.starts_with("Do the thing"), "got {merged:?}");
        assert!(
            merged.contains("Co-Authored-By: Jane <jane@example.com>"),
            "got {merged:?}"
        );
    }

    #[tokio::test]
    async fn merging_no_trailers_still_normalizes_the_message() {
        let repo = empty_repository().await;
        let merged = merge_trailers(repo.path(), "Do the thing\n", &[], false)
            .await
            .expect("should succeed");
        assert!(merged.contains("Do the thing"), "got {merged:?}");
    }

    #[tokio::test]
    async fn keeps_trailers_after_a_divider_line() {
        // The reason for --no-divider: without it git treats `---` as ending the commit message and
        // would insert trailers before it rather than at the end.
        let repo = empty_repository().await;
        let merged = merge_trailers(
            repo.path(),
            "Do the thing\n\n---\nnotes below the divider\n",
            &[trailer("Co-Authored-By", "Jane <jane@example.com>")],
            false,
        )
        .await
        .expect("should succeed");

        let trailer_at = merged
            .find("Co-Authored-By")
            .expect("the trailer should be present");
        let divider_at = merged.find("---").expect("the divider should be preserved");
        assert!(
            trailer_at > divider_at,
            "the trailer should land after the divider, got {merged:?}"
        );
    }

    #[tokio::test]
    async fn round_trips_a_merged_trailer_back_out() {
        let repo = empty_repository().await;
        let merged = merge_trailers(
            repo.path(),
            "Do the thing\n",
            &[trailer("Co-Authored-By", "Jane <jane@example.com>")],
            false,
        )
        .await
        .expect("merge should succeed");

        let parsed = parse_trailers(repo.path(), &merged)
            .await
            .expect("parse should succeed");
        assert_eq!(
            parsed,
            vec![trailer("Co-Authored-By", "Jane <jane@example.com>")]
        );
    }
}
