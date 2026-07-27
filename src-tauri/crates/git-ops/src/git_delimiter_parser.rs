//! Parsing NUL-delimited `--format` output from ref-listing commands.
//!
//! Ported from `createForEachRefParser` in
//! `desktop-plus/app/src/lib/git/git-delimiter-parser.ts`.
//!
//! Two parsers, matching the original's split:
//! - [`ForEachRefParser`] for `git for-each-ref`/`git branch`, whose `--format` uses `%00` and
//!   which emits a newline between records.
//! - [`LogParser`] for `git log`-style commands (and anything else emitting a flat run of
//!   NUL-terminated fields, such as `git check-attr -z`), with no record separator.
//!
//! # How the framing works
//!
//! The format string wraps every field in NULs: `--format=%00<f1>%00<f2>%00`. `git for-each-ref`
//! and `git branch` then emit one record per ref, each followed by a literal newline. So for two
//! single-field refs the raw output is `\0main\0\n\0other\0\n`, which splits on NUL into
//! `["", "main", "\n", "other", "\n", ""]`.
//!
//! NUL-delimiting is what makes this safe: ref names may contain almost anything except NUL, so a
//! newline-delimited format could not be parsed unambiguously.

use crate::error::GitError;

/// A parser for a fixed, ordered set of `--format` fields.
#[derive(Debug, Clone)]
pub struct ForEachRefParser {
    field_formats: Vec<String>,
}

impl ForEachRefParser {
    /// Builds a parser for the given git format placeholders, e.g. `["%(objectname)", "%(refname)"]`.
    ///
    /// Field order is the order values appear in [`ForEachRefParser::parse`]'s output.
    pub fn new<S: AsRef<str>>(field_formats: &[S]) -> Self {
        Self {
            field_formats: field_formats
                .iter()
                .map(|f| f.as_ref().to_owned())
                .collect(),
        }
    }

    /// The arguments to append to the git invocation.
    pub fn format_args(&self) -> Vec<String> {
        vec![format!("--format=%00{}%00", self.field_formats.join("%00"))]
    }

    /// Number of fields per record.
    fn field_count(&self) -> usize {
        self.field_formats.len()
    }

    /// Parses stdout into one `Vec<String>` per ref, with values in field order.
    ///
    /// Returns [`GitError::Parse`] if the framing isn't what the format implies — a record
    /// separator that isn't a newline means the output and the format string disagree, and
    /// silently returning partial data would be worse than failing.
    pub fn parse(&self, stdout: &str) -> Result<Vec<Vec<String>>, GitError> {
        let fields = self.field_count();
        if fields == 0 {
            return Ok(Vec::new());
        }

        let records: Vec<&str> = stdout.split('\0').collect();
        let mut entries = Vec::new();
        let mut current: Vec<String> = Vec::with_capacity(fields);

        // Start at 1: the leading `%00` in the format guarantees an empty first record. Stop
        // before the last, which is the trailing empty record after the final `%00`.
        //
        // Every (fields + 1)th record is the newline git puts between refs, not a value.
        for (index, record) in records
            .iter()
            .enumerate()
            .take(records.len().saturating_sub(1))
            .skip(1)
        {
            if index % (fields + 1) == 0 {
                if *record != "\n" {
                    return Err(GitError::Parse {
                        context: "for-each-ref".to_owned(),
                        message: format!(
                            "expected a newline record separator at index {index}, got {record:?}"
                        ),
                    });
                }
                continue;
            }

            current.push((*record).to_owned());
            if current.len() == fields {
                entries.push(std::mem::replace(&mut current, Vec::with_capacity(fields)));
            }
        }

        Ok(entries)
    }
}

/// A parser for a flat run of NUL-terminated fields, grouped into fixed-size records.
///
/// Ported from `createLogParser`. Used for `git log --format` output and for commands like
/// `git check-attr -z`, which emit `<path>\0<attr>\0<value>\0` per file with no record separator.
#[derive(Debug, Clone)]
pub struct LogParser {
    field_formats: Vec<String>,
}

impl LogParser {
    /// Builds a parser for the given git format placeholders, e.g. `["%H", "%s"]`.
    ///
    /// Pass empty strings when parsing output that isn't produced by a `--format` (such as
    /// `check-attr`); only the field *count* matters to [`LogParser::parse`].
    pub fn new<S: AsRef<str>>(field_formats: &[S]) -> Self {
        Self {
            field_formats: field_formats
                .iter()
                .map(|f| f.as_ref().to_owned())
                .collect(),
        }
    }

    /// The arguments to append to the git invocation.
    ///
    /// Note this uses `%x00` (git's escape for a literal NUL inside `--format`), unlike
    /// [`ForEachRefParser`]'s `%00` — the two command families spell it differently.
    pub fn format_args(&self) -> Vec<String> {
        vec![
            "-z".to_owned(),
            format!("--format={}", self.field_formats.join("%x00")),
        ]
    }

