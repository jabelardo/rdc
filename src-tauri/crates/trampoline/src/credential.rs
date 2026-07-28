//! git's credential helper protocol.
//!
//! Ported from `desktop-plus/app/src/lib/git/credential.ts`.
//!
//! # Why an ordered list and not a map
//!
//! The original used a JavaScript `Map`, which preserves insertion order, and [`Credential::format`]
//! relies on that: git reads the reply as an ordered sequence, and the `wwwauth[]` array in particular
//! only means anything in order. A Rust `HashMap` would scramble it and a `BTreeMap` would sort it, so
//! this keeps a `Vec` of pairs and looks up linearly. A credential has a handful of entries, so the
//! cost is irrelevant next to being wrong.

use std::collections::HashMap;
use std::path::Path;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// A malformed or unsafe credential.
///
/// Not `PartialEq`, because [`CredentialError::Spawn`] wraps a `std::io::Error` which isn't
/// comparable. Tests match on the variant instead.
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    /// A value contained a character that would break out of the protocol.
    #[error("forbidden characters in credential value: {key}")]
    ForbiddenCharacters { key: String },

    /// The external helper failed.
    #[error("git credential {command} failed: {stderr}")]
    HelperFailed { command: String, stderr: String },

    /// The external helper couldn't be run at all.
    #[error("could not run git credential {command}: {source}")]
    Spawn {
        command: String,
        #[source]
        source: std::io::Error,
    },
}

/// A credential as git's helper protocol represents it: ordered key/value pairs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Credential {
    entries: Vec<(String, String)>,
}

impl Credential {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parses the `key=value` lines git writes to a helper's stdin.
    ///
    /// Some keys are arrays, which git spells as repeated `key[]` entries. Those are expanded to
    /// `key[0]`, `key[1]`, … so each has a distinct name, and [`Credential::format`] collapses them
    /// back. Lines without `=` are skipped, which is how the blank terminating line is ignored.
    pub fn parse(value: &str) -> Self {
        let mut credential = Self::new();

        for line in value.split('\n') {
            // Tolerate CRLF without splitting on \r, which would corrupt a value containing one.
            let line = line.strip_suffix('\r').unwrap_or(line);

            let Some(separator) = line.find('=') else {
                continue;
            };
            let (key, value) = (&line[..separator], &line[separator + 1..]);

            if let Some(base) = key.strip_suffix("[]") {
                let mut index = 0;
                let mut indexed = format!("{base}[{index}]");
                while credential.get(&indexed).is_some() {
                    index += 1;
                    indexed = format!("{base}[{index}]");
                }
                credential.entries.push((indexed, value.to_owned()));
            } else {
                credential.set(key, value);
            }
        }

        credential
    }

    /// Renders the credential for git to read.
    ///
    /// Fails if a value contains a newline or NUL. That is a **security check, not tidiness**: the
    /// protocol is newline-delimited, so a newline in a password would let an attacker inject
    /// additional credential fields. The original threw here for the same reason.
    ///
    /// Indexed keys are collapsed back to `key[]`, the form git expects.
    pub fn format(&self) -> Result<String, CredentialError> {
        let mut output = String::new();

        for (key, value) in &self.entries {
            if value.contains('\n') || value.contains('\0') {
                return Err(CredentialError::ForbiddenCharacters { key: key.clone() });
            }

            output.push_str(&collapse_indexed_key(key));
            output.push('=');
            output.push_str(value);
            output.push('\n');
        }

        Ok(output)
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }

    /// Sets `key`, replacing an existing entry **in place** so ordering is stable.
    pub fn set(&mut self, key: &str, value: impl Into<String>) -> &mut Self {
        let value = value.into();
        match self
            .entries
            .iter_mut()
            .find(|(existing, _)| existing == key)
        {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key.to_owned(), value)),
        }
        self
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The endpoint this credential is for.
    ///
    /// Prefers the `url` field git may supply, otherwise assembles one from `protocol`, `username`,
    /// `host` and `path`. Ported from `getCredentialUrl` in `trampoline-environment.ts`.
    ///
    /// Returns the assembled string rather than a parsed URL type: the original built a `URL` and
    /// immediately stringified it at every call site, and parsing here would mean deciding what to do
    /// with a host git accepted but a URL parser rejects.
    pub fn url(&self) -> String {
        if let Some(url) = self.get("url") {
            return url.to_owned();
        }

        let protocol = self.get("protocol").unwrap_or_default();
        let host = self.get("host").unwrap_or_default();
        let path = self.get("path").unwrap_or_default();
        let user = match self.get("username") {
            Some(username) if !username.is_empty() => format!("{}@", encode_userinfo(username)),
            _ => String::new(),
        };

        format!("{protocol}://{user}{host}/{path}")
    }

    /// The same endpoint with any userinfo removed.
    ///
    /// Ported from `url-without-credentials.ts`. Credentials are keyed on the bare endpoint, so a URL
    /// that arrived with a username embedded must not create a second entry.
    pub fn url_without_credentials(&self) -> String {
        let url = self.url();

        let Some((scheme, rest)) = url.split_once("://") else {
            return url;
        };
        let rest = rest.split_once('@').map_or(rest, |(_, after)| after);

        format!("{scheme}://{rest}")
    }
}

