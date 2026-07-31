// Generates crates/git-ops/src/git_error_kind.rs from dugite's own error table, so all the
// regexes and — critically — their ORDER are reproduced exactly rather than transcribed.
//
// Usage, from this directory:
//
//   npm pack dugite && tar xzf dugite-*.tgz     # produces ./package
//   node generate-git-error-kind.mjs ../src/git_error_kind.rs
//
// Re-run this when upgrading the dugite version the classifier is derived from; do not hand-edit
// the generated file.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { GitError, GitErrorRegexes } = require('./package/build/lib/errors.js')

const names = {}
for (const [k, v] of Object.entries(GitError))
  if (typeof v === 'number') names[v] = k

const variants = Object.keys(names)
  .map(Number)
  .sort((a, b) => a - b)
  .map(n => names[n])

const entries = Object.entries(GitErrorRegexes)

// Rust raw strings: prefer r"..." and escalate the hash count if the pattern contains a quote
// followed by hashes. Patterns contain backslashes, so raw strings avoid double-escaping.
const rustRaw = s => {
  let hashes = ''
  while (s.includes(`"${hashes}`)) hashes += '#'
  return `r${hashes}"${s}"${hashes}`
}

const dugiteVersion = require('./package/package.json').version

const out = `//! Classification of git failures from stderr.
//!
//! GENERATED — do not edit by hand. Regenerate with the script recorded in MIGRATION_MAP.md if
//! dugite's table changes.
//!
//! The [\`GitErrorKind\`] variants and the pattern table below are reproduced verbatim from
//! dugite v${dugiteVersion} (\`build/lib/errors.js\`), which is what \`desktop-plus\` used via
//! \`lib/git/core.ts\`. Generating rather than transcribing keeps all ${entries.length} patterns —
//! and their order — exact.
//!
//! **Order is significant.** dugite's \`parseError\` returns the *first* matching pattern
//! (\`Object.entries(GitErrorRegexes).find(...)\`), and several patterns overlap: e.g.
//! \`fatal: Authentication failed for 'https?://\` must be tested before the more general
//! \`fatal: Authentication failed\`, or every HTTPS auth failure would be misreported as SSH.
//!
//! Note that user-facing message text is deliberately *not* ported here — see the note on
//! \`getDescriptionForError\` in MIGRATION_MAP.md. Rust returns the typed kind; mapping a kind to
//! display copy belongs in the frontend, where it can be localized.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// A git failure recognized from stderr.
///
/// Mirrors dugite's \`GitError\` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GitErrorKind {
${variants.map(v => `    ${v},`).join('\n')}
}

impl GitErrorKind {
    /// Whether this failure is an authentication problem.
    ///
    /// Ported from \`isAuthFailureError\` in \`desktop-plus/app/src/lib/git/core.ts\`.
    pub fn is_auth_failure(self) -> bool {
        matches!(
            self,
            Self::SSHAuthenticationFailed
                | Self::SSHPermissionDenied
                | Self::HTTPSAuthenticationFailed
        )
    }
}

/// Patterns in dugite's original order. The first match wins.
const PATTERNS: &[(&str, GitErrorKind)] = &[
${entries.map(([re, v]) => `    (${rustRaw(re)}, GitErrorKind::${names[v]}),`).join('\n')}
];

fn compiled() -> &'static [(Regex, GitErrorKind)] {
    static COMPILED: OnceLock<Vec<(Regex, GitErrorKind)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        PATTERNS
            .iter()
            .map(|(pattern, kind)| {
                // The pattern table is a compile-time constant validated by
                // \`all_patterns_compile\` below, so a failure here is a bug in this file rather
                // than a runtime condition callers could handle.
                let re = Regex::new(pattern)
                    .unwrap_or_else(|e| panic!("invalid built-in git error pattern {pattern:?}: {e}"));
                (re, *kind)
            })
            .collect()
    })
}

/// Classifies a git failure from its stderr, or \`None\` if nothing matches.
///
/// Equivalent to dugite's \`parseError\`: the first pattern to match, in table order.
pub fn parse_error(stderr: &str) -> Option<GitErrorKind> {
    compiled()
        .iter()
        .find(|(re, _)| re.is_match(stderr))
        .map(|(_, kind)| *kind)
}

/// The offending key and value from a \`BadConfigValue\` failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadConfigValue {
    pub key: String,
    pub value: String,
}

/// Extracts the key/value from a bad-config-value failure.
///
/// Ported from dugite's \`parseBadConfigValueErrorInfo\`. Note the capture order: the value is
/// captured before the key in git's message.
pub fn parse_bad_config_value(stderr: &str) -> Option<BadConfigValue> {
    let (re, _) = compiled()
        .iter()
        .find(|(_, kind)| *kind == GitErrorKind::BadConfigValue)?;
    let captures = re.captures(stderr)?;
    Some(BadConfigValue {
        value: captures.get(1)?.as_str().to_owned(),
        key: captures.get(2)?.as_str().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_patterns_compile() {
        // Forces the OnceLock, so a malformed pattern fails here rather than at first use in
        // production. Also asserts the table didn't lose entries in generation.
        assert_eq!(compiled().len(), ${entries.length});
    }

    #[test]
    fn returns_none_when_nothing_matches() {
        assert_eq!(parse_error("something entirely unremarkable"), None);
        assert_eq!(parse_error(""), None);
    }

    #[test]
    fn classifies_https_auth_failure_before_the_generic_ssh_pattern() {
        // The ordering case that matters most: both patterns match this input, and the HTTPS one
        // comes first in dugite's table.
        let stderr = "fatal: Authentication failed for 'https://github.com/foo/bar.git/'";
        assert_eq!(
            parse_error(stderr),
            Some(GitErrorKind::HTTPSAuthenticationFailed)
        );
    }

    #[test]
    fn classifies_generic_auth_failure_as_ssh() {
        assert_eq!(
            parse_error("fatal: Authentication failed"),
            Some(GitErrorKind::SSHAuthenticationFailed)
        );
    }

    #[test]
    fn classifies_common_failures() {
        for (stderr, expected) in [
            (
                "fatal: repository 'https://github.com/foo/bar.git/' not found",
                GitErrorKind::HTTPSRepositoryNotFound,
            ),
            ("ERROR: Repository not found", GitErrorKind::SSHRepositoryNotFound),
            (
                "fatal: 'origin' does not appear to be a git repository\\nfatal: Could not read from remote repository.",
                GitErrorKind::SSHPermissionDenied,
            ),
            (
                "Automatic merge failed; fix conflicts and then commit the result.",
                GitErrorKind::MergeConflicts,
            ),
            (
                "Resolve all conflicts manually, mark them as resolved with",
                GitErrorKind::RebaseConflicts,
            ),
            (
                "fatal: The remote end hung up unexpectedly",
                GitErrorKind::RemoteDisconnection,
            ),
        ] {
            assert_eq!(parse_error(stderr), Some(expected), "for stderr {stderr:?}");
        }
    }

    #[test]
    fn identifies_auth_failures() {
        assert!(GitErrorKind::HTTPSAuthenticationFailed.is_auth_failure());
        assert!(GitErrorKind::SSHAuthenticationFailed.is_auth_failure());
        assert!(GitErrorKind::SSHPermissionDenied.is_auth_failure());
        assert!(!GitErrorKind::MergeConflicts.is_auth_failure());
        assert!(!GitErrorKind::NothingToCommit.is_auth_failure());
    }

    #[test]
    fn extracts_bad_config_key_and_value() {
        let stderr = "fatal: bad numeric config value 'aaaa' for 'core.repositoryformatversion'";
        assert_eq!(parse_error(stderr), Some(GitErrorKind::BadConfigValue));
        assert_eq!(
            parse_bad_config_value(stderr),
            Some(BadConfigValue {
                key: "core.repositoryformatversion".to_owned(),
                value: "aaaa".to_owned(),
            })
        );
    }

    #[test]
    fn returns_no_bad_config_info_for_an_unrelated_error() {
        assert_eq!(parse_bad_config_value("ERROR: Repository not found"), None);
    }
}
`

writeFileSync(process.argv[2], out)
console.log(
  `wrote ${process.argv[2]}: ${variants.length} variants, ${entries.length} patterns`
)
