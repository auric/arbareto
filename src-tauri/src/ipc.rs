// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use tauri::async_runtime::{Receiver, Sender, channel};
use tauri::{State, Webview};

use crate::framing::{PUBLIC_REQUEST_BYTES, public_request_body};
use crate::process_requests::{decode_strict, is_identifier};

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

/// Contract §3: the shell runs these first. Until T063 and T140 replace the stubs, each gives `SERVICE_UNAVAILABLE`.
const NATIVE_FIRST: [&str; 5] = [
    "requestClose",
    "chooseGit",
    "chooseRepository",
    "restoreWorkspace",
    "dismissRecoveryMarker",
];

/// Pinned Tauri serves the bundled frontend on Windows at this host (manager/mod.rs:335-338, webview/mod.rs:1966-1974).
const LOCAL_HOST: &str = "tauri.localhost";

/// What the shell does with one renderer request.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the tests check the request rules through handle")
)]
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

/// A forwarded request waits here for the service response with its `requestId`.
enum Submitted {
    Answer(Value),
    Waiting(Receiver<Value>),
    Denied,
}

#[derive(Default)]
struct Session {
    session_id: Option<String>,
    pending: HashMap<String, Sender<Value>>,
}

pub struct Ipc {
    forward: FrameSink,
    session: Mutex<Session>,
}

impl Ipc {
    pub fn new(forward: FrameSink) -> Ipc {
        Ipc {
            forward,
            session: Mutex::new(Session::default()),
        }
    }

    /// Sets the current service session. `None` means that no service session runs.
    /// Each request without a terminal response then ends as State unknown (contract §2).
    pub fn set_session(&self, session_id: Option<String>) {
        let mut session = self.session();
        if session_id.is_none() {
            for (request_id, waiting) in session.pending.drain() {
                let _ = waiting.try_send(
                    json!({ "requestId": request_id, "state": "unknown", "code": "STATE_UNKNOWN" }),
                );
            }
        }
        session.session_id = session_id;
    }

    /// Checks the caller, the operation, and the encoded size, then answers or forwards one renderer request.
    /// `url` is the URL of the calling webview. The encoded size is the length of `serde_json::to_string(request)`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the commands call submit, which handle wraps")
    )]
    pub fn handle(&self, window_label: &str, url: &str, request: &serde_json::Value) -> Outcome {
        match self.submit(window_label, url, request, None) {
            Submitted::Answer(answer) => Outcome::Answer(answer),
            Submitted::Waiting(_) => Outcome::Forwarded,
            Submitted::Denied => Outcome::Denied,
        }
    }

    /// Gives a service response to the request with its `requestId`. Other responses are dropped.
    pub fn deliver(&self, response: Value) {
        let waiting = response
            .get("requestId")
            .and_then(Value::as_str)
            .and_then(|request_id| self.session().pending.remove(request_id));
        if let Some(waiting) = waiting {
            let _ = waiting.try_send(response);
        }
    }

    fn session(&self) -> MutexGuard<'_, Session> {
        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `command` names the operation of the invoked command. Another operation in the envelope is refused.
    fn submit(&self, label: &str, url: &str, request: &Value, command: Option<&str>) -> Submitted {
        if label != MAIN_WINDOW || !is_local(url) {
            return Submitted::Denied;
        }
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| is_identifier(id));
        let reject = |code: &str| {
            Submitted::Answer(json!({ "requestId": request_id, "state": "rejected", "code": code }))
        };
        if !request.is_object() {
            return reject("INVALID_REQUEST");
        }
        let Some(operation) = request
            .get("operation")
            .and_then(Value::as_str)
            .filter(|operation| OPERATIONS.contains(operation))
        else {
            return reject("UNKNOWN_OPERATION");
        };
        let encoded = request.to_string();
        if encoded.len() > PUBLIC_REQUEST_BYTES {
            return reject("FRAME_LIMIT");
        }
        let Some(request_id) = request_id else {
            return reject("INVALID_REQUEST");
        };
        if command.is_some_and(|command| command != operation) {
            return reject("INVALID_REQUEST");
        }
        if operation == "currentSession" {
            return match &self.session().session_id {
                Some(session_id) => Submitted::Answer(json!({
                    "requestId": request_id, "state": "succeeded", "result": { "sessionId": session_id },
                })),
                None => reject("SERVICE_UNAVAILABLE"),
            };
        }
        if NATIVE_FIRST.contains(&operation) {
            return reject("SERVICE_UNAVAILABLE");
        }
        let (waiting, response) = channel(1);
        {
            let mut session = self.session();
            if session.pending.contains_key(request_id) {
                return reject("INVALID_REQUEST");
            }
            // Without a session the sender drops at once, so the invoke fails with SERVICE_UNAVAILABLE in the bridge.
            if session.session_id.is_some() {
                session.pending.insert(request_id.to_string(), waiting);
            }
        }
        if let Ok(body) = public_request_body(&encoded) {
            (self.forward)(body);
        }
        Submitted::Waiting(response)
    }
}

