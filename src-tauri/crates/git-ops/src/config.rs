//! Reading and writing git configuration.
//!
//! Ported from `desktop-plus/app/src/lib/git/config.ts`.
//!
//! Not ported (tracked in MIGRATION_MAP.md):
//! - `getGlobalConfigPath` — relies on `git config --edit` with `GIT_EDITOR=printf %s` to make git
//!   print the path it *would* edit, creating the file as a side effect. Only needed for "open my
//!   global config in an editor", which is a Phase 4 shell/editor concern.
//! - `getConfigValueWithOrigin` and the `formatConfigScope`/`formatConfigPath`/
//!   `isConditionalInclude`/`getOriginFilePath` helpers — the latter produce display strings such
//!   as `"global, via [includeIf]"` and `"<repo>/.git/config"`, which are frontend presentation,
//!   like `getDescriptionForError`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::GitError;
use crate::exec::{git, GitOptions};

/// What git canonicalizes a falsey value to when asked for `--type bool`.
const GIT_FALSE: &str = "false";

/// A `git config --type` canonicalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigType {
    Bool,
}

impl ConfigType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bool => "bool",
        }
    }
}

/// Which config file(s) a lookup should consider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Location<'a> {
    /// A repository, consulting the full config cascade (system, global, local).
    Repository { path: &'a Path },
    /// A repository, restricted to its own `.git/config` (`--local`).
    RepositoryLocalOnly { path: &'a Path },
    /// The user's global config (`--global`).
    Global,
}

/// Reads a config value.
///
/// Returns `Ok(None)` when the key isn't set: git exits 1 for that, which is not an error.
async fn get_value(
    location: Location<'_>,
    name: &str,
    config_type: Option<ConfigType>,
    env: HashMap<String, String>,
) -> Result<Option<String>, GitError> {
    // -z so that values containing newlines survive intact.
    let mut args = vec!["config".to_owned(), "-z".to_owned()];
    match location {
        Location::Global => args.push("--global".to_owned()),
        Location::RepositoryLocalOnly { .. } => args.push("--local".to_owned()),
        Location::Repository { .. } => {}
    }
    if let Some(config_type) = config_type {
        args.push("--type".to_owned());
        args.push(config_type.as_str().to_owned());
    }
    args.push(name.to_owned());

    let cwd = working_directory(location);
    let output = git(
        &args,
        &cwd,
        "getConfigValueInPath",
        // 1 means "not set", which is a normal answer rather than a failure.
        GitOptions {
            env,
            ..GitOptions::default()
        }
        .with_success_exit_codes([1]),
    )
    .await?;

    if output.exit_code == 1 {
        return Ok(None);
    }

    // With -z each value is NUL-terminated, so the value is everything before the first NUL.
    let stdout = output.stdout_lossy();
    Ok(Some(
        stdout.split('\0').next().unwrap_or_default().to_owned(),
    ))
}

/// Writes a config value, replacing any existing entries for the key.
async fn set_value(
    location: Location<'_>,
    name: &str,
    value: &str,
    env: HashMap<String, String>,
) -> Result<(), GitError> {
    let mut args = vec!["config".to_owned()];
    if matches!(location, Location::Global) {
        args.push("--global".to_owned());
    }
    // --replace-all so a key that somehow has several entries ends up with exactly one.
    args.push("--replace-all".to_owned());
    args.push(name.to_owned());
    args.push(value.to_owned());

    let cwd = working_directory(location);
    git(
        &args,
        &cwd,
        "setConfigValueInPath",
        GitOptions {
            env,
            ..GitOptions::default()
        },
    )
    .await?;

    Ok(())
}

/// Removes every entry for a config key.
async fn remove_value(
    location: Location<'_>,
    name: &str,
    env: HashMap<String, String>,
) -> Result<(), GitError> {
    let mut args = vec!["config".to_owned()];
    if matches!(location, Location::Global) {
        args.push("--global".to_owned());
    }
    args.push("--unset-all".to_owned());
    args.push(name.to_owned());

    let cwd = working_directory(location);
    git(
        &args,
        &cwd,
        "removeConfigValueInPath",
        GitOptions {
            env,
            ..GitOptions::default()
        },
    )
    .await?;

    Ok(())
}

/// The directory to run git in.
///
/// For `--global` operations the location is irrelevant to the result, but git still needs a
/// working directory that exists. The original used the app's install directory (`__dirname`);
/// the temp directory is the equivalent "somewhere that reliably exists" without tying the git
/// layer to the bundle layout.
fn working_directory(location: Location<'_>) -> PathBuf {
    match location {
        Location::Repository { path } | Location::RepositoryLocalOnly { path } => {
            path.to_path_buf()
        }
        Location::Global => std::env::temp_dir(),
    }
}

/// Interprets a `--type bool` result.
///
/// git canonicalizes every truthy spelling (`yes`, `on`, `1`, …) to `true` and every falsey one
/// (`no`, `off`, `0`, …) to `false`, so this only has to recognize those two.
fn parse_bool(value: &str) -> bool {
    // Mirrors the original's `value !== 'false'`: anything git didn't canonicalize to "false" is
    // treated as true.
    value != GIT_FALSE
}

/// Looks up a config value in a repository.
///
/// `only_local` restricts the lookup to the repository's own config (`--local`), ignoring the
/// global and system files.
pub async fn get_config_value(
    repository: impl AsRef<Path>,
    name: &str,
    only_local: bool,
) -> Result<Option<String>, GitError> {
    let path = repository.as_ref();
    let location = if only_local {
        Location::RepositoryLocalOnly { path }
    } else {
        Location::Repository { path }
    };
    get_value(location, name, None, HashMap::new()).await
}

/// Looks up a config value in a repository and interprets it as a git boolean.
pub async fn get_boolean_config_value(
    repository: impl AsRef<Path>,
    name: &str,
    only_local: bool,
) -> Result<Option<bool>, GitError> {
    let path = repository.as_ref();
    let location = if only_local {
        Location::RepositoryLocalOnly { path }
    } else {
        Location::Repository { path }
    };
    Ok(
        get_value(location, name, Some(ConfigType::Bool), HashMap::new())
            .await?
            .map(|value| parse_bool(&value)),
    )
}

/// Sets a config value in a repository, replacing any existing entries.
pub async fn set_config_value(
    repository: impl AsRef<Path>,
    name: &str,
    value: &str,
) -> Result<(), GitError> {
    let path = repository.as_ref();
    set_value(Location::Repository { path }, name, value, HashMap::new()).await
}

/// Removes a config key from a repository.
pub async fn remove_config_value(repository: impl AsRef<Path>, name: &str) -> Result<(), GitError> {
    let path = repository.as_ref();
    remove_value(Location::Repository { path }, name, HashMap::new()).await
}

/// Accessor for the user's global git configuration.
///
/// Which file that is depends on `HOME`, so this type makes the home directory explicit rather
/// than leaving it implicit in the ambient environment. Tests **must** use
/// [`GlobalConfig::with_home`] — writing global config in a test otherwise modifies the
/// developer's real `~/.gitconfig`.
#[derive(Debug, Clone, Default)]
pub struct GlobalConfig {
    home: Option<PathBuf>,
}

impl GlobalConfig {
    /// The real user's global config, via the ambient `HOME`.
    pub fn new() -> Self {
        Self::default()
    }

    /// A global config rooted at `home` instead of the ambient `HOME`.
    ///
    /// git resolves `~/.gitconfig` from `HOME`, so this redirects reads and writes to a
    /// throwaway location.
    pub fn with_home(home: impl Into<PathBuf>) -> Self {
        Self {
            home: Some(home.into()),
        }
    }

    fn env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        if let Some(home) = &self.home {
            // Note: on Windows git also consults USERPROFILE. rdc targets Linux (primary) and
            // macOS, so HOME is sufficient; revisit if Windows support is added.
            env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
            // `GIT_CONFIG_GLOBAL` **outranks HOME**, so an ambient one would send reads and writes back to
            // the developer's real `~/.gitconfig` — defeating the isolation this type exists to provide.
            // Pointing it at the stub file overrides it rather than relying on it being unset; naming the
            // same file HOME would resolve to keeps the two consistent.
            env.insert(
                "GIT_CONFIG_GLOBAL".to_owned(),
                home.join(".gitconfig").to_string_lossy().into_owned(),
            );
        }
        env
    }

    /// Looks up a global config value.
    pub async fn get(&self, name: &str) -> Result<Option<String>, GitError> {
        get_value(Location::Global, name, None, self.env()).await
    }

    /// Looks up a global config value and interprets it as a git boolean.
    pub async fn get_boolean(&self, name: &str) -> Result<Option<bool>, GitError> {
        Ok(
            get_value(Location::Global, name, Some(ConfigType::Bool), self.env())
                .await?
                .map(|value| parse_bool(&value)),
        )
    }

    /// Sets a global config value, replacing any existing entries for the key.
    pub async fn set(&self, name: &str, value: &str) -> Result<(), GitError> {
        set_value(Location::Global, name, value, self.env()).await
    }

    /// Removes a global config key.
    pub async fn remove(&self, name: &str) -> Result<(), GitError> {
        remove_value(Location::Global, name, self.env()).await
    }

    /// Adds `path` to `safe.directory`, so git stops refusing to work in it.
    ///
    /// git rejects a repository owned by another user — "dubious ownership" — and
    /// [`RepositoryType::Unsafe`](crate::rev_parse::RepositoryType::Unsafe) is how that is detected.
    /// This is the only remedy: the user has to vouch for the path. It is a *global* setting by
    /// necessity, since git won't read the repository's own config until it trusts it.
    ///
    /// Repeated calls are harmless — see [`GlobalConfig::add_if_missing`].
    pub async fn add_safe_directory(&self, path: &str) -> Result<(), GitError> {
        self.add_if_missing("safe.directory", &safe_directory_value(path))
            .await
    }

    /// Appends a global config value unless an identical one is already there.
    ///
    /// # UPSTREAM BUG: a path containing a regex metacharacter made this fail
    ///
    /// The existence test is `git config --get-all <name> <value>`, where that last argument is a
    /// **value-pattern** — a regular expression, unless `--fixed-value` is passed. The original didn't
    /// pass it, so a value like `/home/me/app (old)` made git exit **6** with `invalid pattern`; the
    /// original accepted only exit 0 and 1, so the call failed outright.
    ///
    /// That was reachable: `addSafeDirectory` is what recovers an unsafe repository, and a directory
    /// name containing `(`, `[`, `*`, `+` or `?` is perfectly ordinary — so a user could be left unable
    /// to open a repository at all, with no way to fix it from the app. Verified against real git. See
    /// `MIGRATION_MAP.md` §8.
    ///
    /// `--fixed-value` also makes the comparison exact, which is what the original did afterwards in
    /// JavaScript (`stdout.split('\0').includes(value)`) to compensate for the pattern possibly
    /// matching a *different* value. git does it now, so the exit code alone is the answer.
    pub async fn add_if_missing(&self, name: &str, value: &str) -> Result<(), GitError> {
        let output = git(
            &[
                "config",
                "--global",
                "-z",
                "--get-all",
                "--fixed-value",
                name,
                value,
            ],
            std::env::temp_dir(),
            "addGlobalConfigValueIfMissing",
            GitOptions {
                env: self.env(),
                ..GitOptions::default()
            }
            // 1 means "no such entry", which is the whole question being asked.
            .with_success_exit_codes([1]),
        )
        .await?;

        if output.exit_code == 0 {
            return Ok(());
        }

        self.add(name, value).await
    }

    /// Appends a global config value without replacing existing entries.
    pub async fn add(&self, name: &str, value: &str) -> Result<(), GitError> {
        git(
            &["config", "--global", "--add", name, value],
            std::env::temp_dir(),
            "addGlobalConfigValue",
            GitOptions {
                env: self.env(),
                ..GitOptions::default()
            },
        )
        .await?;

        Ok(())
    }
}