/// Percent-encodes the characters that would otherwise change a URL's structure.
///
/// Deliberately minimal: the original used `encodeURIComponent`, but a username reaching this point
/// came from git, and the only characters that matter for the assembled URL are the delimiters.
fn encode_userinfo(username: &str) -> String {
    let mut encoded = String::with_capacity(username.len());
    for character in username.chars() {
        match character {
            '@' => encoded.push_str("%40"),
            ':' => encoded.push_str("%3A"),
            '/' => encoded.push_str("%2F"),
            '?' => encoded.push_str("%3F"),
            '#' => encoded.push_str("%23"),
            other => encoded.push(other),
        }
    }
    encoded
}

/// Turns `key[3]` back into `key[]`, leaving anything else alone.
fn collapse_indexed_key(key: &str) -> String {
    let Some(open) = key.rfind('[') else {
        return key.to_owned();
    };
    if !key.ends_with(']') {
        return key.to_owned();
    }

    let index = &key[open + 1..key.len() - 1];
    if !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()) {
        format!("{}[]", &key[..open])
    } else {
        key.to_owned()
    }
}

/// Which external-helper operation to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperCommand {
    /// Ask the helper for a credential.
    Fill,
    /// Tell it the credential worked.
    Approve,
    /// Tell it the credential failed.
    Reject,
}

impl HelperCommand {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fill => "fill",
            Self::Approve => "approve",
            Self::Reject => "reject",
        }
    }
}

