//! Reading history.
//!
//! Ported from `desktop-plus/app/src/lib/git/log.ts`.
//!
//! # The frontend hydrates
//!
//! `Commit`, `CommitIdentity` and `CommittedFileChange` are TypeScript **classes**, and their
//! constructors derive fields — `Commit` computes `coAuthors`, `bodyNoCoAuthors`,
//! `authoredByCommitter` and `isMergeCommit`; `CommittedFileChange` computes `id`. The types here
//! therefore carry the *constructor arguments*, and `src/lib/log-ipc.ts` builds the objects, exactly
//! as the diff types do. Deriving those fields in Rust would duplicate frontend logic and produce a
//! second definition of each — the thing `AGENTS.md` forbids.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::exec::{git, GitOptions};
use crate::git_delimiter_parser::LogParser;
use crate::interpret_trailers::{parse_raw_unfolded_trailers, Trailer};
use crate::status::AppFileStatus;
use crate::status_parser::SubmoduleStatus;

/// git's file mode for a submodule (a gitlink).
///
/// See <https://github.com/git/git/blob/v2.37.3/cache.h#L62-L69>.
const SUBMODULE_FILE_MODE: &str = "160000";

/// How much of a commit's summary and body to keep, in bytes.
///
/// The original sliced the raw buffer at this length before decoding it. A commit message has no
/// size limit, and a pathological one would otherwise be sent over IPC in full.
const MAX_MESSAGE_BYTES: usize = 100 * 1024;

/// Name, email and timestamp for a commit's author or committer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
    /// Seconds since the Unix epoch.
    ///
    /// Sent as a number rather than a formatted string: the TypeScript class holds a `Date`, and
    /// letting the frontend do `new Date(date * 1000)` keeps one representation of "when" on the
    /// wire instead of a string that has to be re-parsed.
    pub date: i64,
    /// Offset from UTC in minutes, positive east of Greenwich.
    ///
    /// Note this is the **opposite sign** to JavaScript's `Date.getTimezoneOffset()`. That
    /// inconsistency is the original's — `parseIdentity` produces `+120` for `+0200` while the
    /// class's default parameter uses `getTimezoneOffset()`, which gives `-120` for the same zone.
    /// Preserved because `parseIdentity` is the only path history uses, and changing the sign would
    /// silently shift every displayed timestamp.
    pub tz_offset: i32,
}

impl CommitIdentity {
    /// Parses a git ident string — `NAME <EMAIL> DATE`, as `GIT_AUTHOR_IDENT` produces.
    ///
    /// Expects a `--date=raw` timestamp: `1475670580 +0200`. `git var` strips `<` and `>` from names
    /// and emails, so the delimiters are unambiguous.
    ///
    /// See `fmt_ident` in git's `ident.c`.
    pub fn parse(identity: &str) -> Result<Self, GitError> {
        let captures = identity_pattern()
            .captures(identity)
            .ok_or_else(|| GitError::Parse {
                context: "parseIdentity".to_owned(),
                message: format!("couldn't parse identity {identity:?}"),
            })?;

        let group = |index: usize| captures.get(index).map(|m| m.as_str()).unwrap_or_default();

        let date: i64 = group(3).parse().map_err(|_| GitError::Parse {
            context: "parseIdentity".to_owned(),
            message: format!("couldn't parse identity {identity:?}, invalid date"),
        })?;

        // The raw format never uses alphanumeric zone names, and in practice always includes the
        // leading `+`, but git's docs suggest some platforms may omit it — so a missing sign is
        // treated as positive rather than rejected.
        let sign = if group(4) == "-" { -1 } else { 1 };
        let hours: i32 = group(5).parse().unwrap_or(0);
        let minutes: i32 = group(6).parse().unwrap_or(0);

        Ok(Self {
            name: group(1).to_owned(),
            email: group(2).to_owned(),
            date,
            tz_offset: (hours * 60 + minutes) * sign,
        })
    }
}

fn identity_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        // Lazy `.*?` for name and email so the first ` <` and `> ` delimit them.
        Regex::new(r"^(.*?) <(.*?)> (\d+) (\+|-)?(\d{2})(\d{2})").expect("pattern is valid")
    })
}

/// A commit, as the constructor arguments of the TypeScript `Commit` class.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    /// The first line of the message.
    pub summary: String,
    /// The message after the first line.
    pub body: String,
    pub author: CommitIdentity,
    pub committer: CommitIdentity,
    #[serde(rename = "parentSHAs")]
    pub parent_shas: Vec<String>,
    pub trailers: Vec<Trailer>,
    pub tags: Vec<String>,
}

