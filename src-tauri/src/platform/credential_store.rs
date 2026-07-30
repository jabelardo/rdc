use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use keyring::{credential::CredentialBuilder, Entry, Error as KeyringError};
use thiserror::Error;

type CredentialKey = (String, String);

#[derive(Debug, Error)]
pub enum CredentialStoreError {
    #[error("credential store failed: {0}")]
    Keyring(#[from] KeyringError),
    #[error("credential entry cache is poisoned")]
    Poisoned,
}

pub trait CredentialStore: Send + Sync {
    fn set(&self, service: &str, login: &str, value: &str) -> Result<(), CredentialStoreError>;
    fn get(&self, service: &str, login: &str) -> Result<Option<String>, CredentialStoreError>;
    fn delete(&self, service: &str, login: &str) -> Result<bool, CredentialStoreError>;
}

pub struct KeyringCredentialStore {
    builder: Box<CredentialBuilder>,
    operation_gate: Mutex<()>,
    // Keeping one entry per pair gives the crate's entry-local mock the same
    // lookup semantics as persistent production stores.
    entries: Mutex<HashMap<CredentialKey, Arc<Entry>>>,
}

impl KeyringCredentialStore {
    pub fn native() -> Self {
        Self::with_builder(keyring::default::default_credential_builder())
    }

    #[cfg(test)]
    fn mock() -> Self {
        Self::with_builder(keyring::mock::default_credential_builder())
    }

    fn with_builder(builder: Box<CredentialBuilder>) -> Self {
        Self {
            builder,
            operation_gate: Mutex::new(()),
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn entry(&self, service: &str, login: &str) -> Result<Arc<Entry>, CredentialStoreError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CredentialStoreError::Poisoned)?;
        let key = (service.to_owned(), login.to_owned());
        if let Some(entry) = entries.get(&key) {
            return Ok(Arc::clone(entry));
        }
        let credential = self.builder.build(None, service, login)?;
        let entry = Arc::new(Entry::new_with_credential(credential));
        entries.insert(key, Arc::clone(&entry));
        Ok(entry)
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn set(&self, service: &str, login: &str, value: &str) -> Result<(), CredentialStoreError> {
        let _guard = self
            .operation_gate
            .lock()
            .map_err(|_| CredentialStoreError::Poisoned)?;
        self.entry(service, login)?.set_password(value)?;
        Ok(())
    }

    fn get(&self, service: &str, login: &str) -> Result<Option<String>, CredentialStoreError> {
        let _guard = self
            .operation_gate
            .lock()
            .map_err(|_| CredentialStoreError::Poisoned)?;
        match self.entry(service, login)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn delete(&self, service: &str, login: &str) -> Result<bool, CredentialStoreError> {
        let _guard = self
            .operation_gate
            .lock()
            .map_err(|_| CredentialStoreError::Poisoned)?;
        match self.entry(service, login)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use keyring::{mock::MockCredential, Error as KeyringError};

    use super::{CredentialStore, KeyringCredentialStore};

    #[test]
    fn missing_overwrite_delete_and_pair_isolation_match_keytar() {
        let store = KeyringCredentialStore::mock();
        assert_eq!(store.get("service", "alice").expect("missing"), None);
        assert!(!store.delete("service", "alice").expect("missing delete"));

        store.set("service", "alice", "first").expect("set");
        store.set("service", "alice", "second").expect("overwrite");
        store.set("service", "bob", "other login").expect("set");
        store.set("other", "alice", "other service").expect("set");

        assert_eq!(
            store.get("service", "alice").expect("get").as_deref(),
            Some("second")
        );
        assert_eq!(
            store.get("service", "bob").expect("get").as_deref(),
            Some("other login")
        );
        assert_eq!(
            store.get("other", "alice").expect("get").as_deref(),
            Some("other service")
        );
        assert!(store.delete("service", "alice").expect("delete"));
        assert_eq!(store.get("service", "alice").expect("deleted"), None);
    }

    #[test]
    fn backend_failures_propagate_without_secret_values() {
        let store = KeyringCredentialStore::mock();
        let entry = store.entry("service", "alice").expect("entry");
        let mock = entry
            .get_credential()
            .downcast_ref::<MockCredential>()
            .expect("mock credential");
        mock.set_error(KeyringError::Invalid(
            "mock".to_owned(),
            "backend unavailable".to_owned(),
        ));

        let error = store
            .set("service", "alice", "do-not-log-this")
            .expect_err("backend failure")
            .to_string();
        assert!(error.contains("backend unavailable"));
        assert!(!error.contains("do-not-log-this"));
    }
}
