// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "T142 implements the lifecycle actions")
)]
#![cfg_attr(
    test,
    expect(
        dead_code,
        reason = "the T142 stubs read no input until T142 implements them"
    )
)]

use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;

/// One shell lifecycle event (T142).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The service process exited.
    ServiceExited,
    /// The service process did not start (T063).
    StartFailed,
    /// The startup handshake failed or got no reply (T063).
    HandshakeFailed,
    /// The WebView2 `ProcessFailed` event with its `ProcessFailedKind`.
    ProcessFailed(COREWEBVIEW2_PROCESS_FAILED_KIND),
}

/// The native lifecycle dialogs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialog {
    /// "Git service stopped" with Restart service and Close Arbareto.
    ServiceStopped,
    /// Reload window and Close Arbareto.
    RendererExited,
    /// Restart Arbareto and Close Arbareto.
    BrowserExited,
}

/// The native steps of the lifecycle actions. T142 implements them in the shell.
pub trait Host {
    fn show(&self, dialog: Dialog);
    /// One log entry. It never holds user data.
    fn log(&self, entry: &str);
    /// Starts a new service process. False is a failed start.
    fn start_service(&self) -> bool;
    /// Sends the startup handshake with `restarted`. True when the handshake completes.
    fn handshake(&self, restarted: bool) -> bool;
    /// The `service-session` event to the main window (contract §2).
    fn send_service_session(&self);
    fn close_lingering_jobs(&self);
}

/// Maps one event to its action. No event restarts anything by itself.
pub fn handle(_host: &dyn Host, _event: Event) {
    todo!("T142")
}

/// Restart service. False when the start or the handshake fails.
pub fn restart_service(_host: &dyn Host) -> bool {
    todo!("T142")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
    };

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Call {
        Show(Dialog),
        Log,
        Start,
        Handshake(bool),
        Session,
        CloseLingering,
    }

    struct Recorder {
        calls: RefCell<Vec<Call>>,
        start: bool,
        handshake: bool,
    }

    impl Recorder {
        fn new(start: bool, handshake: bool) -> Recorder {
            Recorder {
                calls: RefCell::new(Vec::new()),
                start,
                handshake,
            }
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.borrow().clone()
        }
    }

    impl Host for Recorder {
        fn show(&self, dialog: Dialog) {
            self.calls.borrow_mut().push(Call::Show(dialog));
        }
        fn log(&self, _: &str) {
            self.calls.borrow_mut().push(Call::Log);
        }
        fn start_service(&self) -> bool {
            self.calls.borrow_mut().push(Call::Start);
            self.start
        }
        fn handshake(&self, restarted: bool) -> bool {
            self.calls.borrow_mut().push(Call::Handshake(restarted));
            self.handshake
        }
        fn send_service_session(&self) {
            self.calls.borrow_mut().push(Call::Session);
        }
        fn close_lingering_jobs(&self) {
            self.calls.borrow_mut().push(Call::CloseLingering);
        }
    }

    fn handled(event: Event) -> Vec<Call> {
        let host = Recorder::new(true, true);
        handle(&host, event);
        host.calls()
    }

    /// Research R7: these kinds need no shell action.
    const NO_ACTION: [COREWEBVIEW2_PROCESS_FAILED_KIND; 7] = [
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
    ];

    #[test]
    fn restart_service_sends_service_session_only_after_the_restarted_handshake() {
        let host = Recorder::new(true, true);
        assert!(restart_service(&host));
        assert_eq!(
            host.calls(),
            [Call::Start, Call::Handshake(true), Call::Session],
            "every lingering Job stays"
        );
    }

    #[test]
    fn a_failed_restart_start_or_handshake_sends_no_service_session() {
        let host = Recorder::new(false, true);
        assert!(!restart_service(&host));
        assert!(!host.calls().contains(&Call::Session));
        assert!(!host.calls().contains(&Call::CloseLingering));
        let host = Recorder::new(true, false);
        assert!(!restart_service(&host));
        assert!(!host.calls().contains(&Call::Session));
        assert!(!host.calls().contains(&Call::CloseLingering));
    }

    #[test]
    fn a_service_exit_and_a_failed_start_or_handshake_show_the_service_stopped_dialog() {
        for event in [
            Event::ServiceExited,
            Event::StartFailed,
            Event::HandshakeFailed,
        ] {
            assert_eq!(
                handled(event),
                [Call::Show(Dialog::ServiceStopped)],
                "{event:?}"
            );
        }
    }

    #[test]
    fn a_renderer_exit_shows_reload_window() {
        assert_eq!(
            handled(Event::ProcessFailed(
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
            )),
            [Call::Show(Dialog::RendererExited)]
        );
    }

    #[test]
    fn only_a_browser_process_exit_shows_restart_arbareto() {
        assert_eq!(
            handled(Event::ProcessFailed(
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            )),
            [Call::Show(Dialog::BrowserExited)]
        );
    }

    #[test]
    fn an_unknown_process_exit_shows_no_dialog_and_logs_once() {
        assert_eq!(
            handled(Event::ProcessFailed(
                COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED
            )),
            [Call::Log]
        );
    }

    #[test]
    fn the_other_process_kinds_cause_no_action() {
        for kind in NO_ACTION {
            assert_eq!(handled(Event::ProcessFailed(kind)), [], "{kind:?}");
        }
    }
}
