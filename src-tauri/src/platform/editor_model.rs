use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// An installed editor, using the field names the ported frontend already expects.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FoundEditor {
    pub editor: String,
    pub path: PathBuf,
}
