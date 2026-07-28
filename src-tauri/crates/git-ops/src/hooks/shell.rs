//! Choosing the user's shell, and quoting a command for it.
//!
//! Ported from `desktop-plus/app/src/lib/hooks/get-shell.ts` and `shell-escape.ts`.
//!
//! # Why a login shell at all
//!
//! The point of the exercise is to get the environment the user's *terminal* has, and that environment
//! is built by their shell's init files. So the shell has to be run the way a terminal runs it —
//! interactive and login (`-ilc`) — because `~/.bashrc` is read for interactive shells and
//! `~/.bash_profile`/`~/.zprofile` for login ones, and version managers install themselves in either.
//!
//! # Windows is deliberately not ported
//!
//! Upstream supports `git-bash`, `pwsh`, `powershell` and `cmd`, which is most of the size of its shell
//! layer: Git Bash is located through `HKEY_LOCAL_MACHINE\SOFTWARE\GitForWindows` or by walking up from
//! `git.exe`, and it needs MSYS2's own argument quoting plus Node's `windowsVerbatimArguments` escape
//! hatch, because MSYS2 re-parses the raw command line instead of using the argv it was given.
//! PowerShell and `cmd` each need their own quoting rules again.
//!
//! Linux is rdc's primary target and none of that is testable here, so this implements the POSIX path
//! and leaves a description of the Windows work rather than a half-port that looks finished. The
//! `SupportedHooksEnvShell` setting that selects between the Windows shells is frontend state
//! (`localStorage`), so it belongs with the Phase 7 preferences UI in any case.

use std::path::PathBuf;

/// The shell to load the environment from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shell {
    /// The shell binary.
    pub path: PathBuf,

    /// Arguments that make it read its init files and then run a command.
    pub args: Vec<String>,
}

impl Shell {
    /// The user's shell, from `SHELL`, falling back to `/bin/sh`.
    ///
    /// `SHELL` is what the login process recorded, so it is the shell whose init files hold the
    /// environment we're after — not whatever happens to be running now.
    ///
    /// `/bin/sh` as the fallback matches the original. It is a poor source of a *user* environment,
    /// since it reads almost nothing, but it exists everywhere and the alternative is failing outright.
    pub fn for_user() -> Self {
        Self::from_shell_path(std::env::var_os("SHELL").map(PathBuf::from))
    }

    /// [`Shell::for_user`] with the variable supplied, so tests don't mutate the process environment.
    pub fn from_shell_path(shell: Option<PathBuf>) -> Self {
        Self {
            path: shell.unwrap_or_else(|| PathBuf::from("/bin/sh")),
            // Interactive **and** login, because init files are split across the two, and `-c` because
            // we have exactly one command to run.
            args: vec!["-ilc".to_owned()],
        }
    }
}

/// Quotes a command and its arguments for a POSIX shell.
///
/// Single quotes, with embedded single quotes closed and reopened (`'\''`) — the only form that needs
/// no other escaping, since a single-quoted string in `sh` has no metacharacters at all.
///
/// Characters that cannot survive the round trip are **dropped** rather than escaped, matching the
/// original (which took the rule from `shescape`): NUL and backspace, which a shell can't carry, and
/// the escape characters `\u{1b}`/`\u{9b}` that would let an argument move the terminal cursor. A lone
/// carriage return is dropped too, since a shell would treat it as a line ending; `\r\n` is left alone.
///
/// The original noted this only ever quotes paths to executables we control, so it isn't a general
/// escaping utility — but it costs nothing to make it correct for arbitrary input, and it means the
/// caller doesn't have to know.
pub fn quote_command<I, S>(command: &str, args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut parts = vec![quote_one(command)];
    parts.extend(args.into_iter().map(|arg| quote_one(arg.as_ref())));
    parts.join(" ")
}

/// Quotes one argument.
fn quote_one(argument: &str) -> String {
    let mut quoted = String::with_capacity(argument.len() + 2);
    quoted.push('\'');

    let mut chars = argument.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\0' | '\u{8}' | '\u{1b}' | '\u{9b}' => {}
            // A bare CR only; the one before a newline is part of a line ending and is kept.
            '\r' if chars.peek() != Some(&'\n') => {}
            '\'' => quoted.push_str("'\\''"),
            other => quoted.push(other),
        }
    }

    quoted.push('\'');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_shell_the_user_logged_in_with() {
        let shell = Shell::from_shell_path(Some(PathBuf::from("/usr/bin/zsh")));

        assert_eq!(shell.path, PathBuf::from("/usr/bin/zsh"));
        assert_eq!(shell.args, vec!["-ilc".to_owned()]);
    }

    #[test]
    fn falls_back_to_sh_when_shell_is_unset() {
        // A poor source of a user environment, but it exists everywhere; the alternative is no hook
        // support at all.
        assert_eq!(Shell::from_shell_path(None).path, PathBuf::from("/bin/sh"));
    }

    #[test]
    fn asks_for_an_interactive_login_shell() {
        // The whole point: `~/.bashrc` is read for interactive shells and `~/.bash_profile` for login
        // ones, and version managers install themselves in either.
        assert_eq!(Shell::for_user().args, vec!["-ilc".to_owned()]);
    }

    #[test]
    fn quotes_a_plain_command() {
        assert_eq!(quote_command("/usr/bin/env", ["-0"]), "'/usr/bin/env' '-0'");
    }

    #[test]
    fn quotes_a_path_containing_spaces() {
        assert_eq!(
            quote_command("/Applications/My App/bin/printenvz", Vec::<String>::new()),
            "'/Applications/My App/bin/printenvz'"
        );
    }

    #[test]
    fn closes_and_reopens_around_a_single_quote() {
        // The only way to get a single quote into a single-quoted string.
        assert_eq!(
            quote_command("/tmp/it's here", Vec::<String>::new()),
            r"'/tmp/it'\''s here'"
        );
    }

    #[test]
    fn leaves_shell_metacharacters_inert() {
        // Inside single quotes none of these mean anything, which is why this form needs no other
        // escaping.
        let quoted = quote_command("/tmp/$(rm -rf ~)`x`;|&><*?", Vec::<String>::new());

        assert_eq!(quoted, "'/tmp/$(rm -rf ~)`x`;|&><*?'");
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
    }

    #[test]
    fn drops_characters_a_shell_cannot_carry() {
        // NUL terminates an argument in the kernel and backspace/escape can move the terminal cursor,
        // so dropping is the only faithful option — and it is what the original did.
        assert_eq!(
            quote_command("a\0b\u{8}c\u{1b}d\u{9b}e", Vec::<String>::new()),
            "'abcde'"
        );
    }

    #[test]
    fn drops_a_bare_carriage_return_but_keeps_a_line_ending() {
        // A lone CR would read as a line ending to the shell; the CR in CRLF is part of one already.
        assert_eq!(quote_command("a\rb", Vec::<String>::new()), "'ab'");
        assert_eq!(quote_command("a\r\nb", Vec::<String>::new()), "'a\r\nb'");
    }
}