/// A file changed by a commit, as the constructor arguments of `CommittedFileChange`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedFileChange {
    pub path: String,
    pub status: AppFileStatus,
    /// The commit this change belongs to.
    pub commitish: String,
    /// What it was compared against — normally `<sha>^`.
    pub parent_commitish: String,
}

/// What changed in a commit, and by how much.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesetData {
    pub files: Vec<CommittedFileChange>,
    pub lines_added: u64,
    pub lines_deleted: u64,
}

/// The `--format` fields `get_commits` requests, in order.
///
/// `%(trailers:unfold,only)` is why the trailer separator below is hard-coded to `:` — git documents
/// that form as always using `": "` between key and value.
fn commit_format_fields() -> [&'static str; 9] {
    [
        "%H",                      // sha
        "%h",                      // short sha
        "%s",                      // summary
        "%b",                      // body
        "%an <%ae> %ad",           // author identity, as GIT_AUTHOR_IDENT
        "%cn <%ce> %cd",           // committer identity
        "%P",                      // parent shas, space separated
        "%(trailers:unfold,only)", // trailers
        "%D",                      // ref names
    ]
}

/// Truncates to at most `limit` bytes without splitting a character.
fn truncate_bytes(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }

    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// Extracts tag names from `%D`.
///
/// The field looks like
/// `HEAD -> main, tag: some-tag, tag: other,with-a-comma, origin/main`. Splitting on `", "` rather
/// than `,` is deliberate and the original called it out: a tag name may itself contain a comma, and
/// the obvious `/tag: ([^\s,]+)/g` would clip such a tag short.
fn parse_tags(refs: &str) -> Vec<String> {
    refs.split(", ")
        .filter_map(|reference| reference.strip_prefix("tag: "))
        .map(str::to_owned)
        .collect()
}

/// Reads commits, most recent first.
///
/// `revision_range` is passed to `git log` as-is; `None` means the current branch. An **unborn HEAD**
/// yields an empty list rather than an error, because `git log` exits 128 on a repository with no
/// commits and that is a normal state for a fresh repository.
pub async fn get_commits(
    repository: impl AsRef<Path>,
    revision_range: Option<&str>,
    limit: Option<u32>,
    skip: Option<u32>,
    additional_args: &[String],
) -> Result<Vec<Commit>, GitError> {
    let fields = commit_format_fields();
    let parser = LogParser::new(&fields);

    let mut args = vec!["log".to_owned()];

    if let Some(range) = revision_range {
        args.push(range.to_owned());
    }

    args.push("--date=raw".to_owned());

    if let Some(limit) = limit {
        args.push(format!("--max-count={limit}"));
    }
    if let Some(skip) = skip {
        args.push(format!("--skip={skip}"));
    }

    args.extend(parser.format_args());
    // `--no-show-signature` because signature verification would both slow this down and add output
    // the format doesn't account for.
    args.push("--no-show-signature".to_owned());
    args.push("--no-color".to_owned());
    args.extend(additional_args.iter().cloned());
    args.push("--".to_owned());

    let output = git(
        &args,
        repository,
        "getCommits",
        GitOptions::default().with_success_exit_codes([128]),
    )
    .await?;

    if output.exit_code == 128 {
        return Ok(Vec::new());
    }

    let stdout = output.stdout_lossy();
    let mut commits = Vec::new();

    for record in parser.parse(&stdout) {
        let [sha, short_sha, summary, body, author, committer, parents, trailers, refs] =
            <[String; 9]>::try_from(record).map_err(|record| GitError::Parse {
                context: "getCommits".to_owned(),
                message: format!("expected 9 fields per commit, got {}", record.len()),
            })?;

        commits.push(Commit {
            sha,
            short_sha,
            summary: truncate_bytes(&summary, MAX_MESSAGE_BYTES),
            body: truncate_bytes(&body, MAX_MESSAGE_BYTES),
            author: CommitIdentity::parse(&author)?,
            committer: CommitIdentity::parse(&committer)?,
            parent_shas: if parents.is_empty() {
                Vec::new()
            } else {
                parents.split(' ').map(str::to_owned).collect()
            },
            trailers: parse_raw_unfolded_trailers(&trailers, ":"),
            tags: parse_tags(&refs),
        });
    }

    Ok(commits)
}

/// Reads a single commit, or `None` if `reference` doesn't resolve to one.
pub async fn get_commit(
    repository: impl AsRef<Path>,
    reference: &str,
) -> Result<Option<Commit>, GitError> {
    let commits = get_commits(repository, Some(reference), Some(1), None, &[]).await?;
    Ok(commits.into_iter().next())
}