    /// Groups stdout into records of `field_formats.len()` values each.
    ///
    /// A trailing partial group is ignored, which is what drops the empty string after the final
    /// NUL. Matches the original's `i < records.length - keys.length` bound.
    pub fn parse(&self, stdout: &str) -> Vec<Vec<String>> {
        let fields = self.field_formats.len();
        if fields == 0 {
            return Vec::new();
        }

        let records: Vec<&str> = stdout.split('\0').collect();
        let mut entries = Vec::new();

        let mut start = 0;
        while start + fields <= records.len().saturating_sub(1) {
            entries.push(
                records[start..start + fields]
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
            );
            start += fields;
        }

        entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_format_argument_for_a_single_field() {
        let parser = ForEachRefParser::new(&["%(refname:short)"]);
        assert_eq!(
            parser.format_args(),
            vec!["--format=%00%(refname:short)%00".to_owned()]
        );
    }

    #[test]
    fn builds_the_format_argument_for_several_fields() {
        let parser = ForEachRefParser::new(&["%(objectname)", "%(refname)"]);
        assert_eq!(
            parser.format_args(),
            vec!["--format=%00%(objectname)%00%(refname)%00".to_owned()]
        );
    }

    #[test]
    fn parses_single_field_records() {
        let parser = ForEachRefParser::new(&["%(refname:short)"]);
        let parsed = parser
            .parse("\0main\0\n\0other\0\n")
            .expect("well-formed output should parse");
        assert_eq!(parsed, vec![vec!["main"], vec!["other"]]);
    }

    #[test]
    fn parses_multi_field_records() {
        let parser = ForEachRefParser::new(&["%(objectname)", "%(refname)"]);
        let parsed = parser
            .parse("\0sha1\0refs/heads/main\0\n\0sha2\0refs/heads/other\0\n")
            .expect("well-formed output should parse");
        assert_eq!(
            parsed,
            vec![
                vec!["sha1", "refs/heads/main"],
                vec!["sha2", "refs/heads/other"]
            ]
        );
    }

    #[test]
    fn parses_empty_output_as_no_records() {
        let parser = ForEachRefParser::new(&["%(refname:short)"]);
        assert_eq!(
            parser.parse("").expect("empty output should parse"),
            Vec::<Vec<String>>::new()
        );
    }

    #[test]
    fn preserves_values_containing_newlines() {
        // The reason for NUL framing: a value may itself contain a newline, which a
        // newline-delimited format could not represent.
        let parser = ForEachRefParser::new(&["%(contents)"]);
        let parsed = parser
            .parse("\0line1\nline2\0\n")
            .expect("well-formed output should parse");
        assert_eq!(parsed, vec![vec!["line1\nline2"]]);
    }

    #[test]
    fn rejects_output_missing_the_record_separator() {
        // Where the newline between records should be, there's a value instead — so the output
        // isn't framed the way the format string implies.
        let parser = ForEachRefParser::new(&["%(refname:short)"]);
        let error = parser
            .parse("\0first\0second\0")
            .expect_err("missing record separators should be an error, not partial data");
        assert!(matches!(error, GitError::Parse { .. }), "got {error:?}");
    }

    #[test]
    fn known_limitation_an_incomplete_record_is_dropped_silently() {
        // Documented rather than fixed, because it matches the original: a trailing record with
        // fewer values than declared fields is discarded instead of reported. Verified against the
        // TypeScript implementation, which accumulates into an entry and only pushes once
        // `consumed % keys.length === 0`, so a partial entry is simply never pushed.
        //
        // Not reachable in practice — the same parser builds the format string it parses, so the
        // field counts can't disagree — but worth pinning so a future change doesn't assume
        // partial records surface as errors.
        let parser = ForEachRefParser::new(&["%(objectname)", "%(refname)"]);
        let parsed = parser
            .parse("\0only-one\0\n")
            .expect("an incomplete record is dropped, not an error");
        assert!(parsed.is_empty(), "got {parsed:?}");
    }
    // --- LogParser ---

    #[test]
    fn log_parser_builds_format_args_with_the_x00_escape() {
        let parser = LogParser::new(&["%H", "%s"]);
        assert_eq!(
            parser.format_args(),
            vec!["-z".to_owned(), "--format=%H%x00%s".to_owned()]
        );
    }

    #[test]
    fn log_parser_groups_fields_into_records() {
        let parser = LogParser::new(&["", "", ""]);
        let parsed = parser.parse("foo\0merge\0binary\0bar\0merge\0unspecified\0");
        assert_eq!(
            parsed,
            vec![
                vec!["foo", "merge", "binary"],
                vec!["bar", "merge", "unspecified"]
            ]
        );
    }

    #[test]
    fn log_parser_ignores_a_trailing_partial_record() {
        // The empty string after the final NUL, plus any genuinely short trailing group, is
        // dropped rather than yielding a record with missing fields.
        let parser = LogParser::new(&["", "", ""]);
        let parsed = parser.parse("foo\0merge\0binary\0leftover\0");
        assert_eq!(parsed, vec![vec!["foo", "merge", "binary"]]);
    }

    #[test]
    fn log_parser_parses_empty_output_as_no_records() {
        let parser = LogParser::new(&["", "", ""]);
        assert!(parser.parse("").is_empty());
    }
}