/// Delegates to the user's configured credential manager.
///
/// Deliberately spawns git directly rather than going through [`git_ops`](../../git_ops/index.html):
/// that path installs the trampoline environment, which would call back into this handler and
/// recurse. The original carried the same warning — "Can't use git() as that will call
/// withTrampolineEnv which calls this method".
///
/// `credential.helper=` clears any inherited configuration before setting `manager`, so the operation
/// reaches the real credential manager and not rdc's own helper. `GIT_TERMINAL_PROMPT=0` and an empty
/// `GIT_ASKPASS` keep it from trying to prompt on a terminal that isn't there.
pub async fn run_helper(
    command: HelperCommand,
    credential: &Credential,
    path: impl AsRef<Path>,
    env: &HashMap<String, String>,
) -> Result<Credential, CredentialError> {
    let stdin = credential.format()?;

    let mut process = Command::new("git");
    process
        .args([
            "-c",
            "credential.helper=",
            "-c",
            "credential.helper=manager",
            "credential",
            command.as_str(),
        ])
        .current_dir(path.as_ref())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("TERM", "dumb")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    for (key, value) in env {
        process.env(key, value);
    }

    let mut child = process.spawn().map_err(|source| CredentialError::Spawn {
        command: command.as_str().to_owned(),
        source,
    })?;

    if let Some(mut handle) = child.stdin.take() {
        // Errors here are reported by the exit status, which carries git's own message.
        let _ = handle.write_all(stdin.as_bytes()).await;
        let _ = handle.shutdown().await;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|source| CredentialError::Spawn {
            command: command.as_str().to_owned(),
            source,
        })?;

    if !output.status.success() {
        return Err(CredentialError::HelperFailed {
            command: command.as_str().to_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    Ok(Credential::parse(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential(pairs: &[(&str, &str)]) -> Credential {
        let mut credential = Credential::new();
        for (key, value) in pairs {
            credential.set(key, *value);
        }
        credential
    }

    #[test]
    fn parses_key_value_lines() {
        let parsed = Credential::parse("protocol=https\nhost=github.com\nusername=me\n");

        assert_eq!(parsed.get("protocol"), Some("https"));
        assert_eq!(parsed.get("host"), Some("github.com"));
        assert_eq!(parsed.get("username"), Some("me"));
    }

    #[test]
    fn keeps_a_value_containing_an_equals_sign() {
        // Only the *first* `=` separates key from value.
        let parsed = Credential::parse("password=a=b=c\n");
        assert_eq!(parsed.get("password"), Some("a=b=c"));
    }

    #[test]
    fn skips_lines_without_a_separator() {
        // The protocol ends with a blank line, which must not become an entry.
        let parsed = Credential::parse("host=github.com\n\nnonsense\n");
        assert_eq!(parsed.iter().count(), 1);
    }

    #[test]
    fn tolerates_crlf_line_endings() {
        let parsed = Credential::parse("host=github.com\r\nusername=me\r\n");
        assert_eq!(parsed.get("host"), Some("github.com"));
        assert_eq!(parsed.get("username"), Some("me"));
    }

    #[test]
    fn expands_repeated_array_keys_into_indexed_ones() {
        let parsed = Credential::parse("wwwauth[]=Basic realm=\"GitHub\"\nwwwauth[]=Bearer\n");

        assert_eq!(parsed.get("wwwauth[0]"), Some("Basic realm=\"GitHub\""));
        assert_eq!(parsed.get("wwwauth[1]"), Some("Bearer"));
    }

    #[test]
    fn collapses_indexed_keys_when_formatting() {
        let parsed = Credential::parse("wwwauth[]=one\nwwwauth[]=two\n");
        assert_eq!(
            parsed.format().expect("formats"),
            "wwwauth[]=one\nwwwauth[]=two\n"
        );
    }

    #[test]
    fn a_round_trip_preserves_order() {
        // git reads the reply as an ordered sequence, so this is a behavioural requirement rather
        // than cosmetic — a hash map would break it.
        let input = "protocol=https\nhost=github.com\nusername=me\npassword=secret\n";
        assert_eq!(Credential::parse(input).format().expect("formats"), input);
    }

    #[test]
    fn setting_an_existing_key_keeps_its_position() {
        let mut cred = credential(&[("protocol", "https"), ("username", "old"), ("host", "h")]);
        cred.set("username", "new");

        assert_eq!(
            cred.format().expect("formats"),
            "protocol=https\nusername=new\nhost=h\n"
        );
    }

    #[test]
    fn refuses_to_format_a_value_containing_a_newline() {
        // The protocol is newline-delimited, so this would let a crafted password inject extra
        // fields into the reply git parses.
        let cred = credential(&[("password", "secret\nusername=attacker")]);

        match cred.format() {
            Err(CredentialError::ForbiddenCharacters { key }) => assert_eq!(key, "password"),
            other => panic!("expected a forbidden-characters error, got {other:?}"),
        }
    }

    #[test]
    fn refuses_to_format_a_value_containing_a_nul() {
        let cred = credential(&[("password", "secret\0")]);
        assert!(matches!(
            cred.format(),
            Err(CredentialError::ForbiddenCharacters { .. })
        ));
    }

    // --- endpoint assembly ---

    #[test]
    fn prefers_an_explicit_url() {
        let cred = credential(&[("url", "https://github.com/o/r"), ("host", "ignored")]);
        assert_eq!(cred.url(), "https://github.com/o/r");
    }

    #[test]
    fn assembles_a_url_from_its_parts() {
        let cred = credential(&[
            ("protocol", "https"),
            ("host", "github.com"),
            ("path", "o/r"),
        ]);
        assert_eq!(cred.url(), "https://github.com/o/r");
    }

    #[test]
    fn includes_a_username_in_the_assembled_url() {
        let cred = credential(&[
            ("protocol", "https"),
            ("username", "me"),
            ("host", "github.com"),
        ]);
        assert_eq!(cred.url(), "https://me@github.com/");
    }

    #[test]
    fn encodes_a_username_that_would_change_the_url_structure() {
        // An email address as a username is common, and an unencoded `@` would make the host wrong.
        let cred = credential(&[
            ("protocol", "https"),
            ("username", "me@example.com"),
            ("host", "github.com"),
        ]);
        assert_eq!(cred.url(), "https://me%40example.com@github.com/");
    }

    #[test]
    fn ignores_an_empty_username() {
        let cred = credential(&[("protocol", "https"), ("username", ""), ("host", "h")]);
        assert_eq!(cred.url(), "https://h/");
    }

    #[test]
    fn strips_userinfo_for_the_storage_key() {
        // Credentials are keyed on the bare endpoint; otherwise the same host stored twice.
        let cred = credential(&[("url", "https://me@github.com/o/r")]);
        assert_eq!(cred.url_without_credentials(), "https://github.com/o/r");
    }

    #[test]
    fn leaves_a_url_without_userinfo_alone() {
        let cred = credential(&[("url", "https://github.com/o/r")]);
        assert_eq!(cred.url_without_credentials(), "https://github.com/o/r");
    }

    #[test]
    fn leaves_a_value_that_is_not_a_url_alone() {
        let cred = credential(&[("url", "not a url")]);
        assert_eq!(cred.url_without_credentials(), "not a url");
    }

    // --- indexed-key handling ---

    #[test]
    fn only_collapses_keys_whose_index_is_numeric() {
        assert_eq!(collapse_indexed_key("wwwauth[0]"), "wwwauth[]");
        assert_eq!(collapse_indexed_key("wwwauth[12]"), "wwwauth[]");
        assert_eq!(collapse_indexed_key("plain"), "plain");
        assert_eq!(collapse_indexed_key("odd[name]"), "odd[name]");
        assert_eq!(collapse_indexed_key("empty[]"), "empty[]");
    }
}
