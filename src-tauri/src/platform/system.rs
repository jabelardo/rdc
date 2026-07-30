#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    fn NSBeep();
}

#[cfg(target_os = "macos")]
pub fn beep() {
    // SAFETY: NSBeep has no arguments or retained values and is the AppKit
    // primitive Electron's shell.beep() ultimately mirrors.
    unsafe { NSBeep() }
}

#[cfg(target_os = "macos")]
pub fn is_running_under_arm64_translation() -> bool {
    use std::{ffi::c_void, mem};

    let mut translated = 0_i32;
    let mut size = mem::size_of::<i32>();
    let name = c"sysctl.proc_translated";

    // SAFETY: both output pointers refer to initialized, correctly sized
    // stack values, and the key is a statically NUL-terminated C string.
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut translated as *mut i32).cast::<c_void>(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };

    translated_from_sysctl(result, translated)
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
// Non-macOS callers receive Maximize, but the shared wire contract must still
// describe every value a macOS frontend can receive.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum AppleActionOnDoubleClick {
    Maximize,
    Minimize,
    None,
}

#[cfg(any(target_os = "macos", test))]
fn apple_double_click_action(value: Option<&str>) -> AppleActionOnDoubleClick {
    match value.map(str::trim) {
        Some("Minimize") => AppleActionOnDoubleClick::Minimize,
        Some("None") => AppleActionOnDoubleClick::None,
        _ => AppleActionOnDoubleClick::Maximize,
    }
}

#[cfg(target_os = "macos")]
pub async fn get_apple_action_on_double_click() -> AppleActionOnDoubleClick {
    let output = tokio::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleActionOnDoubleClick"])
        .output()
        .await;
    let value = output
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    apple_double_click_action(value.as_deref())
}

#[cfg(not(target_os = "macos"))]
pub async fn get_apple_action_on_double_click() -> AppleActionOnDoubleClick {
    AppleActionOnDoubleClick::Maximize
}

#[cfg(not(target_os = "macos"))]
pub fn is_running_under_arm64_translation() -> bool {
    false
}

#[cfg(any(target_os = "macos", test))]
fn translated_from_sysctl(result: i32, value: i32) -> bool {
    result == 0 && value == 1
}

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "macos"))]
    use super::is_running_under_arm64_translation;
    use super::{apple_double_click_action, translated_from_sysctl, AppleActionOnDoubleClick};

    #[test]
    fn only_a_successful_true_sysctl_value_means_translation() {
        assert!(translated_from_sysctl(0, 1));
        assert!(!translated_from_sysctl(0, 0));
        assert!(!translated_from_sysctl(-1, 1));
    }

    #[test]
    fn apple_double_click_uses_only_the_two_special_values() {
        assert!(matches!(
            apple_double_click_action(Some("Minimize\n")),
            AppleActionOnDoubleClick::Minimize
        ));
        assert!(matches!(
            apple_double_click_action(Some("None")),
            AppleActionOnDoubleClick::None
        ));
        for value in [None, Some(""), Some("Maximize"), Some("unknown")] {
            assert!(matches!(
                apple_double_click_action(value),
                AppleActionOnDoubleClick::Maximize
            ));
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_platforms_do_not_claim_rosetta_translation() {
        assert!(!is_running_under_arm64_translation());
    }
}
