//! Loading the environment a user's terminal would have.
//!
//! Ported from `desktop-plus/app/src/lib/hooks/get-shell-env.ts`, and the `printenvz` helper it runs
//! (`desktop-plus/vendor/printenvz`, a ten-line C program) is reimplemented as the `rdc-printenvz`
//! binary in this crate.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::error::GitError;
use crate::hooks::shell::{quote_command, Shell};

/// Markers `rdc-printenvz` writes around its output.
///
/// The output has to be delimited because a user's init files may print to stdout — a MOTD, a version
/// manager announcing itself — and that text would otherwise be parsed as environment variables. The
/// spelling is upstream's, kept so the two implementations remain comparable; it is a private protocol
/// between this module and the binary.
pub const BEGIN_MARKER: &str = "--printenvz--begin";
pub const END_MARKER: &str = "--printenvz--end";

/// An environment as a login shell reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellEnv {
    /// The variables, in no particular order.
    pub vars: HashMap<String, String>,

    /// The shell that produced them.
    ///
    /// Carried so a failure can name it: upstream's proxy tells the user which shell it couldn't load
    /// and points at the preference that selects one.
    pub shell: PathBuf,
}

/// Runs the user's login shell and collects the environment it builds.
///
/// `cwd` is the directory to run in — the repository, so that directory-local tooling (`.nvmrc`,
/// `direnv`, a project-local `.envrc`) applies the way it would in a terminal opened there.
///
/// `printenvz` is the path to the `rdc-printenvz` binary. It is a parameter rather than something
/// resolved here for the same reason the trampoline's paths are: this crate must not know the
/// application bundle's layout, and a test needs to point at a build artifact.
///
/// # The child gets an empty environment
///
/// Not the app's environment: the whole purpose is to find out what the *shell* produces, and
/// inheriting our own variables would mask exactly the differences being looked for — a `PATH` the app
/// was launched with would silently stand in for the one the user's init files build. Upstream passed
/// `env: {}` for this reason, and this passes an explicitly cleared environment.
///
/// # Stdin is closed, where the original left it open
///
/// The shell runs interactive (`-i`), so an init file that reads stdin is possible — and upstream piped
/// stdin without ever writing or closing it, leaving such a shell blocked forever with no timeout. A
/// closed stdin gives it EOF instead. A well-behaved init file cannot tell the difference.
pub async fn get_shell_env(cwd: Option<&Path>, printenvz: &Path) -> Result<ShellEnv, GitError> {
    get_shell_env_with_shell(Shell::for_user(), cwd, printenvz).await
}

