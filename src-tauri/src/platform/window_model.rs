use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WindowStartupAction {
    OpenRepository {
        path: String,
        #[serde(rename = "persistSelection")]
        persist_selection: bool,
    },
}

impl WindowStartupAction {
    pub fn open_repository(path: impl Into<String>) -> Self {
        Self::OpenRepository {
            path: path.into(),
            persist_selection: false,
        }
    }
}