/// The local origin over `http` or `https`, without a port or user information.
fn is_local(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some(LOCAL_HOST)
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

/// The renderer message of a service frame. A `process`, `mutation`, `trust`, or `handshake` frame gives `None`.
pub fn renderer_message(frame_body: &str) -> Option<ToRenderer> {
    let Value::Object(mut frame) = decode_strict(frame_body)? else {
        return None;
    };
    if frame.len() != 2 || frame.get("kind").and_then(Value::as_str) != Some("public") {
        return None;
    }
    match (frame.remove("response"), frame.remove("progress")) {
        (Some(response @ Value::Object(_)), None) => Some(ToRenderer::Response(response)),
        (None, Some(progress)) if is_progress(&progress) => Some(ToRenderer::Progress(progress)),
        _ => None,
    }
}

/// Contract §2: the fields of a progress event. The shell drops any other shape.
const PROGRESS_FIELDS: [&str; 6] = [
    "requestId",
    "operationId",
    "state",
    "phase",
    "counters",
    "stalled",
];
const PROGRESS_STATES: [&str; 4] = ["accepted", "running", "cancel-requested", "reconciling"];

fn is_progress(progress: &Value) -> bool {
    let Value::Object(event) = progress else {
        return false;
    };
    let identifier = |key| {
        event
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(is_identifier)
    };
    identifier("requestId")
        && identifier("operationId")
        && event
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| PROGRESS_STATES.contains(&state))
        && event
            .get("counters")
            .and_then(Value::as_object)
            .is_some_and(|counters| counters.values().all(|count| count.as_u64().is_some()))
        && event.get("phase").is_none_or(Value::is_string)
        && event.get("stalled").is_none_or(Value::is_boolean)
        && event
            .keys()
            .all(|key| PROGRESS_FIELDS.contains(&key.as_str()))
}

const DENIED: &str = "denied";

/// Runs one command off the async workers, because a forward can wait on the service pipe.
async fn call(
    webview: Webview,
    ipc: &Arc<Ipc>,
    operation: &'static str,
    request: Value,
) -> Result<Value, &'static str> {
    let label = webview.label().to_string();
    let url = webview.url().map_err(|_| DENIED)?.to_string();
    let ipc = Arc::clone(ipc);
    let submitted = tauri::async_runtime::spawn_blocking(move || {
        ipc.submit(&label, &url, &request, Some(operation))
    })
    .await
    .map_err(|_| DENIED)?;
    match submitted {
        Submitted::Answer(answer) => Ok(answer),
        Submitted::Waiting(mut response) => response.recv().await.ok_or("SERVICE_UNAVAILABLE"),
        Submitted::Denied => Err(DENIED),
    }
}

