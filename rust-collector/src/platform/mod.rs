#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::collect;
#[cfg(target_os = "windows")]
pub use windows::collect;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn collect(_exclude_pid: Option<u32>) -> Result<Vec<crate::model::WindowRecord>, String> {
    Err("active-window collection is supported on macOS and Windows only".into())
}