/// [`get_shell_env`] with the shell supplied, so a test doesn't depend on the developer's `SHELL`.
pub async fn get_shell_env_with_shell(
    shell: Shell,
    cwd: Option<&Path>,
    printenvz: &Path,
) -> Result<ShellEnv, GitError> {
    let command = quote_command(
        printenvz.to_str().ok_or_else(|| GitError::Parse {
            context: "getShellEnv".to_owned(),
            message: format!(
                "the printenvz path is not valid UTF-8: {}",
                printenvz.display()
            ),
        })?,
        Vec::<String>::new(),
    );

    let mut process = tokio::process::Command::new(&shell.path);
    process
        .args(shell.args.iter().map(OsStr::new))
        .arg(&command)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }

    let output = process.output().await.map_err(|error| GitError::Parse {
        context: "getShellEnv".to_owned(),
        message: format!("could not run {}: {error}", shell.path.display()),
    })?;

    if !output.status.success() {
        return Err(GitError::Parse {
            context: "getShellEnv".to_owned(),
            message: format!(
                "{} exited with {}: {}",
                shell.path.display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }

    Ok(ShellEnv {
        vars: parse_printenvz_output(&output.stdout)?,
        shell: shell.path,
    })
}

/// Parses `rdc-printenvz`'s output.
///
/// Works on bytes rather than a string because an environment variable's value is arbitrary bytes on
/// Unix; entries are decoded lossily, matching how the original's `Buffer::toString()` behaved and how
/// [`crate::status_parser`] treats paths.
///
/// **The last end marker wins.** A variable's *value* may contain newlines, so a value could itself
/// contain the marker text; taking the last occurrence means such a value can't truncate the output.
/// The first begin marker is used for the mirror-image reason — init-file output printed before it
/// can't be mistaken for a variable.
pub fn parse_printenvz_output(stdout: &[u8]) -> Result<HashMap<String, String>, GitError> {
    let text = String::from_utf8_lossy(stdout);

    let Some(begin) = text.find(BEGIN_MARKER) else {
        return Err(GitError::Parse {
            context: "getShellEnv".to_owned(),
            // Almost always a shell that failed to start or an init file that exited early, and the
            // output is the only evidence either way.
            message: format!("no start marker in the shell's output: {text:?}"),
        });
    };
    let Some(end) = text.rfind(END_MARKER) else {
        return Err(GitError::Parse {
            context: "getShellEnv".to_owned(),
            message: format!("no end marker in the shell's output: {text:?}"),
        });
    };

    let body_start = begin + BEGIN_MARKER.len();
    if end < body_start {
        return Err(GitError::Parse {
            context: "getShellEnv".to_owned(),
            message: "the shell's output has its end marker before its start marker".to_owned(),
        });
    }

    let mut vars = HashMap::new();
    for entry in text[body_start..end].split('\0') {
        // The markers are written on their own lines, so the first and last entries carry the
        // surrounding newlines.
        let entry = entry.trim_matches(['\r', '\n']);
        if entry.is_empty() {
            continue;
        }
        // A name cannot contain `=`, so the first one separates name from value. A value certainly can.
        if let Some((name, value)) = entry.split_once('=') {
            vars.insert(name.to_owned(), value.to_owned());
        }
    }

    Ok(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds output shaped like the binary's, from name/value pairs.
    fn printenvz_output(vars: &[(&str, &str)]) -> Vec<u8> {
        let mut out = format!("{BEGIN_MARKER}\n").into_bytes();
        for (name, value) in vars {
            out.extend_from_slice(format!("{name}={value}").as_bytes());
            out.push(0);
        }
        out.extend_from_slice(format!("\n{END_MARKER}\n").as_bytes());
        out
    }

    #[test]
    fn reads_the_variables_between_the_markers() {
        let vars = parse_printenvz_output(&printenvz_output(&[
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/someone"),
        ]))
        .expect("parsing should succeed");

        assert_eq!(vars.len(), 2);
        assert_eq!(vars["PATH"], "/usr/bin:/bin");
        assert_eq!(vars["HOME"], "/home/someone");
    }

    #[test]
    fn ignores_what_an_init_file_printed_before_the_markers() {
        // The reason the markers exist: a MOTD, or a version manager announcing itself, would otherwise
        // be parsed as variables.
        let mut stdout = b"Welcome to your shell!\nnvm: using v22\n".to_vec();
        stdout.extend_from_slice(&printenvz_output(&[("PATH", "/usr/bin")]));

        let vars = parse_printenvz_output(&stdout).expect("parsing should succeed");

        assert_eq!(vars.len(), 1);
        assert_eq!(vars["PATH"], "/usr/bin");
    }

    #[test]
    fn ignores_what_was_printed_after_the_markers() {
        let mut stdout = printenvz_output(&[("PATH", "/usr/bin")]);
        stdout.extend_from_slice(b"goodbye\n");

        let vars = parse_printenvz_output(&stdout).expect("parsing should succeed");

        assert_eq!(vars.len(), 1);
    }

    #[test]
    fn keeps_a_value_containing_an_equals_sign() {
        // Only the first `=` separates; a name can't contain one but a value routinely does.
        let vars = parse_printenvz_output(&printenvz_output(&[(
            "GIT_CONFIG_PARAMETERS",
            "'core.hooksPath=/tmp/hooks'",
        )]))
        .expect("parsing should succeed");

        assert_eq!(vars["GIT_CONFIG_PARAMETERS"], "'core.hooksPath=/tmp/hooks'");
    }

    #[test]
    fn keeps_a_value_containing_newlines() {
        // Why the entries are NUL-delimited rather than line-delimited.
        let vars = parse_printenvz_output(&printenvz_output(&[("MULTILINE", "one\ntwo\nthree")]))
            .expect("parsing should succeed");

        assert_eq!(vars["MULTILINE"], "one\ntwo\nthree");
    }

    #[test]
    fn a_value_containing_the_end_marker_does_not_truncate_the_output() {
        // Why the *last* end marker wins. An exported variable holding the marker text is contrived,
        // but the cost of being wrong is silently losing every variable after it.
        let vars = parse_printenvz_output(&printenvz_output(&[
            ("SNEAKY", &format!("\n{END_MARKER}\n")),
            ("PATH", "/usr/bin"),
        ]))
        .expect("parsing should succeed");

        assert_eq!(vars["PATH"], "/usr/bin", "the later variable survives");
        assert!(vars.contains_key("SNEAKY"));
    }

    #[test]
    fn keeps_an_empty_value() {
        // `FOO=` is a set-but-empty variable, which is not the same as unset — and the difference is
        // observable to a hook.
        let vars = parse_printenvz_output(&printenvz_output(&[("EMPTY", "")]))
            .expect("parsing should succeed");

        assert_eq!(vars.get("EMPTY").map(String::as_str), Some(""));
    }

    #[test]
    fn decodes_an_invalid_utf8_value_lossily() {
        // Values are arbitrary bytes on Unix. Failing the whole parse over one would throw away a
        // usable environment.
        let mut stdout = format!("{BEGIN_MARKER}\n").into_bytes();
        stdout.extend_from_slice(b"WEIRD=caf\xff");
        stdout.push(0);
        stdout.extend_from_slice(b"PATH=/usr/bin");
        stdout.push(0);
        stdout.extend_from_slice(format!("\n{END_MARKER}\n").as_bytes());

        let vars = parse_printenvz_output(&stdout).expect("parsing should succeed");

        assert_eq!(vars["PATH"], "/usr/bin");
        assert!(vars["WEIRD"].starts_with("caf"));
    }

    #[test]
    fn reports_a_shell_that_produced_no_markers() {
        // What a shell that failed to start, or an init file that exited early, looks like. Returning
        // an empty environment instead would hand hooks a broken one and call it success.
        assert!(parse_printenvz_output(b"").is_err());
        assert!(parse_printenvz_output(b"command not found: printenvz\n").is_err());
        assert!(
            parse_printenvz_output(format!("{BEGIN_MARKER}\nPATH=/usr/bin\0").as_bytes()).is_err(),
            "a truncated run — killed mid-write — must not read as success"
        );
    }

    #[test]
    fn reports_markers_in_the_wrong_order() {
        let stdout = format!("{END_MARKER}\nPATH=/usr/bin\0\n{BEGIN_MARKER}\n");

        assert!(parse_printenvz_output(stdout.as_bytes()).is_err());
    }

    #[test]
    fn reads_an_empty_environment_as_empty_rather_than_broken() {
        let vars = parse_printenvz_output(&printenvz_output(&[])).expect("parsing should succeed");

        assert!(vars.is_empty());
    }

    #[test]
    fn tolerates_crlf_around_the_markers() {
        // Windows shells write CRLF; the marker search doesn't depend on the line ending.
        let stdout = format!("{BEGIN_MARKER}\r\nPATH=/usr/bin\0\r\n{END_MARKER}\r\n");

        let vars = parse_printenvz_output(stdout.as_bytes()).expect("parsing should succeed");

        assert_eq!(vars["PATH"], "/usr/bin");
    }
}
