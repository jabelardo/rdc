//! Security policy that cannot be expressed by subresource CSP directives.

/// Whether a URL may replace the application document in a webview.
pub(crate) fn is_allowed_navigation(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || (url.host_str() == Some("localhost") && url.port() == Some(1420))
        }
        "about" => {
            url.cannot_be_a_base()
                && url.path() == "blank"
                && url.query().is_none()
                && url.fragment().is_none()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_allowed_navigation;

    #[test]
    fn accepts_only_packaged_and_exact_development_document_origins() {
        for allowed in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://localhost:1420/",
            "http://localhost:1420/src/main.tsx",
            "about:blank",
        ] {
            assert!(
                is_allowed_navigation(&allowed.parse().expect("valid test URL")),
                "{allowed} should be an application-document origin"
            );
        }

        for rejected in [
            "https://example.com/",
            "http://localhost:1421/",
            "http://127.0.0.1:1420/",
            "http://localhost.evil.example:1420/",
            "file:///tmp/untrusted.html",
            "javascript:alert(1)",
            "data:text/html,untrusted",
            "rdc-blob://localhost/token",
        ] {
            assert!(
                !is_allowed_navigation(&rejected.parse().expect("valid test URL")),
                "{rejected} must not replace the application document"
            );
        }
    }
}
