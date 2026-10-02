// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The shell does not use these items yet. T037 removes this attribute.
#![allow(dead_code)]

use std::sync::Arc;

/// The label of the only window that may call the public operations (contract §1).
pub const MAIN_WINDOW: &str = "main";

/// Contract §3: the closed allowlist of public operations, as `src/contracts/operations.ts` lists them.
pub const OPERATIONS: [&str; 21] = [
    "getEnvironment",
    "chooseGit",
    "chooseRepository",
    "restoreWorkspace",
    "readWorkspace",
    "readHistory",
    "readComparison",
    "readTrust",
    "approveTrust",
    "revokeTrust",
    "applyHunk",
    "applyFile",
    "reviewCommit",
    "commit",
    "reviewSubmodules",
    "updateSubmodules",
    "cancel",
    "getOperation",
    "requestClose",
    "currentSession",
    "dismissRecoveryMarker",
];

/// What the shell does with one renderer request.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// The shell answers the renderer itself and writes no service frame.
    Answer(serde_json::Value),
    /// The shell wrote one `public` frame to the service.
    Forwarded,
    /// The caller is not the main local window. The invoke fails, and the shell forwards nothing.
    Denied,
}

/// A service frame body that reaches the main window.
#[derive(Debug, PartialEq)]
pub enum ToRenderer {
    Response(serde_json::Value),
    Progress(serde_json::Value),
}

/// Writes one frame body to the service.
pub type FrameSink = Arc<dyn Fn(String) + Send + Sync>;

pub struct Ipc {
    _private: (),
}

impl Ipc {
    pub fn new(_forward: FrameSink) -> Ipc {
        todo!("T037")
    }

    /// Sets the current service session. `None` means that no service session runs.
    pub fn set_session(&self, _session_id: Option<String>) {
        todo!("T037")
    }

    /// Checks the caller, the operation, and the encoded size, then answers or forwards one renderer request.
    /// `url` is the URL of the calling webview. The encoded size is the length of `serde_json::to_string(request)`.
    pub fn handle(&self, _window_label: &str, _url: &str, _request: &serde_json::Value) -> Outcome {
        todo!("T037")
    }
}