/// Reads the files a commit changed, with its line counts.
pub async fn get_changed_files(
    repository: impl AsRef<Path>,
    sha: &str,
) -> Result<ChangesetData, GitError> {
    // `-C` before `-M` is load-bearing, and the original said so: reversing them means copies are
    // never detected. Together they're equivalent to setting `diff.renames = copies`.
    let args = [
        "log",
        sha,
        "-C",
        "-M",
        // `-m -1 --first-parent` so a merge commit is diffed against its first parent rather than
        // producing one diff per parent.
        "-m",
        "-1",
        "--no-show-signature",
        "--first-parent",
        "--raw",
        "--format=format:",
        "--numstat",
        "-z",
        "--",
    ];

    let output = git(&args, repository, "getChangedFiles", GitOptions::default()).await?;

    parse_raw_log_with_numstat(&output.stdout_lossy(), sha, &format!("{sha}^"))
}

/// Parses the combined output of `--raw --numstat -z`.
///
/// The two are interleaved: a run of `:`-prefixed raw records, then a run of numstat records. With
/// `-z` every field is NUL-separated, and how many fields a record occupies depends on whether it is
/// a rename or copy:
///
/// ```text
/// :100644 100644 5716ca5 db3c77d M    NUL path            NUL   <- ordinary: mode info, then path
/// :100644 100644 5716ca5 db3c77d R100 NUL old NUL new     NUL   <- rename: two paths
/// 1  0  path                          NUL                       <- ordinary numstat
/// 1  0                                NUL old NUL new     NUL   <- rename numstat: paths split out
/// ```
///
/// The numstat pass therefore has to know which entries were renames in order to skip their extra
/// fields, which is why it walks `files` in parallel rather than being independent.
pub fn parse_raw_log_with_numstat(
    stdout: &str,
    sha: &str,
    parent_commitish: &str,
) -> Result<ChangesetData, GitError> {
    let parse_error = |message: String| GitError::Parse {
        context: "parseRawLogWithNumstat".to_owned(),
        message,
    };

    let lines: Vec<&str> = stdout.split('\0').collect();
    let mut files: Vec<CommittedFileChange> = Vec::new();
    let mut lines_added: u64 = 0;
    let mut lines_deleted: u64 = 0;
    let mut num_stat_count = 0usize;

    // The final field is the empty string after the trailing NUL, so it is skipped.
    let last = lines.len().saturating_sub(1);
    let mut index = 0;

    while index < last {
        let line = lines[index];

        if let Some(record) = line.strip_prefix(':') {
            let components: Vec<&str> = record.split(' ').collect();

            let src_mode = components
                .first()
                .ok_or_else(|| parse_error("invalid log output (srcMode)".to_owned()))?;
            let dst_mode = components
                .get(1)
                .ok_or_else(|| parse_error("invalid log output (dstMode)".to_owned()))?;
            let status = components
                .last()
                .ok_or_else(|| parse_error("invalid log output (status)".to_owned()))?;

            // A rename or copy puts the source path in its own field before the destination.
            //
            // The original tested `/^R|C/`, which by regex precedence means "starts with R, or
            // contains C anywhere". For git's actual raw statuses — M, A, D, T, U, X, R<score>,
            // C<score> — that coincides with "starts with R or C", which is what this checks.
            let old_path = if status.starts_with('R') || status.starts_with('C') {
                index += 1;
                Some(
                    (*lines
                        .get(index)
                        .ok_or_else(|| parse_error("missing old path".to_owned()))?)
                    .to_owned(),
                )
            } else {
                None
            };

            index += 1;
            let path = lines
                .get(index)
                .ok_or_else(|| parse_error("missing path".to_owned()))?;

            files.push(CommittedFileChange {
                path: (*path).to_owned(),
                status: map_log_status(status, old_path.as_deref(), src_mode, dst_mode),
                commitish: sha.to_owned(),
                parent_commitish: parent_commitish.to_owned(),
            });
        } else {
            let (added, deleted) = parse_numstat(line)
                .ok_or_else(|| parse_error(format!("invalid numstat line: {line:?}")))?;
            lines_added += added;
            lines_deleted += deleted;

            let status = files
                .get(num_stat_count)
                .map(|file| &file.status)
                .ok_or_else(|| {
                    parse_error(format!(
                        "numstat record {num_stat_count} has no matching raw record"
                    ))
                })?;

            // A rename or copy's numstat entry is followed by its two paths as separate fields.
            if matches!(
                status,
                AppFileStatus::Renamed { .. } | AppFileStatus::Copied { .. }
            ) {
                index += 2;
            }

            num_stat_count += 1;
        }

        index += 1;
    }

    Ok(ChangesetData {
        files,
        lines_added,
        lines_deleted,
    })
}

