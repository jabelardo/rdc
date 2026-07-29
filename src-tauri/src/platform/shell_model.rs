use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// An installed terminal application using the shape consumed by preferences and app-store.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundShell {
    pub shell: String,
    pub path: PathBuf,
    #[serde(rename = "bundleID", skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_args: Option<Vec<String>>,
}
