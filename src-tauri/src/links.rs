// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

//! Feature 006 plan.md D12: `openLicenceLink` opens a catalog URL in the default browser.

use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{HSTRING, PCWSTR, w};

/// The Shell calls of one link. The tests inject a launcher that records each call.
pub trait Launcher: Sync {
    /// `CoInitializeEx`. False when the call fails.
    fn initialize(&self) -> bool;
    /// The return value of `ShellExecuteW`.
    fn execute(&self, url: &str) -> isize;
    fn uninitialize(&self);
}

/// The Windows Shell.
pub struct Shell;

impl Launcher for Shell {
    fn initialize(&self) -> bool {
        // SAFETY: `open` calls this first on its own new thread, and it pairs a success with `uninitialize`.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok()
    }

    fn execute(&self, url: &str) -> isize {
        // SAFETY: the strings live for the call. The return value is no handle (Microsoft Learn `ShellExecuteW`).
        let opened = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                &HSTRING::from(url),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        opened.0 as isize
    }

    fn uninitialize(&self) {
        // SAFETY: `initialize` succeeded on this thread.
        unsafe { CoUninitialize() }
    }
}

/// Opens `url` on a new thread with COM initialized, as Microsoft Learn `ShellExecuteW` asks.
/// True when `ShellExecuteW` returned a value above 32.
pub fn open(launcher: &dyn Launcher, url: &str) -> bool {
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                if !launcher.initialize() {
                    return false;
                }
                let opened = launcher.execute(url) > 32;
                launcher.uninitialize();
                opened
            })
            .join()
            .unwrap_or(false)
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::sync::Mutex;
    use std::thread::ThreadId;

    /// Records each call with its thread. `execute` returns `returned`.
    pub(crate) struct Recorder {
        pub(crate) initialized: bool,
        pub(crate) returned: isize,
        pub(crate) calls: Mutex<Vec<(String, ThreadId)>>,
    }

    impl Recorder {
        pub(crate) fn returning(returned: isize) -> Recorder {
            Recorder {
                initialized: true,
                returned,
                calls: Mutex::new(Vec::new()),
            }
        }

        pub(crate) fn steps(&self) -> Vec<String> {
            let calls = self.calls.lock().expect("calls");
            calls.iter().map(|(step, _)| step.clone()).collect()
        }

        fn record(&self, step: String) {
            let thread = std::thread::current().id();
            self.calls.lock().expect("calls").push((step, thread));
        }
    }

    impl Launcher for Recorder {
        fn initialize(&self) -> bool {
            self.record("CoInitializeEx".to_string());
            self.initialized
        }

        fn execute(&self, url: &str) -> isize {
            self.record(format!("ShellExecuteW {url}"));
            self.returned
        }

        fn uninitialize(&self) {
            self.record("CoUninitialize".to_string());
        }
    }

    const URL: &str = "https://raw.githubusercontent.com/wooorm/dictionaries/8cfea406b505e4d7df52d5a19bce525df98c54ab/dictionaries/uk/license";

    /// Microsoft Learn `ShellExecuteW`: COM is initialized on the calling thread before the call. A value above 32 is success.
    #[test]
    fn a_link_opens_on_its_own_thread_between_the_com_initialize_and_uninitialize() {
        for (returned, opened) in [(33, true), (42, true), (32, false), (2, false), (0, false)] {
            let launcher = Recorder::returning(returned);
            assert_eq!(open(&launcher, URL), opened, "{returned}");
            assert_eq!(
                launcher.steps(),
                [
                    "CoInitializeEx".to_string(),
                    format!("ShellExecuteW {URL}"),
                    "CoUninitialize".to_string()
                ],
                "{returned}"
            );
            let calls = launcher.calls.lock().expect("calls");
            let thread = calls[0].1;
            assert!(calls.iter().all(|(_, id)| *id == thread), "one thread");
            assert_ne!(thread, std::thread::current().id(), "a dedicated thread");
        }
    }

    #[test]
    fn a_failed_com_initialize_opens_nothing() {
        let launcher = Recorder {
            initialized: false,
            ..Recorder::returning(42)
        };
        assert!(!open(&launcher, URL));
        assert_eq!(launcher.steps(), ["CoInitializeEx"]);
    }
}
