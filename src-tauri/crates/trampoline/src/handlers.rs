//! The handlers: deciding what to tell git.
//!
//! Ported from `trampoline-askpass-handler.ts` and `trampoline-credential-helper.ts`, plus
//! `parseAddSSHHostPrompt` from `lib/ssh/ssh.ts`.
//!
//! # The seams
//!
//! Two decisions genuinely need things this crate doesn't own: which account applies (the accounts
//! store and OS keychain) and what the user says (the UI). They are the [`CredentialProvider`] and
//! [`AskpassResponder`] traits, so everything *around* those decisions — classifying the prompt,
//! honouring the no-prompting rule for background tasks, formatting the reply git parses — is
//! implemented and tested here rather than waiting on Phase 7.
//!
//! [`Decline`] implements both by refusing. That is what ships until the store and UI exist, and it is
//! the correct behaviour rather than a stub: declining makes git fall through to its own credential
//! helpers, so SSH agents, `~/.git-credentials` and the system credential manager keep working today.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::credential::Credential;
use crate::protocol::Command;
use crate::server::{handler, Handler};
use crate::session::SessionStore;

/// A boxed future.
///
/// The traits below are used as `dyn Trait`, and `async fn` in a trait isn't dyn-compatible, so the
/// futures are boxed by hand rather than pulling in `async-trait` for two traits.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A username and secret pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialAnswer {
    pub username: String,
    pub password: String,
}

/// Supplies and records credentials. Implemented by the app over the accounts store and keychain.
pub trait CredentialProvider: Send + Sync + 'static {
    /// A credential for `endpoint`, or `None` to decline.
    ///
    /// `username` is git's hint when it already knows which account it wants.
    fn lookup(
        &self,
        endpoint: String,
        username: Option<String>,
    ) -> BoxFuture<Option<CredentialAnswer>>;

    /// Records a credential that worked.
    fn store(&self, endpoint: String, answer: CredentialAnswer) -> BoxFuture<()>;

    /// Forgets a credential that failed.
    fn erase(&self, endpoint: String, username: String) -> BoxFuture<()>;
}

/// What OpenSSH told us about an unknown host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddSshHostPrompt {
    pub host: String,
    pub ip: String,
    pub key_type: String,
    pub fingerprint: String,
}

/// Answers SSH prompts. Implemented by the app over the keychain and UI.
pub trait AskpassResponder: Send + Sync + 'static {
    /// A stored passphrase for the key at `key_path`, or `None` to decline.
    fn ssh_key_passphrase(&self, key_path: String) -> BoxFuture<Option<String>>;

    /// A stored password for `username`, or `None` to decline.
    fn ssh_user_password(&self, username: String) -> BoxFuture<Option<String>>;

    /// Whether to trust an unknown host. `None` means "don't answer", leaving ssh to fail.
    fn confirm_ssh_host(&self, prompt: AddSshHostPrompt) -> BoxFuture<Option<bool>>;
}

/// Optional watchdog boundary around a prompt that may wait for user input.
#[derive(Clone)]
pub struct PromptWaitHooks {
    pub begin: Arc<dyn Fn() + Send + Sync>,
    pub end: Arc<dyn Fn() + Send + Sync>,
}

/// Declines everything.
///
/// The default until the accounts store and UI exist. Declining is *correct*, not a placeholder: git
/// then consults its own helpers, so SSH agents and system credential managers still work.
#[derive(Debug, Clone, Copy, Default)]
pub struct Decline;

