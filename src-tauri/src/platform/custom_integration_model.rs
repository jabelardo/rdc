use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A user-configured editor or shell.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CustomIntegration {
    pub path: PathBuf,
    pub arguments: String,
    #[serde(rename = "bundleID")]
    pub bundle_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomIntegrationPathValidation {
    pub is_valid: bool,
    #[serde(rename = "bundleID", skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}