// One command per contract §3 operation. Each name equals its entry in `COMMANDS` of `src-tauri/build.rs`.

#[tauri::command]
pub async fn get_environment(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "getEnvironment", request).await
}

#[tauri::command]
pub async fn choose_git(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "chooseGit", request).await
}

#[tauri::command]
pub async fn choose_repository(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "chooseRepository", request).await
}

#[tauri::command]
pub async fn restore_workspace(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "restoreWorkspace", request).await
}

#[tauri::command]
pub async fn read_workspace(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readWorkspace", request).await
}

#[tauri::command]
pub async fn read_history(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readHistory", request).await
}

#[tauri::command]
pub async fn read_comparison(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readComparison", request).await
}

#[tauri::command]
pub async fn read_trust(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readTrust", request).await
}

#[tauri::command]
pub async fn approve_trust(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "approveTrust", request).await
}

#[tauri::command]
pub async fn revoke_trust(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "revokeTrust", request).await
}

#[tauri::command]
pub async fn apply_hunk(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "applyHunk", request).await
}

#[tauri::command]
pub async fn apply_file(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "applyFile", request).await
}

#[tauri::command]
pub async fn review_commit(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "reviewCommit", request).await
}

#[tauri::command]
pub async fn commit(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "commit", request).await
}

#[tauri::command]
pub async fn review_submodules(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "reviewSubmodules", request).await
}

#[tauri::command]
pub async fn update_submodules(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "updateSubmodules", request).await
}

#[tauri::command]
pub async fn cancel(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "cancel", request).await
}

#[tauri::command]
pub async fn get_operation(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "getOperation", request).await
}

#[tauri::command]
pub async fn request_close(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "requestClose", request).await
}

#[tauri::command]
pub async fn current_session(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "currentSession", request).await
}

#[tauri::command]
pub async fn dismiss_recovery_marker(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Value,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "dismissRecoveryMarker", request).await
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
    const OPERATION_ID: &str = "0f0f0f0f-0000-4000-8000-000000000002";

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
        let progress = json!({ "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "running", "counters": {}, "stalled": false });
        assert_eq!(
            renderer_message(&json!({ "kind": "public", "progress": progress }).to_string()),
            Some(ToRenderer::Progress(progress))
        );
    }

    #[test]
    fn a_progress_event_outside_the_contract_shape_never_reaches_the_renderer() {
        let valid = json!({ "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "accepted", "phase": "fetch", "counters": { "index": 1 }, "stalled": true });
        assert_eq!(
            renderer_message(&json!({ "kind": "public", "progress": valid }).to_string()),
            Some(ToRenderer::Progress(valid.clone())),
            "the contract §2 shape"
        );
        let with = |key: &str, value: Value| {
            let mut event = valid.clone();
            event[key] = value;
            event
        };
        let without = |key: &str| {
            let mut event = valid.clone();
            event.as_object_mut().expect("object").remove(key);
            event
        };
        for (name, event) in [
            ("an unknown key", with("command", json!("git fetch"))),
            (
                "a malformed operationId",
                with("operationId", json!("op-1")),
            ),
            ("a missing requestId", without("requestId")),
            ("a missing operationId", without("operationId")),
            ("a missing state", without("state")),
            ("a terminal state", with("state", json!("succeeded"))),
            (
                "a negative counter",
                with("counters", json!({ "index": -1 })),
            ),
            (
                "a fractional counter",
                with("counters", json!({ "index": 1.5 })),
            ),
            ("a missing counters object", without("counters")),
            ("a non-boolean stalled", with("stalled", json!("yes"))),
            ("a non-string phase", with("phase", json!(1))),
        ] {
            assert_eq!(
                renderer_message(&json!({ "kind": "public", "progress": event }).to_string()),
                None,
                "{name}"
            );
        }
    }

    #[test]
    fn current_session_is_answered_natively_and_no_startup_script_carries_a_session() {
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