impl CredentialProvider for Decline {
    fn lookup(&self, _: String, _: Option<String>) -> BoxFuture<Option<CredentialAnswer>> {
        Box::pin(async { None })
    }
    fn store(&self, _: String, _: CredentialAnswer) -> BoxFuture<()> {
        Box::pin(async {})
    }
    fn erase(&self, _: String, _: String) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

impl AskpassResponder for Decline {
    fn ssh_key_passphrase(&self, _: String) -> BoxFuture<Option<String>> {
        Box::pin(async { None })
    }
    fn ssh_user_password(&self, _: String) -> BoxFuture<Option<String>> {
        Box::pin(async { None })
    }
    fn confirm_ssh_host(&self, _: AddSshHostPrompt) -> BoxFuture<Option<bool>> {
        Box::pin(async { None })
    }
}

/// github.com's host key fingerprints, from
/// <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>.
///
/// # Why these differ from the original — a security fix
///
/// The original auto-accepted exactly one fingerprint,
/// `SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8`. **GitHub rotated that RSA host key in March
/// 2023**, after its private half was briefly exposed in a public repository, and it no longer appears
/// in GitHub's documented fingerprints (verified against the page above).
///
/// Keeping it had two consequences. The harmless one: github.com now presents a different key, so the
/// auto-accept never fired and users were prompted anyway. The one that matters: an attacker holding
/// the leaked private key could present the retired key to a client, and this code would have trusted
/// it **silently**, with no prompt — turning a rotated key back into a trusted one.
///
/// So the retired fingerprint is deliberately absent, and [`RETIRED_GITHUB_FINGERPRINTS`] exists to
/// keep a test asserting it is never accepted.
const GITHUB_FINGERPRINTS: [(&str, &str); 3] = [
    ("RSA", "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s"),
    (
        "ECDSA",
        "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    ),
    (
        "ED25519",
        "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    ),
];

/// Fingerprints that must never be auto-accepted.
///
/// GitHub's pre-2023 RSA key. See [`GITHUB_FINGERPRINTS`].
const RETIRED_GITHUB_FINGERPRINTS: [&str; 1] =
    ["SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8"];

/// Whether this is a github.com host key we can accept without asking.
///
/// The key type is compared case-insensitively because OpenSSH spells it `ED25519` in the prompt while
/// documentation writes `Ed25519`.
fn is_known_github_host_key(prompt: &AddSshHostPrompt) -> bool {
    if prompt.host != "github.com" {
        return false;
    }

    if RETIRED_GITHUB_FINGERPRINTS.contains(&prompt.fingerprint.as_str()) {
        return false;
    }

    GITHUB_FINGERPRINTS.iter().any(|(key_type, fingerprint)| {
        prompt.key_type.eq_ignore_ascii_case(key_type) && prompt.fingerprint == *fingerprint
    })
}

/// Extracts the host, IP, key type and fingerprint from OpenSSH's host-key confirmation prompt.
///
/// Ported from `parseAddSSHHostPrompt`, whose TypeScript version is deleted — its only consumer is
/// this handler, so the same fork `status-parser` and `diff-parser` settled applies again. The
/// *parsed* result is what crosses to the frontend when a prompt is needed, not the raw text.
///
/// The prompt's middle line varies — OpenSSH may add "but keys of different type are already known for
/// this host" or "This key is not known by any other names" — so the pattern anchors on the two lines
/// carrying data and tolerates whatever sits between them.
pub fn parse_add_ssh_host_prompt(prompt: &str) -> Option<AddSshHostPrompt> {
    // Hand-parsed rather than with a regex, because this crate also builds the `rdc-trampoline`
    // binary that git spawns for every credential call, and it deliberately keeps its dependencies
    // (and so its size and start-up cost) minimal. The steps below correspond one-to-one with the
    // original's pattern:
    //
    //   ^The authenticity of host '([^ ]+) \(([^)]+)\)' can't be established[^.]*\.\n
    //   ([^ ]+) key fingerprint is ([^.]+)\.

    let rest = prompt.strip_prefix("The authenticity of host '")?;

    // `'([^ ]+) \(([^)]+)\)'` — the host has no spaces, the address no closing paren.
    let (authority, rest) = rest.split_once("' can't be established")?;
    let (host, address) = authority.split_once(" (")?;
    let ip = address.strip_suffix(')')?;
    if host.contains(' ') || ip.contains(')') {
        return None;
    }

    // `[^.]*\.` — whatever OpenSSH added to this sentence, up to its full stop.
    let (_, rest) = rest.split_once('.')?;

    // The full stop must end the line.
    let rest = rest.strip_prefix('\n')?;

    // `([^ ]+) key fingerprint is ([^.]+)\.`
    let (key_type, rest) = rest.split_once(" key fingerprint is ")?;
    if key_type.contains(' ') || key_type.contains('\n') {
        return None;
    }
    // A fingerprint is `SHA256:` plus base64, neither of which contains a full stop.
    let (fingerprint, _) = rest.split_once('.')?;
    if fingerprint.is_empty() || fingerprint.contains('\n') {
        return None;
    }

    Some(AddSshHostPrompt {
        host: host.to_owned(),
        ip: ip.to_owned(),
        key_type: key_type.to_owned(),
        fingerprint: fingerprint.to_owned(),
    })
}

/// What git or ssh is asking for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskpassRequest {
    /// An unknown host's key needs confirming.
    HostAuthenticity(AddSshHostPrompt),
    /// An SSH key's passphrase.
    KeyPassphrase { key_path: String },
    /// A user's SSH password.
    UserPassword { username: String },
}

/// Classifies an askpass prompt, or `None` if it isn't one we answer.
///
/// The order matters and follows the original: the host-authenticity and passphrase prompts are
/// matched by prefix, and the user-password prompt by suffix — so it must be tried last, since the
/// others could otherwise end with the same text.
pub fn classify_askpass(prompt: &str) -> Option<AskpassRequest> {
    if prompt.starts_with("The authenticity of host ") {
        return parse_add_ssh_host_prompt(prompt).map(AskpassRequest::HostAuthenticity);
    }

    if prompt.starts_with("Enter passphrase for key ") {
        let key_path = prompt
            .strip_prefix("Enter passphrase for key '")?
            .strip_suffix("': ")?;
        return Some(AskpassRequest::KeyPassphrase {
            key_path: key_path.to_owned(),
        });
    }

    if prompt.ends_with("'s password: ") {
        let username = prompt.strip_suffix("'s password: ")?;
        // `.+@.+` in the original, so an empty or address-less username isn't a match.
        if !username.contains('@') || username.starts_with('@') || username.ends_with('@') {
            return None;
        }
        return Some(AskpassRequest::UserPassword {
            username: username.to_owned(),
        });
    }

    None
}

/// Builds the askpass handler.
///
/// Answers three prompts. In every case a **background task never prompts** — it may only use an
/// already-stored secret — because a scheduled fetch popping a password dialog is worse than the fetch
/// failing. That rule is enforced here rather than inside the responder, so an implementation cannot
/// forget it.
pub fn askpass_handler(responder: Arc<dyn AskpassResponder>, sessions: SessionStore) -> Handler {
    askpass_handler_with_wait(responder, sessions, None)
}

pub fn askpass_handler_with_wait(
    responder: Arc<dyn AskpassResponder>,
    sessions: SessionStore,
    wait_hooks: Option<PromptWaitHooks>,
) -> Handler {
    handler(move |command: Command| {
        let responder = Arc::clone(&responder);
        let sessions = sessions.clone();
        let wait_hooks = wait_hooks.clone();

        async move {
            // The original required exactly one parameter and answered nothing otherwise.
            let [prompt] = command.parameters.as_slice() else {
                return None;
            };

            let request = classify_askpass(prompt)?;
            let is_background = sessions.is_background_task(&command.token);

            match request {
                AskpassRequest::HostAuthenticity(prompt) => {
                    // A known-good github.com key is accepted without asking, even in a background
                    // task — that is the whole point of pinning the fingerprints.
                    if is_known_github_host_key(&prompt) {
                        return Some("yes".to_owned());
                    }

                    if is_background {
                        return None;
                    }

                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.begin)();
                    }
                    let answer = responder.confirm_ssh_host(prompt).await;
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.end)();
                    }
                    answer.map(|trust| if trust { "yes" } else { "no" }.to_owned())
                }

                AskpassRequest::KeyPassphrase { key_path } => {
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.begin)();
                    }
                    let stored = responder.ssh_key_passphrase(key_path).await;
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.end)();
                    }
                    if stored.is_some() || is_background {
                        return stored;
                    }
                    // Prompting for a passphrase we don't have is the responder's job once UI exists;
                    // declining here keeps ssh's own prompt from being bypassed silently.
                    None
                }

                AskpassRequest::UserPassword { username } => {
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.begin)();
                    }
                    let stored = responder.ssh_user_password(username).await;
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.end)();
                    }
                    if stored.is_some() || is_background {
                        return stored;
                    }
                    None
                }
            }
        }
    })
}