/// Parses a numstat record's counts.
///
/// `-` means "not applicable" — git uses it for binary files — and counts as zero. The trailing tab
/// is required: it is what separates the counts from the path (or, for a rename, from nothing).
fn parse_numstat(line: &str) -> Option<(u64, u64)> {
    let mut parts = line.splitn(3, '\t');
    let added = parts.next()?;
    let deleted = parts.next()?;
    // Ensures the second tab was present.
    parts.next()?;

    let count = |value: &str| -> Option<u64> {
        if value == "-" {
            Some(0)
        } else {
            value.parse().ok()
        }
    };

    Some((count(added)?, count(deleted)?))
}

/// Recognizes a submodule change from its file modes.
///
/// A gitlink on both sides with status `M` means the submodule points at a different commit. A
/// gitlink appearing or disappearing is an add or delete of the submodule itself, which is not a
/// commit change within it.
fn map_submodule_status_file_modes(
    status: &str,
    src_mode: &str,
    dst_mode: &str,
) -> Option<SubmoduleStatus> {
    if src_mode == SUBMODULE_FILE_MODE && dst_mode == SUBMODULE_FILE_MODE && status == "M" {
        return Some(SubmoduleStatus {
            commit_changed: true,
            untracked_changes: false,
            modified_changes: false,
        });
    }

    if (src_mode == SUBMODULE_FILE_MODE && status == "D")
        || (dst_mode == SUBMODULE_FILE_MODE && status == "A")
    {
        return Some(SubmoduleStatus {
            commit_changed: false,
            untracked_changes: false,
            modified_changes: false,
        });
    }

    None
}

/// Interprets a raw-log status letter.
///
/// Distinct from [`crate::status_parser::map_status`], which decodes porcelain v2's two-character
/// codes. This one handles `git log --raw`'s single letter plus optional similarity score.
///
/// An unrecognized status falls back to `Modified`, as the original did — a status we don't know
/// shouldn't drop the file from the changeset.
fn map_log_status(
    raw_status: &str,
    old_path: Option<&str>,
    src_mode: &str,
    dst_mode: &str,
) -> AppFileStatus {
    let status = raw_status.trim();
    let submodule_status = map_submodule_status_file_modes(status, src_mode, dst_mode);

    match status {
        "M" => {
            return AppFileStatus::Modified { submodule_status };
        }
        "A" => {
            return AppFileStatus::New { submodule_status };
        }
        "?" => {
            return AppFileStatus::Untracked { submodule_status };
        }
        "D" => {
            return AppFileStatus::Deleted { submodule_status };
        }
        _ => {}
    }

    if let Some(old_path) = old_path {
        // A bare `R`/`C` carries no score, so there is nothing to infer modifications from.
        if status == "R" {
            return AppFileStatus::Renamed {
                old_path: old_path.to_owned(),
                submodule_status,
                rename_includes_modifications: false,
            };
        }
        if status == "C" {
            return AppFileStatus::Copied {
                old_path: old_path.to_owned(),
                submodule_status,
                // The original hard-codes false for copies.
                rename_includes_modifications: false,
            };
        }

        // `-M`/`-C` produce a similarity score: `R100` is a pure rename, anything less means the
        // content changed as well.
        if let Some(score) = status.strip_prefix('R') {
            if !score.is_empty() && score.chars().all(|c| c.is_ascii_digit()) {
                return AppFileStatus::Renamed {
                    old_path: old_path.to_owned(),
                    submodule_status,
                    rename_includes_modifications: status != "R100",
                };
            }
        }
        if let Some(score) = status.strip_prefix('C') {
            if !score.is_empty() && score.chars().all(|c| c.is_ascii_digit()) {
                return AppFileStatus::Copied {
                    old_path: old_path.to_owned(),
                    submodule_status,
                    rename_includes_modifications: false,
                };
            }
        }
    }

    AppFileStatus::Modified { submodule_status }
}

