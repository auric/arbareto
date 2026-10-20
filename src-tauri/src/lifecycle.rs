// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
};

use crate::dialogs::{Button, Confirmation};

/// Custom button IDs stay clear of the common button IDs 1 to 11.
const ACTION: i32 = 100;
const CLOSE: i32 = 101;

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

/// The button that the user activated in a lifecycle dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    RestartService,
    ReloadWindow,
    RestartArbareto,
    CloseArbareto,
}

/// The native steps of the lifecycle actions.
/// No step closes a lingering Job, so Restart service keeps them all (contract §6 "Lingering Jobs").
pub trait Host {
    /// Shows the dialog and runs the action of its result. It never blocks the caller.
    fn show(&self, dialog: Dialog);
    /// One log entry. It never holds user data.
    fn log(&self, entry: &str);
    /// Starts a new service process. False is a failed start.
    fn start_service(&self) -> bool;
    /// Sends the startup handshake with `restarted`. True when the handshake completes.
    fn handshake(&self, restarted: bool) -> bool;
    /// The `service-session` event to the main window (contract §2).
    fn send_service_session(&self);
}

/// Maps one event to its action. No event restarts anything by itself (FR-023, research.md R7).
pub fn handle(host: &dyn Host, event: Event) {
    match event {
        Event::ServiceExited | Event::StartFailed | Event::HandshakeFailed => {
            host.show(Dialog::ServiceStopped);
        }
        Event::ProcessFailed(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED) => {
            host.show(Dialog::RendererExited);
        }
        Event::ProcessFailed(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) => {
            host.show(Dialog::BrowserExited);
        }
        Event::ProcessFailed(COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED) => {
            host.log("WebView2 ProcessFailed: UnknownProcessExited");
        }
        Event::ProcessFailed(_) => {}
    }
}

/// Restart service. A failed start or handshake shows the Git service stopped dialog again.
/// Every lingering Job stays (contract §6 "Lingering Jobs").
pub fn restart_service(host: &dyn Host) -> bool {
    if !host.start_service() {
        handle(host, Event::StartFailed);
        return false;
    }
    if !host.handshake(true) {
        handle(host, Event::HandshakeFailed);
        return false;
    }
    host.send_service_session();
    true
}

/// The native confirmation of one lifecycle dialog. The action button is the default.
pub fn confirmation(dialog: Dialog) -> Confirmation {
    let (text, action) = match dialog {
        Dialog::ServiceStopped => ("Git service stopped.", "Restart service"),
        Dialog::RendererExited => ("The window stopped.", "Reload window"),
        Dialog::BrowserExited => ("The window browser process stopped.", "Restart Arbareto"),
    };
    Confirmation {
        instruction: None,
        text: text.to_string(),
        details: None,
        buttons: vec![
            Button {
                id: ACTION,
                label: action,
            },
            Button {
                id: CLOSE,
                label: "Close Arbareto",
            },
        ],
        default_button: ACTION,
        accept_button: ACTION,
        shield: false,
    }
}

/// Only the action button gives its action. Every other result is Close Arbareto, as in T063:
/// Close Arbareto, Escape, Alt+F4, the close button, and a call failure.
pub fn action(dialog: Dialog, pressed: Option<i32>) -> Action {
    match (pressed, dialog) {
        (Some(ACTION), Dialog::ServiceStopped) => Action::RestartService,
        (Some(ACTION), Dialog::RendererExited) => Action::ReloadWindow,
        (Some(ACTION), Dialog::BrowserExited) => Action::RestartArbareto,
        _ => Action::CloseArbareto,
    }
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
    use windows::Win32::UI::WindowsAndMessaging::IDCANCEL;

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Call {
        Show(Dialog),
        Log,
        Start,
        Handshake(bool),
        Session,
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

    const DIALOGS: [Dialog; 3] = [
        Dialog::ServiceStopped,
        Dialog::RendererExited,
        Dialog::BrowserExited,
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
        assert_eq!(
            host.calls(),
            [Call::Start, Call::Show(Dialog::ServiceStopped)]
        );
        let host = Recorder::new(true, false);
        assert!(!restart_service(&host));
        assert_eq!(
            host.calls(),
            [
                Call::Start,
                Call::Handshake(true),
                Call::Show(Dialog::ServiceStopped)
            ]
        );
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

    #[test]
    fn each_dialog_offers_its_action_and_close_arbareto() {
        for (dialog, label) in [
            (Dialog::ServiceStopped, "Restart service"),
            (Dialog::RendererExited, "Reload window"),
            (Dialog::BrowserExited, "Restart Arbareto"),
        ] {
            let confirmation = confirmation(dialog);
            let labels: Vec<&str> = confirmation.buttons.iter().map(|b| b.label).collect();
            assert_eq!(labels, [label, "Close Arbareto"], "{dialog:?}");
            assert!(
                confirmation.buttons.iter().all(|b| b.id != IDCANCEL.0),
                "Escape activates no button"
            );
        }
        // plan.md "Required visible states", Component stopped.
        for (dialog, text) in [
            (Dialog::ServiceStopped, "Git service stopped."),
            (Dialog::RendererExited, "The window stopped."),
            (Dialog::BrowserExited, "The window browser process stopped."),
        ] {
            assert_eq!(confirmation(dialog).text, text, "{dialog:?}");
        }
    }

    #[test]
    fn only_the_action_button_gives_its_action() {
        for (dialog, expected) in [
            (Dialog::ServiceStopped, Action::RestartService),
            (Dialog::RendererExited, Action::ReloadWindow),
            (Dialog::BrowserExited, Action::RestartArbareto),
        ] {
            let confirmation = confirmation(dialog);
            assert_eq!(action(dialog, Some(confirmation.buttons[0].id)), expected);
            assert_eq!(
                action(dialog, Some(confirmation.default_button)),
                expected,
                "Enter on the default"
            );
        }
    }

    #[test]
    fn the_close_arbareto_button_closes() {
        for dialog in DIALOGS {
            let close = confirmation(dialog).buttons[1].id;
            assert_eq!(
                action(dialog, Some(close)),
                Action::CloseArbareto,
                "{dialog:?}"
            );
        }
    }

    #[test]
    fn escape_alt_f4_and_the_close_button_close() {
        // All three return `IDCANCEL` (TDF_ALLOW_DIALOG_CANCELLATION).
        for dialog in DIALOGS {
            assert_eq!(
                action(dialog, Some(IDCANCEL.0)),
                Action::CloseArbareto,
                "{dialog:?}"
            );
        }
    }

    #[test]
    fn a_failed_dialog_call_closes() {
        for dialog in DIALOGS {
            assert_eq!(action(dialog, None), Action::CloseArbareto, "{dialog:?}");
        }
    }
}