/// Builds the credential-helper handler.
///
/// Implements git's `get`/`store`/`erase`. `get` answers with a formatted credential or nothing;
/// `store` and `erase` always answer nothing, because git ignores their output.
///
/// A `get` that can't be answered records the endpoint on the session, which is what later lets
/// [`crate::session::is_cancelled_authentication`] tell "the user declined" apart from "this
/// environment was never interactive".
pub fn credential_helper_handler(
    provider: Arc<dyn CredentialProvider>,
    sessions: SessionStore,
) -> Handler {
    credential_helper_handler_with_wait(provider, sessions, None)
}

pub fn credential_helper_handler_with_wait(
    provider: Arc<dyn CredentialProvider>,
    sessions: SessionStore,
    wait_hooks: Option<PromptWaitHooks>,
) -> Handler {
    handler(move |command: Command| {
        let provider = Arc::clone(&provider);
        let sessions = sessions.clone();
        let wait_hooks = wait_hooks.clone();

        async move {
            let operation = command.parameters.first()?.clone();
            let input = Credential::parse(&command.stdin);
            let endpoint = input.url();

            match operation.as_str() {
                "get" => {
                    // git's own hint about which account it wants, when it has one.
                    let username = input
                        .get("username")
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned);

                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.begin)();
                    }
                    let lookup = provider.lookup(endpoint.clone(), username).await;
                    if let Some(wait_hooks) = &wait_hooks {
                        (wait_hooks.end)();
                    }
                    match lookup {
                        Some(answer) => {
                            // Built on top of what git sent, so fields it supplied (protocol, host,
                            // path, wwwauth) survive into the reply.
                            let mut reply = input.clone();
                            reply.set("username", answer.username);
                            reply.set("password", answer.password);
                            reply.format().ok()
                        }
                        None => {
                            sessions.set_rejected_endpoint(&command.token, &endpoint);
                            None
                        }
                    }
                }

                "store" => {
                    let (Some(username), Some(password)) =
                        (input.get("username"), input.get("password"))
                    else {
                        // Nothing to store, and not an error worth reporting to git.
                        return None;
                    };

                    provider
                        .store(
                            input.url_without_credentials(),
                            CredentialAnswer {
                                username: username.to_owned(),
                                password: password.to_owned(),
                            },
                        )
                        .await;
                    None
                }

                "erase" => {
                    let username = input.get("username")?.to_owned();
                    provider
                        .erase(input.url_without_credentials(), username)
                        .await;
                    None
                }

                // git may add operations; answering nothing is the documented way to opt out.
                _ => None,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::CommandIdentifier;
    use crate::token::TokenStore;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn host_prompt(key_type: &str, fingerprint: &str) -> AddSshHostPrompt {
        AddSshHostPrompt {
            host: "github.com".to_owned(),
            ip: "140.82.121.4".to_owned(),
            key_type: key_type.to_owned(),
            fingerprint: fingerprint.to_owned(),
        }
    }

    // --- github.com fingerprint pinning ---

    #[test]
    fn accepts_githubs_current_host_keys() {
        for (key_type, fingerprint) in GITHUB_FINGERPRINTS {
            assert!(
                is_known_github_host_key(&host_prompt(key_type, fingerprint)),
                "{key_type} should be accepted"
            );
        }
    }

    #[test]
    fn never_accepts_githubs_retired_rsa_key() {
        // The security fix. GitHub rotated this key in March 2023 after its private half was exposed;
        // the original auto-accepted it, so an attacker holding the leaked key would have been trusted
        // silently. See GITHUB_FINGERPRINTS.
        for fingerprint in RETIRED_GITHUB_FINGERPRINTS {
            assert!(
                !is_known_github_host_key(&host_prompt("RSA", fingerprint)),
                "the retired key must never be auto-accepted"
            );
        }
    }

    #[test]
    fn matches_the_key_type_case_insensitively() {
        // OpenSSH prints ED25519; the documentation writes Ed25519.
        assert!(is_known_github_host_key(&host_prompt(
            "ED25519",
            "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
        )));
        assert!(is_known_github_host_key(&host_prompt(
            "ed25519",
            "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
        )));
    }

    #[test]
    fn does_not_accept_a_fingerprint_for_the_wrong_key_type() {
        // Pairing matters: presenting the Ed25519 fingerprint as an RSA key is not github.com.
        assert!(!is_known_github_host_key(&host_prompt(
            "RSA",
            "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
        )));
    }

    #[test]
    fn does_not_accept_another_host_even_with_a_matching_fingerprint() {
        let mut prompt = host_prompt("RSA", GITHUB_FINGERPRINTS[0].1);
        prompt.host = "github.com.evil.example".to_owned();
        assert!(!is_known_github_host_key(&prompt));
    }

    #[test]
    fn does_not_accept_an_unknown_fingerprint() {
        assert!(!is_known_github_host_key(&host_prompt(
            "RSA",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )));
    }

    // --- prompt parsing ---

    #[test]
    fn parses_a_host_authenticity_prompt() {
        let prompt = "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\nAre you sure you want to continue connecting (yes/no)? ";

        assert_eq!(
            parse_add_ssh_host_prompt(prompt),
            Some(AddSshHostPrompt {
                host: "github.com".to_owned(),
                ip: "140.82.121.4".to_owned(),
                key_type: "ED25519".to_owned(),
                fingerprint: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU".to_owned(),
            })
        );
    }

    #[test]
    fn parses_a_prompt_with_the_extra_middle_clause() {
        // OpenSSH varies this line, which is why the pattern tolerates text before the full stop.
        let prompt = "The authenticity of host 'example.com (1.2.3.4)' can't be established, but keys of different type are already known for this host.\nRSA key fingerprint is SHA256:abc.\n";

        let parsed = parse_add_ssh_host_prompt(prompt).expect("should parse");
        assert_eq!(parsed.host, "example.com");
        assert_eq!(parsed.key_type, "RSA");
    }

    // The four cases ported verbatim from `src/lib/ssh/ssh-host-prompt.test.ts`, which is deleted
    // along with the TypeScript parser.

    #[test]
    fn parses_the_github_prompt_from_the_original_suite() {
        // Note the fixture uses GitHub's *retired* RSA fingerprint, which is what the original
        // auto-accepted. Parsing it is still correct — it is the trusting that was wrong.
        let prompt = "The authenticity of host 'github.com (140.82.121.3)' can't be established.\nRSA key fingerprint is SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

        assert_eq!(
            parse_add_ssh_host_prompt(prompt),
            Some(AddSshHostPrompt {
                host: "github.com".to_owned(),
                ip: "140.82.121.3".to_owned(),
                key_type: "RSA".to_owned(),
                fingerprint: "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8".to_owned(),
            })
        );
    }

    #[test]
    fn parses_a_prompt_with_an_unfamiliar_key_type_and_fingerprint_format() {
        let prompt = "The authenticity of host 'my-domain.com (1.2.3.4)' can't be established.\nFAKE-TYPE key fingerprint is ThisIsAFakeFingerprintForTestingPurposes.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

        assert_eq!(
            parse_add_ssh_host_prompt(prompt),
            Some(AddSshHostPrompt {
                host: "my-domain.com".to_owned(),
                ip: "1.2.3.4".to_owned(),
                key_type: "FAKE-TYPE".to_owned(),
                fingerprint: "ThisIsAFakeFingerprintForTestingPurposes".to_owned(),
            })
        );
    }

    #[test]
    fn parses_a_prompt_whose_first_sentence_wraps_onto_a_second_line() {
        // The subtle one. "can't be established" is followed by a newline and then the rest of the
        // sentence, so the text before the full stop *contains* a newline. The original's `[^.]*`
        // matched it because a negated character class matches newlines; splitting on the first full
        // stop does the same.
        let prompt = "The authenticity of host 'my-domain.com (1.2.3.4)' can't be established\nbut keys of different type are already known for this host.\nFAKE-TYPE key fingerprint is ThisIsAFakeFingerprintForTestingPurposes.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

        assert_eq!(
            parse_add_ssh_host_prompt(prompt),
            Some(AddSshHostPrompt {
                host: "my-domain.com".to_owned(),
                ip: "1.2.3.4".to_owned(),
                key_type: "FAKE-TYPE".to_owned(),
                fingerprint: "ThisIsAFakeFingerprintForTestingPurposes".to_owned(),
            })
        );
    }

    #[test]
    fn parses_a_prompt_without_the_fingerprint_option() {
        let prompt = "The authenticity of host 'my-domain.com (1.2.3.4)' can't be established.\nFAKE-TYPE key fingerprint is ThisIsAFakeFingerprintForTestingPurposes.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no)? ";

        let parsed = parse_add_ssh_host_prompt(prompt).expect("should parse");
        assert_eq!(parsed.host, "my-domain.com");
        assert_eq!(
            parsed.fingerprint,
            "ThisIsAFakeFingerprintForTestingPurposes"
        );
    }

    #[test]
    fn rejects_text_that_is_not_a_host_prompt() {
        assert_eq!(parse_add_ssh_host_prompt("Enter passphrase: "), None);
        assert_eq!(parse_add_ssh_host_prompt(""), None);
    }

    // --- classification ---

    #[test]
    fn classifies_a_key_passphrase_prompt() {
        assert_eq!(
            classify_askpass("Enter passphrase for key '/home/me/.ssh/id_ed25519': "),
            Some(AskpassRequest::KeyPassphrase {
                key_path: "/home/me/.ssh/id_ed25519".to_owned()
            })
        );
    }

    #[test]
    fn classifies_a_user_password_prompt() {
        assert_eq!(
            classify_askpass("me@example.com's password: "),
            Some(AskpassRequest::UserPassword {
                username: "me@example.com".to_owned()
            })
        );
    }

    #[test]
    fn requires_an_at_sign_in_a_user_password_prompt() {
        // The original's regex was `^(.+@.+)'s password: `, so these are not matches.
        assert_eq!(classify_askpass("'s password: "), None);
        assert_eq!(classify_askpass("nobody's password: "), None);
        assert_eq!(classify_askpass("@example.com's password: "), None);
        assert_eq!(classify_askpass("me@'s password: "), None);
    }

    #[test]
    fn classifies_a_host_authenticity_prompt() {
        let prompt = "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nRSA key fingerprint is SHA256:abc.\n";
        assert!(matches!(
            classify_askpass(prompt),
            Some(AskpassRequest::HostAuthenticity(_))
        ));
    }

    #[test]
    fn does_not_classify_an_unrelated_prompt() {
        assert_eq!(classify_askpass("Something else entirely"), None);
    }

    // --- askpass handler ---

    /// Records what it was asked and answers from fixed values.
    struct Recording {
        passphrase: Option<String>,
        password: Option<String>,
        confirm: Option<bool>,
        asked: Arc<Mutex<Vec<String>>>,
    }

    impl AskpassResponder for Recording {
        fn ssh_key_passphrase(&self, key_path: String) -> BoxFuture<Option<String>> {
            self.asked
                .lock()
                .unwrap()
                .push(format!("passphrase:{key_path}"));
            let value = self.passphrase.clone();
            Box::pin(async move { value })
        }
        fn ssh_user_password(&self, username: String) -> BoxFuture<Option<String>> {
            self.asked
                .lock()
                .unwrap()
                .push(format!("password:{username}"));
            let value = self.password.clone();
            Box::pin(async move { value })
        }
        fn confirm_ssh_host(&self, prompt: AddSshHostPrompt) -> BoxFuture<Option<bool>> {
            self.asked
                .lock()
                .unwrap()
                .push(format!("confirm:{}", prompt.host));
            let value = self.confirm;
            Box::pin(async move { value })
        }
    }

    fn askpass_command(token: &str, prompt: &str) -> Command {
        Command {
            identifier: CommandIdentifier::AskPass,
            token: token.to_owned(),
            parameters: vec![prompt.to_owned()],
            environment: HashMap::new(),
            stdin: String::new(),
        }
    }

    /// A session store with one interactive and one background session.
    fn sessions_with_tokens() -> (
        SessionStore,
        TokenStore,
        crate::session::Session,
        crate::session::Session,
    ) {
        let sessions = SessionStore::new();
        let tokens = TokenStore::new();
        let interactive = sessions.begin(&tokens, "/repo", false);
        let background = sessions.begin(&tokens, "/repo", true);
        (sessions, tokens, interactive, background)
    }

    #[tokio::test]
    async fn accepts_a_known_github_key_without_asking() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let handler = askpass_handler(
            Arc::new(Recording {
                passphrase: None,
                password: None,
                confirm: Some(false),
                asked: Arc::clone(&asked),
            }),
            sessions,
        );

        let prompt = format!(
            "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is {}.\n",
            GITHUB_FINGERPRINTS[2].1
        );
        let answer = handler(askpass_command(interactive.token(), &prompt)).await;

        assert_eq!(answer.as_deref(), Some("yes"));
        assert!(
            asked.lock().unwrap().is_empty(),
            "a pinned key must not reach the responder"
        );
    }

    #[tokio::test]
    async fn asks_before_trusting_an_unknown_host() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = askpass_handler(
            Arc::new(Recording {
                passphrase: None,
                password: None,
                confirm: Some(true),
                asked: Arc::new(Mutex::new(Vec::new())),
            }),
            sessions,
        );

        let prompt = "The authenticity of host 'example.com (1.2.3.4)' can't be established.\nRSA key fingerprint is SHA256:unknown.\n";
        assert_eq!(
            handler(askpass_command(interactive.token(), prompt))
                .await
                .as_deref(),
            Some("yes")
        );
    }

    #[tokio::test]
    async fn answers_no_when_the_user_declines_a_host() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = askpass_handler(
            Arc::new(Recording {
                passphrase: None,
                password: None,
                confirm: Some(false),
                asked: Arc::new(Mutex::new(Vec::new())),
            }),
            sessions,
        );

        let prompt = "The authenticity of host 'example.com (1.2.3.4)' can't be established.\nRSA key fingerprint is SHA256:unknown.\n";
        assert_eq!(
            handler(askpass_command(interactive.token(), prompt))
                .await
                .as_deref(),
            Some("no")
        );
    }

    #[tokio::test]
    async fn never_prompts_for_an_unknown_host_in_a_background_task() {
        // The rule that matters most here: a scheduled fetch must not pop a dialog.
        let (sessions, _tokens, _interactive, background) = sessions_with_tokens();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let handler = askpass_handler(
            Arc::new(Recording {
                passphrase: None,
                password: None,
                confirm: Some(true),
                asked: Arc::clone(&asked),
            }),
            sessions,
        );

        let prompt = "The authenticity of host 'example.com (1.2.3.4)' can't be established.\nRSA key fingerprint is SHA256:unknown.\n";
        assert_eq!(
            handler(askpass_command(background.token(), prompt)).await,
            None
        );
        assert!(asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_background_task_may_still_use_a_stored_passphrase() {
        // Declining to *prompt* is not the same as declining to answer.
        let (sessions, _tokens, _interactive, background) = sessions_with_tokens();
        let handler = askpass_handler(
            Arc::new(Recording {
                passphrase: Some("stored".to_owned()),
                password: None,
                confirm: None,
                asked: Arc::new(Mutex::new(Vec::new())),
            }),
            sessions,
        );

        let answer = handler(askpass_command(
            background.token(),
            "Enter passphrase for key '/home/me/.ssh/id_ed25519': ",
        ))
        .await;

        assert_eq!(answer.as_deref(), Some("stored"));
    }

    #[tokio::test]
    async fn answers_a_stored_user_password() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let handler = askpass_handler(
            Arc::new(Recording {
                passphrase: None,
                password: Some("hunter2".to_owned()),
                confirm: None,
                asked: Arc::clone(&asked),
            }),
            sessions,
        );

        let answer = handler(askpass_command(
            interactive.token(),
            "me@example.com's password: ",
        ))
        .await;

        assert_eq!(answer.as_deref(), Some("hunter2"));
        assert_eq!(
            asked.lock().unwrap().as_slice(),
            ["password:me@example.com"]
        );
    }

    #[tokio::test]
    async fn answers_nothing_for_a_prompt_it_does_not_recognize() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = askpass_handler(Arc::new(Decline), sessions);

        assert_eq!(
            handler(askpass_command(interactive.token(), "Who goes there? ")).await,
            None
        );
    }

    #[tokio::test]
    async fn answers_nothing_when_given_the_wrong_number_of_parameters() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = askpass_handler(Arc::new(Decline), sessions);

        let mut command = askpass_command(interactive.token(), "x");
        command.parameters.clear();
        assert_eq!(handler(command.clone()).await, None);

        command.parameters = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(handler(command).await, None);
    }

    // --- credential helper handler ---

    #[derive(Default)]
    struct FakeProvider {
        answer: Option<CredentialAnswer>,
        stored: Arc<Mutex<Vec<(String, CredentialAnswer)>>>,
        erased: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl CredentialProvider for FakeProvider {
        fn lookup(&self, _: String, _: Option<String>) -> BoxFuture<Option<CredentialAnswer>> {
            let answer = self.answer.clone();
            Box::pin(async move { answer })
        }
        fn store(&self, endpoint: String, answer: CredentialAnswer) -> BoxFuture<()> {
            self.stored.lock().unwrap().push((endpoint, answer));
            Box::pin(async {})
        }
        fn erase(&self, endpoint: String, username: String) -> BoxFuture<()> {
            self.erased.lock().unwrap().push((endpoint, username));
            Box::pin(async {})
        }
    }

    fn credential_command(token: &str, operation: &str, stdin: &str) -> Command {
        Command {
            identifier: CommandIdentifier::CredentialHelper,
            token: token.to_owned(),
            parameters: vec![operation.to_owned()],
            environment: HashMap::new(),
            stdin: stdin.to_owned(),
        }
    }

    #[tokio::test]
    async fn answers_a_get_with_a_formatted_credential() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = credential_helper_handler(
            Arc::new(FakeProvider {
                answer: Some(CredentialAnswer {
                    username: "me".to_owned(),
                    password: "token".to_owned(),
                }),
                ..FakeProvider::default()
            }),
            sessions,
        );

        let answer = handler(credential_command(
            interactive.token(),
            "get",
            "protocol=https\nhost=github.com\n",
        ))
        .await
        .expect("should answer");

        // git's own fields survive, with the credential added.
        assert!(answer.contains("protocol=https\n"));
        assert!(answer.contains("host=github.com\n"));
        assert!(answer.contains("username=me\n"));
        assert!(answer.contains("password=token\n"));
    }

    #[tokio::test]
    async fn records_the_endpoint_when_a_get_cannot_be_answered() {
        // This is what later distinguishes "the user declined" from "never interactive".
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler =
            credential_helper_handler(Arc::new(FakeProvider::default()), sessions.clone());

        let answer = handler(credential_command(
            interactive.token(),
            "get",
            "protocol=https\nhost=github.com\n",
        ))
        .await;

        assert_eq!(answer, None);
        assert!(interactive.has_rejected_endpoints());
    }

    #[tokio::test]
    async fn stores_a_credential_under_the_endpoint_without_userinfo() {
        // Otherwise the same host would be stored twice, once per URL spelling.
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let stored = Arc::new(Mutex::new(Vec::new()));
        let handler = credential_helper_handler(
            Arc::new(FakeProvider {
                stored: Arc::clone(&stored),
                ..FakeProvider::default()
            }),
            sessions,
        );

        let answer = handler(credential_command(
            interactive.token(),
            "store",
            "url=https://me@github.com/o/r\nusername=me\npassword=token\n",
        ))
        .await;

        assert_eq!(answer, None, "git ignores the output of store");
        let stored = stored.lock().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0, "https://github.com/o/r");
        assert_eq!(stored[0].1.username, "me");
    }

    #[tokio::test]
    async fn ignores_a_store_missing_its_credential() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let stored = Arc::new(Mutex::new(Vec::new()));
        let handler = credential_helper_handler(
            Arc::new(FakeProvider {
                stored: Arc::clone(&stored),
                ..FakeProvider::default()
            }),
            sessions,
        );

        handler(credential_command(
            interactive.token(),
            "store",
            "protocol=https\nhost=github.com\n",
        ))
        .await;

        assert!(stored.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn erases_a_credential() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let erased = Arc::new(Mutex::new(Vec::new()));
        let handler = credential_helper_handler(
            Arc::new(FakeProvider {
                erased: Arc::clone(&erased),
                ..FakeProvider::default()
            }),
            sessions,
        );

        handler(credential_command(
            interactive.token(),
            "erase",
            "url=https://github.com/o/r\nusername=me\n",
        ))
        .await;

        assert_eq!(
            erased.lock().unwrap().as_slice(),
            [("https://github.com/o/r".to_owned(), "me".to_owned())]
        );
    }

    #[tokio::test]
    async fn ignores_an_operation_it_does_not_know() {
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = credential_helper_handler(Arc::new(FakeProvider::default()), sessions);

        assert_eq!(
            handler(credential_command(interactive.token(), "invent", "")).await,
            None
        );
    }

    #[tokio::test]
    async fn declining_by_default_answers_nothing() {
        // What ships until the accounts store exists: git then falls through to its own helpers.
        let (sessions, _tokens, interactive, _background) = sessions_with_tokens();
        let handler = credential_helper_handler(Arc::new(Decline), sessions);

        assert_eq!(
            handler(credential_command(
                interactive.token(),
                "get",
                "protocol=https\nhost=github.com\n"
            ))
            .await,
            None
        );
    }
}
