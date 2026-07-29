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
    use super::translated_from_sysctl;

    #[test]
    fn only_a_successful_true_sysctl_value_means_translation() {
        assert!(translated_from_sysctl(0, 1));
        assert!(!translated_from_sysctl(0, 0));
        assert!(!translated_from_sysctl(-1, 1));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_platforms_do_not_claim_rosetta_translation() {
        assert!(!is_running_under_arm64_translation());
    }
}