/// Reads the author identity of each of `shas`, in the order given.
///
/// `--no-walk=unsorted` keeps git from reordering, and the shas go over stdin so the argument list
/// can't overflow. Errors if git returns a different number of identities than shas were asked for,
/// which happens when the input contains duplicates — git answers once per distinct commit, so the
/// result would silently misalign with the caller's list.
pub async fn get_authors(
    repository: impl AsRef<Path>,
    shas: &[String],
) -> Result<Vec<CommitIdentity>, GitError> {
    if shas.is_empty() {
        return Ok(Vec::new());
    }

    let output = git(
        &[
            "log",
            "--format=format:%an <%ae> %ad",
            "--no-walk=unsorted",
            "--date=raw",
            "-z",
            "--stdin",
        ],
        repository,
        "getAuthors",
        GitOptions::default().with_stdin(shas.join("\n")),
    )
    .await?;

    let stdout = output.stdout_lossy();
    // `format:` rather than `tformat:` means records are NUL-*separated*, not terminated, so there
    // is no trailing empty field to drop here — unlike the raw/numstat output above.
    let authors = stdout
        .split('\0')
        .map(CommitIdentity::parse)
        .collect::<Result<Vec<_>, _>>()?;

    if authors.len() != shas.len() {
        return Err(GitError::Parse {
            context: "getAuthors".to_owned(),
            message: format!(
                "expected {} authors for {} commits; duplicate shas in the input would cause this",
                shas.len(),
                authors.len()
            ),
        });
    }

    Ok(authors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_file, empty_repository};

    // --- identity parsing ---

    #[test]
    fn parses_an_identity() {
        let identity =
            CommitIdentity::parse("Markus Olsson <j.markus.olsson@gmail.com> 1475670580 +0200")
                .expect("should parse");

        assert_eq!(identity.name, "Markus Olsson");
        assert_eq!(identity.email, "j.markus.olsson@gmail.com");
        assert_eq!(identity.date, 1_475_670_580);
        assert_eq!(identity.tz_offset, 120);
    }

    #[test]
    fn parses_a_negative_timezone_offset() {
        let identity =
            CommitIdentity::parse("Someone <a@b.c> 1475670580 -0730").expect("should parse");
        assert_eq!(identity.tz_offset, -(7 * 60 + 30));
    }

    #[test]
    fn treats_a_missing_timezone_sign_as_positive() {
        // git's docs suggest the leading `+` may be omitted on some platforms.
        let identity =
            CommitIdentity::parse("Someone <a@b.c> 1475670580 0200").expect("should parse");
        assert_eq!(identity.tz_offset, 120);
    }

    #[test]
    fn parses_an_identity_with_an_empty_name() {
        let identity = CommitIdentity::parse(" <a@b.c> 1475670580 +0000").expect("should parse");
        assert_eq!(identity.name, "");
        assert_eq!(identity.tz_offset, 0);
    }

    #[test]
    fn rejects_a_malformed_identity() {
        for value in [
            "no angle brackets here",
            "Someone <a@b.c>",
            "Someone <a@b.c> notadate +0000",
            "",
        ] {
            assert!(
                matches!(CommitIdentity::parse(value), Err(GitError::Parse { .. })),
                "{value:?} should not parse"
            );
        }
    }

    // --- tags ---

    #[test]
    fn extracts_tags_and_ignores_other_refs() {
        let tags = parse_tags("HEAD -> main, tag: v1.0, origin/main, origin/HEAD");
        assert_eq!(tags, vec!["v1.0".to_owned()]);
    }

    #[test]
    fn keeps_a_tag_name_containing_a_comma() {
        // Splitting on ", " rather than "," is what makes this work; the original called it out.
        let tags = parse_tags("tag: some-tag, tag: other,with-a-comma, origin/main");
        assert_eq!(
            tags,
            vec!["some-tag".to_owned(), "other,with-a-comma".to_owned()]
        );
    }

    #[test]
    fn a_commit_with_no_refs_has_no_tags() {
        assert!(parse_tags("").is_empty());
    }

    // --- log status mapping ---

    #[test]
    fn maps_the_plain_statuses() {
        assert!(matches!(
            map_log_status("M", None, "100644", "100644"),
            AppFileStatus::Modified { .. }
        ));
        assert!(matches!(
            map_log_status("A", None, "000000", "100644"),
            AppFileStatus::New { .. }
        ));
        assert!(matches!(
            map_log_status("D", None, "100644", "000000"),
            AppFileStatus::Deleted { .. }
        ));
        assert!(matches!(
            map_log_status("?", None, "100644", "100644"),
            AppFileStatus::Untracked { .. }
        ));
    }

    #[test]
    fn maps_a_scored_rename_and_notes_whether_content_changed() {
        match map_log_status("R100", Some("before"), "100644", "100644") {
            AppFileStatus::Renamed {
                old_path,
                rename_includes_modifications,
                ..
            } => {
                assert_eq!(old_path, "before");
                assert!(!rename_includes_modifications, "R100 is a pure rename");
            }
            other => panic!("expected Renamed, got {other:?}"),
        }

        match map_log_status("R87", Some("before"), "100644", "100644") {
            AppFileStatus::Renamed {
                rename_includes_modifications,
                ..
            } => assert!(
                rename_includes_modifications,
                "a score below 100 means the content changed too"
            ),
            other => panic!("expected Renamed, got {other:?}"),
        }
    }

    #[test]
    fn maps_a_scored_copy() {
        assert!(matches!(
            map_log_status("C75", Some("source"), "100644", "100644"),
            AppFileStatus::Copied { .. }
        ));
    }

    #[test]
    fn a_rename_without_an_old_path_falls_back_to_modified() {
        // The original's guards all required `oldPath != null` and fell through otherwise.
        assert!(matches!(
            map_log_status("R100", None, "100644", "100644"),
            AppFileStatus::Modified { .. }
        ));
    }

    #[test]
    fn an_unrecognized_status_falls_back_to_modified() {
        assert!(matches!(
            map_log_status("T", None, "100644", "120000"),
            AppFileStatus::Modified { .. }
        ));
    }

    #[test]
    fn recognizes_a_submodule_commit_change() {
        match map_log_status("M", None, SUBMODULE_FILE_MODE, SUBMODULE_FILE_MODE) {
            AppFileStatus::Modified {
                submodule_status: Some(submodule),
            } => assert!(submodule.commit_changed),
            other => panic!("expected a submodule change, got {other:?}"),
        }
    }

    #[test]
    fn an_added_or_removed_submodule_is_not_a_commit_change() {
        match map_log_status("A", None, "000000", SUBMODULE_FILE_MODE) {
            AppFileStatus::New {
                submodule_status: Some(submodule),
            } => assert!(!submodule.commit_changed),
            other => panic!("expected a submodule add, got {other:?}"),
        }

        match map_log_status("D", None, SUBMODULE_FILE_MODE, "000000") {
            AppFileStatus::Deleted {
                submodule_status: Some(submodule),
            } => assert!(!submodule.commit_changed),
            other => panic!("expected a submodule delete, got {other:?}"),
        }
    }

    #[test]
    fn an_ordinary_file_has_no_submodule_status() {
        assert!(matches!(
            map_log_status("M", None, "100644", "100644"),
            AppFileStatus::Modified {
                submodule_status: None
            }
        ));
    }

    // --- numstat ---

    #[test]
    fn parses_numstat_counts() {
        assert_eq!(parse_numstat("1\t2\tpath"), Some((1, 2)));
        assert_eq!(parse_numstat("10\t0\t"), Some((10, 0)));
    }

    #[test]
    fn treats_a_dash_count_as_zero() {
        // git uses `-` for binary files, which have no line counts.
        assert_eq!(parse_numstat("-\t-\tbinary"), Some((0, 0)));
    }

    #[test]
    fn rejects_a_numstat_line_without_both_tabs() {
        assert_eq!(parse_numstat("1\t2"), None);
        assert_eq!(parse_numstat("nonsense"), None);
    }

    // --- the combined raw + numstat parse ---

    #[test]
    fn parses_ordinary_changes() {
        let stdout = concat!(
            ":100644 100644 5716ca5 db3c77d M\0one\0",
            ":100644 100644 0835e4f 28096ea M\0two\0",
            "1\t0\tone\0",
            "2\t3\ttwo\0",
        );

        let changeset = parse_raw_log_with_numstat(stdout, "abc", "abc^").expect("should parse");

        assert_eq!(changeset.files.len(), 2);
        assert_eq!(changeset.files[0].path, "one");
        assert_eq!(changeset.files[1].path, "two");
        assert_eq!(changeset.lines_added, 3);
        assert_eq!(changeset.lines_deleted, 3);
        assert_eq!(changeset.files[0].commitish, "abc");
        assert_eq!(changeset.files[0].parent_commitish, "abc^");
    }

    #[test]
    fn parses_a_rename_whose_numstat_carries_its_paths_separately() {
        // The case the whole interleaved walk exists for: a rename occupies three fields in the raw
        // section and three in the numstat section, so the numstat pass must skip two extra fields.
        let stdout = concat!(
            ":100644 100644 5716ca5 db3c77d R100\0before\0after\0",
            ":100644 100644 0835e4f 28096ea M\0other\0",
            "0\t0\t\0before\0after\0",
            "5\t1\tother\0",
        );

        let changeset = parse_raw_log_with_numstat(stdout, "abc", "abc^").expect("should parse");

        assert_eq!(changeset.files.len(), 2);
        match &changeset.files[0].status {
            AppFileStatus::Renamed { old_path, .. } => assert_eq!(old_path, "before"),
            other => panic!("expected Renamed, got {other:?}"),
        }
        assert_eq!(changeset.files[0].path, "after");
        assert_eq!(
            changeset.files[1].path, "other",
            "the entry after a rename must not be misaligned"
        );
        assert_eq!(changeset.lines_added, 5);
        assert_eq!(changeset.lines_deleted, 1);
    }

    #[test]
    fn parses_an_empty_changeset() {
        let changeset = parse_raw_log_with_numstat("", "abc", "abc^").expect("should parse");
        assert_eq!(changeset, ChangesetData::default());
    }

    #[test]
    fn rejects_a_numstat_record_with_no_matching_raw_record() {
        let stdout = "1\t0\tstray\0";
        assert!(matches!(
            parse_raw_log_with_numstat(stdout, "abc", "abc^"),
            Err(GitError::Parse { .. })
        ));
    }

    #[test]
    fn rejects_a_rename_that_runs_off_the_end_of_the_output() {
        // Truncated after the raw record, so there is no field left to read the destination from.
        let stdout = ":100644 100644 5716ca5 db3c77d R100\0";
        assert!(matches!(
            parse_raw_log_with_numstat(stdout, "abc", "abc^"),
            Err(GitError::Parse { .. })
        ));
    }

    #[test]
    fn a_rename_missing_only_its_destination_yields_an_empty_path() {
        // Not an error, and worth pinning because it looks like one should be raised. `-z` output
        // ends with a trailing NUL, so the empty field after it is a real element: a rename missing
        // just its destination reads that empty string as the path. The original behaved identically
        // — its `forceUnwrap` saw `""`, not `undefined`. Left as-is rather than "fixed", because git
        // does not produce this and inventing a stricter rule risks rejecting output it does produce.
        let stdout = ":100644 100644 5716ca5 db3c77d R100\0before\0";
        let changeset = parse_raw_log_with_numstat(stdout, "abc", "abc^").expect("does not error");

        assert_eq!(changeset.files.len(), 1);
        assert_eq!(changeset.files[0].path, "");
        match &changeset.files[0].status {
            AppFileStatus::Renamed { old_path, .. } => assert_eq!(old_path, "before"),
            other => panic!("expected Renamed, got {other:?}"),
        }
    }

    // --- against real repositories ---

    #[tokio::test]
    async fn reads_commits_in_reverse_chronological_order() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "one\n", "first");
        commit_file(&repo.path(), "foo", "two\n", "second");

        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("log should succeed");

        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].summary, "second");
        assert_eq!(commits[1].summary, "first");
        assert_eq!(commits[0].sha.len(), 40);
        assert!(!commits[0].short_sha.is_empty());
        assert!(commits[0].short_sha.len() < commits[0].sha.len());
    }

    #[tokio::test]
    async fn returns_no_commits_for_an_unborn_head() {
        // `git log` exits 128 here, which is a normal state rather than a failure.
        let repo = empty_repository().await;
        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("an unborn HEAD is not an error");
        assert!(commits.is_empty());
    }

    #[tokio::test]
    async fn honours_limit_and_skip() {
        let repo = empty_repository().await;
        for message in ["first", "second", "third"] {
            commit_file(&repo.path(), "foo", &format!("{message}\n"), message);
        }

        let limited = get_commits(repo.path(), None, Some(1), None, &[])
            .await
            .expect("log should succeed");
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].summary, "third");

        let skipped = get_commits(repo.path(), None, Some(1), Some(1), &[])
            .await
            .expect("log should succeed");
        assert_eq!(skipped[0].summary, "second");
    }

    #[tokio::test]
    async fn separates_the_summary_from_the_body() {
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("foo"), "contents\n").expect("failed to write");
        git(
            &["add", "--", "foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("a summary\n\nthe body\nsecond line\n"),
        )
        .await
        .expect("commit should succeed");

        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("log should succeed");

        assert_eq!(commits[0].summary, "a summary");
        assert!(
            commits[0].body.starts_with("the body"),
            "got {:?}",
            commits[0].body
        );
    }

    #[tokio::test]
    async fn reads_the_author_and_committer() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("log should succeed");
        let commit = &commits[0];

        assert!(!commit.author.name.is_empty());
        assert!(commit.author.email.contains('@'));
        assert!(commit.author.date > 0);
        assert_eq!(commit.author.name, commit.committer.name);
    }

    #[tokio::test]
    async fn reports_parents_and_tags() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "one\n", "first");
        commit_file(&repo.path(), "foo", "two\n", "second");
        git(&["tag", "v1.0"], repo.path(), "test", GitOptions::default())
            .await
            .expect("tag should succeed");

        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("log should succeed");

        assert_eq!(commits[0].tags, vec!["v1.0".to_owned()]);
        assert_eq!(commits[0].parent_shas.len(), 1);
        assert_eq!(commits[0].parent_shas[0], commits[1].sha);
        assert!(
            commits[1].parent_shas.is_empty(),
            "a root commit has no parents"
        );
    }

    #[tokio::test]
    async fn parses_trailers_from_the_commit_body() {
        let repo = empty_repository().await;
        std::fs::write(repo.path().join("foo"), "contents\n").expect("failed to write");
        git(
            &["add", "--", "foo"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("add should succeed");
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default()
                .with_stdin("summary\n\nCo-Authored-By: Someone <someone@example.com>\n"),
        )
        .await
        .expect("commit should succeed");

        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("log should succeed");

        let trailers = &commits[0].trailers;
        assert_eq!(trailers.len(), 1, "got {trailers:?}");
        assert_eq!(trailers[0].token, "Co-Authored-By");
        assert_eq!(trailers[0].value, "Someone <someone@example.com>");
    }

    #[tokio::test]
    async fn reads_a_single_commit_by_reference() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "contents\n", "first");

        let commit = get_commit(repo.path(), "HEAD")
            .await
            .expect("log should succeed")
            .expect("HEAD should resolve");
        assert_eq!(commit.summary, "first");
    }

    #[tokio::test]
    async fn reads_no_commit_for_an_unborn_head() {
        let repo = empty_repository().await;
        assert_eq!(
            get_commit(repo.path(), "HEAD")
                .await
                .expect("an unborn HEAD is not an error"),
            None
        );
    }

    #[tokio::test]
    async fn reads_the_files_a_commit_changed() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "kept", "one\n", "first");
        std::fs::write(repo.path().join("kept"), "one\ntwo\n").expect("failed to write");
        std::fs::write(repo.path().join("added"), "new\n").expect("failed to write");
        git(&["add", "-A"], repo.path(), "test", GitOptions::default())
            .await
            .expect("add should succeed");
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("second\n"),
        )
        .await
        .expect("commit should succeed");

        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        let changeset = get_changed_files(repo.path(), &sha)
            .await
            .expect("should succeed");

        let mut paths: Vec<&str> = changeset.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, vec!["added", "kept"]);
        assert_eq!(changeset.lines_added, 2, "one line each");
        assert_eq!(changeset.lines_deleted, 0);
    }

    #[tokio::test]
    async fn reads_a_rename_from_a_real_commit() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "before", "contents\n", "first");
        git(
            &["mv", "before", "after"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("mv should succeed");
        git(
            &["commit", "-F", "-"],
            repo.path(),
            "test",
            GitOptions::default().with_stdin("renamed\n"),
        )
        .await
        .expect("commit should succeed");

        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        let changeset = get_changed_files(repo.path(), &sha)
            .await
            .expect("should succeed");

        assert_eq!(changeset.files.len(), 1);
        assert_eq!(changeset.files[0].path, "after");
        match &changeset.files[0].status {
            AppFileStatus::Renamed { old_path, .. } => assert_eq!(old_path, "before"),
            other => panic!("expected Renamed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reads_authors_for_the_given_shas() {
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "one\n", "first");
        commit_file(&repo.path(), "foo", "two\n", "second");

        let commits = get_commits(repo.path(), None, None, None, &[])
            .await
            .expect("log should succeed");
        let shas: Vec<String> = commits.iter().map(|c| c.sha.clone()).collect();

        let authors = get_authors(repo.path(), &shas)
            .await
            .expect("should succeed");

        assert_eq!(authors.len(), 2);
        assert_eq!(authors[0].name, commits[0].author.name);
    }

    #[tokio::test]
    async fn reads_no_authors_for_no_shas() {
        let repo = empty_repository().await;
        assert!(get_authors(repo.path(), &[])
            .await
            .expect("should succeed")
            .is_empty());
    }

    #[tokio::test]
    async fn rejects_duplicate_shas_rather_than_misaligning_authors() {
        // git answers once per distinct commit, so the result would silently not line up with the
        // caller's list. The original asserted on this too.
        let repo = empty_repository().await;
        commit_file(&repo.path(), "foo", "one\n", "first");
        let sha = git(
            &["rev-parse", "HEAD"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("rev-parse should succeed")
        .stdout_trimmed();

        let error = get_authors(repo.path(), &[sha.clone(), sha])
            .await
            .expect_err("duplicates should be rejected");
        assert!(matches!(error, GitError::Parse { .. }), "got {error:?}");
    }
}