/// The value to store in `safe.directory` for `path`.
///
/// A no-op on Unix. On Windows a UNC path (`//server/share/...`) has to be written as
/// `%(prefix)//server/share/...`, because git otherwise resolves it relative to its own installation
/// prefix — see git-for-windows commit `e394a16`. Kept for parity even though Linux is the primary
/// target: it is three lines, and losing it would be a silent misconfiguration rather than an error.
#[cfg(not(windows))]
fn safe_directory_value(path: &str) -> String {
    path.to_owned()
}

#[cfg(windows)]
fn safe_directory_value(path: &str) -> String {
    if path.starts_with('/') {
        format!("%(prefix)/{path}")
    } else {
        path.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{empty_repository, fixture_repository};

    /// A `GlobalConfig` pointed at a temp HOME, returned with the guard that owns it.
    ///
    /// The stub config is not empty: it clears `safe.directory`, because a **system-wide
    /// `safe.directory = *`** suppresses git's dubious-ownership check entirely — and CI images set one,
    /// which is why `vouching_for_a_repository_makes_git_work_in_it` passed locally and failed there. An
    /// empty value resets the list, so the check applies again. `rev_parse.rs` needs the same stub for the
    /// same reason.
    ///
    /// Invisible to the other tests here: `all_values` filters empty entries out.
    fn isolated_global() -> (GlobalConfig, tempfile::TempDir) {
        let home = tempfile::tempdir().expect("failed to create a temporary HOME");
        std::fs::write(home.path().join(".gitconfig"), "[safe]\ndirectory=\n")
            .expect("failed to write the stub config");
        let config = GlobalConfig::with_home(home.path());
        (config, home)
    }

    // --- repository config ---

    #[tokio::test]
    async fn looks_up_config_values() {
        let repo = fixture_repository("test-repo").await;
        let bare = get_config_value(repo.path(), "core.bare", false)
            .await
            .expect("reading core.bare should succeed");
        assert_eq!(bare.as_deref(), Some("false"));
    }

    #[tokio::test]
    async fn returns_none_for_undefined_values() {
        let repo = fixture_repository("test-repo").await;
        let value = get_config_value(repo.path(), "core.the-meaning-of-life", false)
            .await
            .expect("an unset key is not an error");
        assert_eq!(value, None);
    }

    #[tokio::test]
    async fn sets_and_removes_a_repository_value() {
        let repo = empty_repository().await;
        set_config_value(repo.path(), "desktop.test", "hello")
            .await
            .expect("setting should succeed");
        assert_eq!(
            get_config_value(repo.path(), "desktop.test", true)
                .await
                .expect("reading should succeed")
                .as_deref(),
            Some("hello")
        );

        remove_config_value(repo.path(), "desktop.test")
            .await
            .expect("removing should succeed");
        assert_eq!(
            get_config_value(repo.path(), "desktop.test", true)
                .await
                .expect("reading should succeed"),
            None
        );
    }

    #[tokio::test]
    async fn replaces_rather_than_appends_when_setting() {
        let repo = empty_repository().await;
        set_config_value(repo.path(), "desktop.test", "first")
            .await
            .expect("first set should succeed");
        set_config_value(repo.path(), "desktop.test", "second")
            .await
            .expect("second set should succeed");

        // --replace-all means one entry remains, so --get can't fail with "multiple values".
        let all = git(
            &["config", "--get-all", "desktop.test"],
            repo.path(),
            "test",
            GitOptions::default(),
        )
        .await
        .expect("get-all should succeed")
        .stdout_trimmed();
        assert_eq!(all, "second");
    }

    #[tokio::test]
    async fn only_local_ignores_global_values() {
        let repo = empty_repository().await;
        let (global, _home) = isolated_global();
        global
            .set("desktop.onlyglobal", "from-global")
            .await
            .expect("setting global should succeed");

        // The repository has no such key locally. A --local lookup must not see the global one.
        let local = get_config_value(repo.path(), "desktop.onlyglobal", true)
            .await
            .expect("reading should succeed");
        assert_eq!(local, None);
    }

    #[tokio::test]
    async fn preserves_values_containing_newlines() {
        // The reason the implementation passes -z: without it the value would be truncated at the
        // first newline.
        let repo = empty_repository().await;
        set_config_value(repo.path(), "desktop.multiline", "one\ntwo")
            .await
            .expect("setting should succeed");

        let value = get_config_value(repo.path(), "desktop.multiline", true)
            .await
            .expect("reading should succeed");
        assert_eq!(value.as_deref(), Some("one\ntwo"));
    }

    // --- global config ---

    #[tokio::test]
    async fn global_set_replaces_all_entries() {
        let (global, _home) = isolated_global();
        global
            .add("foo.bar", "first")
            .await
            .expect("add should work");
        global
            .add("foo.bar", "second")
            .await
            .expect("add should work");

        global
            .set("foo.bar", "the correct value")
            .await
            .expect("set should work");
        assert_eq!(
            global
                .get("foo.bar")
                .await
                .expect("get should work")
                .as_deref(),
            Some("the correct value")
        );
    }

    #[tokio::test]
    async fn global_get_returns_none_when_unset() {
        let (global, _home) = isolated_global();
        assert_eq!(
            global
                .get("foo.definitely-not-set")
                .await
                .expect("an unset key is not an error"),
            None
        );
    }

    #[tokio::test]
    async fn global_remove_deletes_the_key() {
        let (global, _home) = isolated_global();
        global
            .set("foo.bar", "value")
            .await
            .expect("set should work");
        global.remove("foo.bar").await.expect("remove should work");
        assert_eq!(global.get("foo.bar").await.expect("get should work"), None);
    }

    #[tokio::test]
    async fn interprets_git_boolean_spellings() {
        // The original had one test per spelling; git's own canonicalization is what's being
        // relied on, so a table keeps that coverage without eight near-identical tests.
        let (global, _home) = isolated_global();

        for falsey in ["false", "off", "no", "0"] {
            global
                .set("foo.bar", falsey)
                .await
                .expect("set should work");
            assert_eq!(
                global
                    .get_boolean("foo.bar")
                    .await
                    .expect("get should work"),
                Some(false),
                "expected {falsey:?} to be false"
            );
        }

        for truthy in ["true", "on", "yes", "1"] {
            global
                .set("foo.bar", truthy)
                .await
                .expect("set should work");
            assert_eq!(
                global
                    .get_boolean("foo.bar")
                    .await
                    .expect("get should work"),
                Some(true),
                "expected {truthy:?} to be true"
            );
        }
    }

    #[tokio::test]
    async fn boolean_lookup_returns_none_when_unset() {
        let (global, _home) = isolated_global();
        assert_eq!(
            global
                .get_boolean("foo.not-set")
                .await
                .expect("an unset key is not an error"),
            None
        );
    }

    #[tokio::test]
    async fn isolated_home_does_not_touch_the_real_global_config() {
        // Guards the isolation itself: two different homes must not see each other's values.
        let (a, _home_a) = isolated_global();
        let (b, _home_b) = isolated_global();

        a.set("desktop.isolation", "a")
            .await
            .expect("set should work");
        assert_eq!(
            b.get("desktop.isolation").await.expect("get should work"),
            None,
            "a value written with one HOME must not be visible under another"
        );
    }
    // --- safe.directory ---

    /// Every value the global config holds for `name`, in file order.
    ///
    /// `--get-all`, because `GlobalConfig::get` returns only the *last* value of a multi-valued key —
    /// that is git's own behaviour, and it is exactly what these tests must not rely on.
    async fn all_values(config: &GlobalConfig, home: &Path, name: &str) -> Vec<String> {
        let output = git(
            &["config", "--global", "-z", "--get-all", name],
            std::env::temp_dir(),
            "test",
            GitOptions {
                env: config.env(),
                ..GitOptions::default()
            }
            .with_success_exit_codes([1]),
        )
        .await
        .expect("reading should succeed");

        assert!(home.exists(), "the isolated HOME must outlive the read");

        output
            .stdout_lossy()
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect()
    }

    #[tokio::test]
    async fn adds_a_path_to_safe_directory() {
        let (config, home) = isolated_global();

        config
            .add_safe_directory("/repos/borrowed")
            .await
            .expect("adding should succeed");

        assert_eq!(
            all_values(&config, home.path(), "safe.directory").await,
            vec!["/repos/borrowed".to_owned()]
        );
    }

    #[tokio::test]
    async fn adding_the_same_path_twice_stores_it_once() {
        // The user may hit "add" more than once, and `safe.directory` is append-only — without the
        // existence test the file would grow a duplicate entry every time.
        let (config, home) = isolated_global();

        for _ in 0..3 {
            config
                .add_safe_directory("/repos/borrowed")
                .await
                .expect("adding should succeed");
        }

        assert_eq!(
            all_values(&config, home.path(), "safe.directory").await,
            vec!["/repos/borrowed".to_owned()]
        );
    }

    #[tokio::test]
    async fn keeps_the_paths_already_vouched_for() {
        let (config, home) = isolated_global();
        config
            .add_safe_directory("/repos/first")
            .await
            .expect("adding should succeed");

        config
            .add_safe_directory("/repos/second")
            .await
            .expect("adding should succeed");

        assert_eq!(
            all_values(&config, home.path(), "safe.directory").await,
            vec!["/repos/first".to_owned(), "/repos/second".to_owned()],
            "adding one path must not replace another"
        );
    }

    #[tokio::test]
    async fn adds_a_path_containing_regex_metacharacters() {
        // UPSTREAM BUG FIX. `--get-all <name> <value>` treats the value as a *pattern*, so `(` made git
        // exit 6 with "invalid pattern" — an exit code the original didn't accept, so recovering an
        // unsafe repository whose path contained one was impossible. `--fixed-value` is the fix.
        let (config, home) = isolated_global();
        let awkward = "/repos/app (old) [backup] +v2?";

        config
            .add_safe_directory(awkward)
            .await
            .expect("a directory name is not a regular expression");

        assert_eq!(
            all_values(&config, home.path(), "safe.directory").await,
            vec![awkward.to_owned()]
        );

        // And the existence test must still recognise it, or a second attempt would duplicate it.
        config
            .add_safe_directory(awkward)
            .await
            .expect("adding should succeed");
        assert_eq!(
            all_values(&config, home.path(), "safe.directory")
                .await
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn does_not_confuse_one_path_with_a_similar_one() {
        // What `--fixed-value` guarantees beyond not crashing: `.` in a pattern matches any character,
        // so `/repos/a.b` would otherwise be considered already present when only `/repos/axb` is.
        let (config, home) = isolated_global();
        config
            .add_safe_directory("/repos/axb")
            .await
            .expect("adding should succeed");

        config
            .add_safe_directory("/repos/a.b")
            .await
            .expect("adding should succeed");

        assert_eq!(
            all_values(&config, home.path(), "safe.directory").await,
            vec!["/repos/axb".to_owned(), "/repos/a.b".to_owned()],
            "these are different directories and both must be vouched for"
        );
    }

    #[tokio::test]
    async fn add_if_missing_works_for_any_key() {
        // `safe.directory` is the caller that matters, but the helper is upstream's and general.
        let (config, home) = isolated_global();

        config
            .add_if_missing("desktop.list", "one")
            .await
            .expect("adding should succeed");
        config
            .add_if_missing("desktop.list", "one")
            .await
            .expect("adding should succeed");
        config
            .add_if_missing("desktop.list", "two")
            .await
            .expect("adding should succeed");

        assert_eq!(
            all_values(&config, home.path(), "desktop.list").await,
            vec!["one".to_owned(), "two".to_owned()],
            "the duplicate is skipped and the new value appended"
        );
    }

    #[tokio::test]
    async fn the_isolated_home_restores_the_ownership_check() {
        // Guards the guard: if a system-wide `safe.directory = *` went unneutralized, the test below would
        // pass vacuously — git would never have refused the repository in the first place. This asserts the
        // refusal happens *before* anything is vouched for, which is the premise that test depends on.
        let repo = empty_repository().await;
        let (config, _home) = isolated_global();
        let mut env = config.env();
        env.insert("GIT_TEST_ASSUME_DIFFERENT_OWNER".to_owned(), "1".to_owned());

        let refused = git(
            &["status", "--porcelain"],
            repo.path(),
            "test",
            GitOptions {
                env,
                ..GitOptions::default()
            },
        )
        .await;

        assert!(
            refused.is_err(),
            "the stub HOME must clear a system-wide safe.directory = *"
        );
    }

    #[tokio::test]
    async fn vouching_for_a_repository_makes_git_work_in_it() {
        // The end-to-end claim, rather than "a config entry was written": with a different owner
        // simulated, git refuses the repository until the path is vouched for.
        let repo = empty_repository().await;
        let (config, home) = isolated_global();
        let path = repo.path();
        let path_str = path.to_string_lossy().into_owned();

        let mut env = config.env();
        // What makes git treat the repository as someone else's without needing another user.
        env.insert("GIT_TEST_ASSUME_DIFFERENT_OWNER".to_owned(), "1".to_owned());

        let refused = git(
            &["status", "--porcelain"],
            &path,
            "test",
            GitOptions {
                env: env.clone(),
                ..GitOptions::default()
            },
        )
        .await;
        assert!(
            refused.is_err(),
            "git should refuse a repository owned by someone else"
        );

        config
            .add_safe_directory(&path_str)
            .await
            .expect("adding should succeed");

        git(
            &["status", "--porcelain"],
            &path,
            "test",
            GitOptions {
                env,
                ..GitOptions::default()
            },
        )
        .await
        .expect("git should work once the path is vouched for");

        assert!(home.path().exists());
    }

    #[test]
    fn a_posix_path_is_stored_as_given() {
        // The Windows branch prefixes a UNC path with `%(prefix)/`; there is nothing to do here.
        assert_eq!(safe_directory_value("/repos/borrowed"), "/repos/borrowed");
        assert_eq!(safe_directory_value("relative/path"), "relative/path");
    }
}