/// The renderer message of a service frame. A `process`, `mutation`, `trust`, or `handshake` frame gives `None`.
pub fn renderer_message(_frame_body: &str) -> Option<ToRenderer> {
    todo!("T037")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use serde_json::{Value, json};

    use crate::framing::{PUBLIC_FRAME_BODY_BYTES, PUBLIC_REQUEST_BYTES};

    // Pinned Tauri serves the bundled frontend on Windows at this origin (manager/mod.rs:335-338, webview/mod.rs:1966-1974).
    const LOCAL: &str = "http://tauri.localhost/";
    const REQUEST_ID: &str = "0f0f0f0f-0000-4000-8000-000000000001";

    fn ipc() -> (Ipc, Arc<Mutex<Vec<String>>>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink: FrameSink = {
            let frames = Arc::clone(&frames);
            Arc::new(move |body: String| frames.lock().expect("frames").push(body))
        };
        (Ipc::new(sink), frames)
    }

    fn request(operation: &str, payload: Value) -> Value {
        json!({ "version": 1, "sessionId": "0f0f0f0f-0000-4000-8000-0000000000aa", "requestId": REQUEST_ID, "operation": operation, "payload": payload })
    }

    fn rejected(code: &str) -> Outcome {
        Outcome::Answer(json!({ "requestId": REQUEST_ID, "state": "rejected", "code": code }))
    }

    #[test]
    fn a_request_from_a_remote_webview_or_another_window_is_denied() {
        let (ipc, frames) = ipc();
        let valid = request("getEnvironment", json!({}));
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &valid),
            Outcome::Forwarded,
            "the main local window"
        );
        assert_eq!(
            ipc.handle(MAIN_WINDOW, "https://tauri.localhost/index.html", &valid),
            Outcome::Forwarded,
            "the HTTPS form of the local origin"
        );
        for url in [
            "https://example.com/",
            "http://tauri.localhost.evil.example/",
            "http://evil.tauri.localhost/",
            "https://evil.example/tauri.localhost",
            "file:///C:/index.html",
        ] {
            assert_eq!(
                ipc.handle(MAIN_WINDOW, url, &valid),
                Outcome::Denied,
                "remote webview {url}"
            );
        }
        for label in ["settings", "Main", ""] {
            assert_eq!(
                ipc.handle(label, LOCAL, &valid),
                Outcome::Denied,
                "window {label:?}"
            );
        }
        assert_eq!(
            frames.lock().expect("frames").len(),
            2,
            "a denied request is never forwarded"
        );
    }

    #[test]
    fn an_operation_outside_the_allowlist_gets_unknown_operation() {
        let (ipc, frames) = ipc();
        for operation in [
            "runShell",
            "spawn",
            "readworkspace",
            "Commit",
            "__proto__",
            "process",
            "handshake",
        ] {
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &request(operation, json!({}))),
                rejected("UNKNOWN_OPERATION"),
                "{operation}"
            );
        }
        assert!(
            frames.lock().expect("frames").is_empty(),
            "nothing is forwarded"
        );
    }

    #[test]
    fn an_encoded_request_above_1_mib_gets_frame_limit_before_forwarding() {
        let (ipc, frames) = ipc();
        let empty = request("readWorkspace", json!({ "pad": "" }));
        let overhead = serde_json::to_string(&empty).expect("encode").len();
        let at_bound = request(
            "readWorkspace",
            json!({ "pad": "a".repeat(PUBLIC_REQUEST_BYTES - overhead) }),
        );
        assert_eq!(
            serde_json::to_string(&at_bound).expect("encode").len(),
            PUBLIC_REQUEST_BYTES
        );
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &at_bound),
            Outcome::Forwarded,
            "exactly 1 MiB"
        );
        let above = request(
            "readWorkspace",
            json!({ "pad": "a".repeat(PUBLIC_REQUEST_BYTES - overhead + 1) }),
        );
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &above),
            rejected("FRAME_LIMIT"),
            "1 MiB plus 1 byte"
        );
        let frames = frames.lock().expect("frames");
        assert_eq!(frames.len(), 1, "the oversized request is never forwarded");
        assert_eq!(frames[0].len(), PUBLIC_FRAME_BODY_BYTES);
        assert!(frames[0].starts_with(r#"{"kind":"public","request":"#));
    }

    #[test]
    fn process_mutation_trust_and_handshake_frames_never_reach_the_renderer() {
        for frame in [
            json!({ "kind": "process", "process": { "type": "output", "callId": REQUEST_ID, "stream": "stdout", "data": "YQ==" } }),
            json!({ "kind": "mutation", "mutation": { "type": "started", "callId": REQUEST_ID, "markerId": REQUEST_ID } }),
            json!({ "kind": "trust", "trust": { "type": "revoke", "callId": REQUEST_ID, "endedProcesses": 0 } }),
            json!({ "kind": "handshake", "handshake": { "sessionId": REQUEST_ID } }),
        ] {
            assert_eq!(renderer_message(&frame.to_string()), None, "{frame}");
        }
        assert_eq!(renderer_message("not JSON"), None);
        let response = json!({ "requestId": REQUEST_ID, "state": "succeeded", "result": {} });
        assert_eq!(
            renderer_message(&json!({ "kind": "public", "response": response }).to_string()),
            Some(ToRenderer::Response(response))
        );
        let progress = json!({ "operationId": REQUEST_ID, "phase": "running", "stalled": false });
        assert_eq!(
            renderer_message(&json!({ "kind": "public", "progress": progress }).to_string()),
            Some(ToRenderer::Progress(progress))
        );
    }

    #[test]
    fn current_session_is_answered_natively_and_no_initialization_script_carries_a_session() {
        let (ipc, frames) = ipc();
        let current = json!({ "version": 1, "requestId": REQUEST_ID, "operation": "currentSession", "payload": {} });
        ipc.set_session(Some("0f0f0f0f-0000-4000-8000-0000000000aa".to_string()));
        let Outcome::Answer(first) = ipc.handle(MAIN_WINDOW, LOCAL, &current) else {
            panic!("an answer")
        };
        assert_eq!(
            (first["requestId"].as_str(), first["state"].as_str()),
            (Some(REQUEST_ID), Some("succeeded"))
        );
        assert_eq!(
            first["result"]["sessionId"],
            "0f0f0f0f-0000-4000-8000-0000000000aa"
        );
        ipc.set_session(Some("0f0f0f0f-0000-4000-8000-0000000000bb".to_string()));
        let Outcome::Answer(after) = ipc.handle(MAIN_WINDOW, LOCAL, &current) else {
            panic!("an answer")
        };
        assert_eq!(
            after["result"]["sessionId"], "0f0f0f0f-0000-4000-8000-0000000000bb",
            "the new ID after a restart"
        );
        ipc.set_session(None);
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &current),
            rejected("SERVICE_UNAVAILABLE"),
            "without a service session"
        );
        assert!(
            frames.lock().expect("frames").is_empty(),
            "currentSession sends no service frame"
        );
        // Pinned Tauri sets initialization scripts only on builders (research.md R7 "Session delivery").
        let setters = [
            concat!("initialization", "_script"),
            concat!("js_init", "_script"),
        ];
        for entry in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src")).expect("src") {
            let path = entry.expect("entry").path();
            let text = std::fs::read_to_string(&path).expect("source");
            for setter in setters {
                assert!(!text.contains(setter), "{} calls {setter}", path.display());
            }
        }
    }
}
