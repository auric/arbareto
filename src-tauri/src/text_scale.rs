// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::sync::atomic::{AtomicU64, Ordering};

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use windows::Foundation::TypedEventHandler;
use windows::UI::ViewManagement::UISettings;

use crate::ipc::{Ipc, MAIN_WINDOW};

/// The shell event of each `TextScaleFactorChanged` event (contract §2).
pub const EVENT: &str = "text-scale";
/// The `UISettings.TextScaleFactor` range (plan.md "Windows text size", contract §3).
const MIN: f64 = 1.0;
const MAX: f64 = 2.25;

/// The `UISettings.TextScaleFactor` read.
pub trait Source {
    fn read(&self) -> windows::core::Result<f64>;
}

/// The shell events to one window.
pub trait Sink {
    fn emit(&self, window: &str, event: &str, factor: f64);
}

/// A failed read or a value outside the contract range gives 1.
pub fn read(source: &dyn Source) -> f64 {
    source
        .read()
        .ok()
        .filter(|factor| (MIN..=MAX).contains(factor))
        .unwrap_or(MIN)
}

/// The latest factor that the shell read.
pub struct Current(AtomicU64);

impl Default for Current {
    fn default() -> Current {
        Current(AtomicU64::new(MIN.to_bits()))
    }
}

impl Current {
    pub fn get(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::Relaxed))
    }

    pub fn set(&self, factor: f64) {
        self.0.store(factor.to_bits(), Ordering::Relaxed);
    }
}

/// One `TextScaleFactorChanged` event: stores the new factor and sends it to the main window.
pub fn changed(source: &dyn Source, current: &Current, sink: &dyn Sink) {
    let factor = read(source);
    current.set(factor);
    sink.emit(MAIN_WINDOW, EVENT, factor);
}

/// The WinRT `UISettings` object. A failed activation is a failed read.
/// The subscription lives as long as this object.
pub struct Settings(windows::core::Result<UISettings>);

impl Source for Settings {
    fn read(&self) -> windows::core::Result<f64> {
        self.0.as_ref().map_err(Clone::clone)?.TextScaleFactor()
    }
}

impl Sink for AppHandle {
    fn emit(&self, window: &str, event: &str, factor: f64) {
        let _ = self.emit_to(window, event, factor);
    }
}

/// Reads the factor into `ipc` and subscribes to `TextScaleFactorChanged` (plan.md "Windows text size").
/// The caller keeps the result for the application life.
pub fn watch(ipc: Arc<Ipc>, app: AppHandle) -> Settings {
    let settings = Settings(UISettings::new());
    ipc.text_scale().set(read(&settings));
    if let Ok(ui) = &settings.0 {
        // The event can arrive on any thread.
        let handler = TypedEventHandler::new(move |sender: windows::core::Ref<UISettings>, _| {
            changed(&Settings(sender.ok().cloned()), ipc.text_scale(), &app);
            Ok(())
        });
        if let Err(error) = ui.TextScaleFactorChanged(&handler) {
            eprintln!("TextScaleFactorChanged: {error}");
        }
    }
    settings
}

/// The `currentSession` answer. Both results carry `textScale` (contract §3).
pub fn session_answer(request_id: &str, session_id: Option<&str>, factor: f64) -> Value {
    match session_id {
        Some(session_id) => json!({
            "requestId": request_id, "state": "succeeded",
            "result": { "sessionId": session_id, "textScale": factor },
        }),
        None => json!({
            "requestId": request_id, "state": "rejected", "code": "SERVICE_UNAVAILABLE",
            "result": { "textScale": factor },
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use windows::Win32::Foundation::E_FAIL;

    use super::*;
    use crate::ipc::MAIN_WINDOW;

    const REQUEST_ID: &str = "0f0f0f0f-0000-4000-8000-000000000001";
    const SESSION_ID: &str = "0f0f0f0f-0000-4000-8000-0000000000aa";

    struct Fixed(windows::core::Result<f64>);

    impl Source for Fixed {
        fn read(&self) -> windows::core::Result<f64> {
            self.0.clone()
        }
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, String, f64)>>);

    impl Sink for Recorder {
        fn emit(&self, window: &str, event: &str, factor: f64) {
            self.0
                .lock()
                .expect("events")
                .push((window.to_string(), event.to_string(), factor));
        }
    }

    #[test]
    fn a_read_inside_the_range_gives_its_value() {
        for value in [1.0, 1.5, 2.25] {
            assert_eq!(read(&Fixed(Ok(value))), value);
        }
    }

    #[test]
    fn a_failed_read_gives_1() {
        assert_eq!(read(&Fixed(Err(E_FAIL.into()))), 1.0);
    }

    #[test]
    fn a_value_outside_the_range_gives_1() {
        for value in [0.99, 2.2501, 0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(read(&Fixed(Ok(value))), 1.0, "{value}");
        }
    }

    #[test]
    fn an_unpackaged_process_reads_the_windows_factor() {
        let factor = Settings(UISettings::new()).read().expect("TextScaleFactor");
        assert!((MIN..=MAX).contains(&factor), "{factor}");
    }

    #[test]
    fn the_current_factor_starts_at_1() {
        assert_eq!(Current::default().get(), 1.0);
    }

    #[test]
    fn each_change_event_sends_one_text_scale_event_to_the_main_window() {
        let current = Current::default();
        let sink = Recorder::default();
        changed(&Fixed(Ok(1.5)), &current, &sink);
        assert_eq!(current.get(), 1.5);
        changed(&Fixed(Ok(2.25)), &current, &sink);
        changed(&Fixed(Err(E_FAIL.into())), &current, &sink);
        assert_eq!(current.get(), 1.0);
        assert_eq!(
            *sink.0.lock().expect("events"),
            [
                (MAIN_WINDOW.to_string(), EVENT.to_string(), 1.5),
                (MAIN_WINDOW.to_string(), EVENT.to_string(), 2.25),
                (MAIN_WINDOW.to_string(), EVENT.to_string(), 1.0),
            ]
        );
        assert_eq!(EVENT, "text-scale");
    }

    #[test]
    fn the_current_session_answer_carries_the_factor() {
        assert_eq!(
            session_answer(REQUEST_ID, Some(SESSION_ID), 1.75),
            json!({
                "requestId": REQUEST_ID, "state": "succeeded",
                "result": { "sessionId": SESSION_ID, "textScale": 1.75 },
            })
        );
    }

    #[test]
    fn the_service_unavailable_answer_carries_the_factor() {
        assert_eq!(
            session_answer(REQUEST_ID, None, 2.25),
            json!({
                "requestId": REQUEST_ID, "state": "rejected", "code": "SERVICE_UNAVAILABLE",
                "result": { "textScale": 2.25 },
            })
        );
    }
}
