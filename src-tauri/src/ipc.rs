// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use serde_json::{Value, json};
use tauri::async_runtime::{Receiver, Sender, channel};
use tauri::ipc::{InvokeBody, Request};
use tauri::{State, Webview};

use crate::close::{self, Decision};
use crate::framing::{PUBLIC_REQUEST_BYTES, public_request_body};
use crate::process_requests::{decode_strict, is_identifier};
use crate::schema;
use crate::text_scale::{self, Current};

/// The label of the only window that may call the public operations (contract §1).
pub const MAIN_WINDOW: &str = "main";

/// Contract §3: the closed allowlist of public operations, as `src/contracts/operations.ts` lists them.
pub const OPERATIONS: [&str; 22] = [
    "getEnvironment",
    "chooseGit",
    "chooseRepository",
    "restoreWorkspace",
    "readWorkspace",
    "readEntries",
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

/// Contract §3: the shell runs these first. The shell answers `requestClose` itself and never forwards it.
const NATIVE_FIRST: [&str; 5] = [
    "requestClose",
    "chooseGit",
    "chooseRepository",
    "restoreWorkspace",
    "dismissRecoveryMarker",
];

/// Pinned Tauri serves the bundled frontend on Windows at this host (manager/mod.rs:335-338, webview/mod.rs:1966-1974).
const LOCAL_HOST: &str = "tauri.localhost";

const INVALID: &str = "INVALID_REQUEST";

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

/// Writes one frame body to the service. False means that the service did not get the whole frame.
pub type FrameSink = Arc<dyn Fn(String) -> bool + Send + Sync>;

/// The result of the native step before the forward.
#[derive(Debug, PartialEq)]
pub struct Prepared {
    /// The service payload.
    pub payload: Value,
    /// The path of the native context. The service result never supplies it.
    pub path: Option<PathBuf>,
}

/// The native steps of a native-first operation (contract §3). Both steps can show a dialog, so they block.
pub trait NativeFirst: Send + Sync {
    /// Runs before the forward. `Ok(None)` is a canceled dialog.
    fn prepare(&self, operation: &str, payload: &Value) -> Result<Option<Prepared>, &'static str>;
    /// Runs after the service response of a forwarded request. It returns the response for the renderer.
    fn finish(&self, operation: &str, prepared: &Prepared, response: Value) -> Value;
    /// Decides `requestClose` without a service session. A close decision ends the application.
    fn request_close(&self, request: close::Request) -> Decision;
}

/// A forwarded request waits here for the service response with its `requestId`.
enum Submitted {
    Answer(Value),
    Waiting(Receiver<Value>, Option<Prepared>),
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
    native: OnceLock<Weak<dyn NativeFirst>>,
    text_scale: Current,
}

impl Ipc {
    pub fn new(forward: FrameSink) -> Ipc {
        Ipc {
            forward,
            session: Mutex::new(Session::default()),
            native: OnceLock::new(),
            text_scale: Current::default(),
        }
    }

    /// The factor of each `currentSession` answer.
    pub fn text_scale(&self) -> &Current {
        &self.text_scale
    }

    /// Without the native steps, each native-first operation gives `SERVICE_UNAVAILABLE`.
    pub fn set_native(&self, native: Weak<dyn NativeFirst>) {
        let _ = self.native.set(native);
    }

    fn native(&self) -> Option<Arc<dyn NativeFirst>> {
        self.native.get().and_then(Weak::upgrade)
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

    /// Runs the contract §1 "Renderer request body" steps for one renderer request.
    /// `url` is the URL of the calling webview. `operation` is the operation of the invoked command.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the commands call submit, which handle wraps")
    )]
    pub fn handle(
        &self,
        window_label: &str,
        url: &str,
        body: &InvokeBody,
        operation: &str,
    ) -> Outcome {
        match self.submit(window_label, url, body, operation) {
            Submitted::Answer(answer) => Outcome::Answer(answer),
            Submitted::Waiting(..) => Outcome::Forwarded,
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

    /// The steps of contract §1 "Renderer request body", in that order.
    /// The service strict decoder checks duplicate keys, nesting, and unsafe integers. The shell also runs it on a native-first body.
    fn submit(&self, label: &str, url: &str, body: &InvokeBody, command: &str) -> Submitted {
        if label != MAIN_WINDOW || !is_local(url) {
            return Submitted::Denied;
        }
        let without_id = |code: &str| {
            Submitted::Answer(json!({ "requestId": null, "state": "rejected", "code": code }))
        };
        // Pinned Tauri parses a JSON body before command code runs (tauri-2.12.1 ipc/protocol.rs:520-530).
        // The postMessage fallback sends a `Uint8Array` as a JSON number array (protocol.rs:294).
        let InvokeBody::Raw(bytes) = body else {
            return without_id(INVALID);
        };
        if bytes.len() > PUBLIC_REQUEST_BYTES {
            return without_id("FRAME_LIMIT");
        }
        let Some((text, request)) = std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| Some((text, serde_json::from_str::<Value>(text).ok()?)))
            .filter(|(_, request)| request.is_object())
        else {
            return without_id(INVALID);
        };
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| is_identifier(id));
        let reject = |code: &str| {
            Submitted::Answer(json!({ "requestId": request_id, "state": "rejected", "code": code }))
        };
        let Some(operation) = request
            .get("operation")
            .and_then(Value::as_str)
            .filter(|operation| OPERATIONS.contains(operation))
        else {
            return reject("UNKNOWN_OPERATION");
        };
        let Some(request_id) = request_id else {
            return without_id(INVALID);
        };
        // A body of another operation would skip the native step of its own command.
        if operation != command {
            return reject(INVALID);
        }
        if operation == "currentSession" {
            return Submitted::Answer(text_scale::session_answer(
                request_id,
                self.session().session_id.as_deref(),
                self.text_scale.get(),
            ));
        }
        let native_first = NATIVE_FIRST.contains(&operation);
        let mut envelope = Value::Null;
        if native_first {
            if operation == "requestClose" {
                let parsed = decode_strict(text)
                    .ok_or(INVALID)
                    .and_then(|strict| close::Request::parse(&strict));
                let request = match parsed {
                    Ok(request) => request,
                    Err(code) => return reject(code),
                };
                let Some(native) = self.native() else {
                    return reject("SERVICE_UNAVAILABLE");
                };
                return Submitted::Answer(match native.request_close(request) {
                    Decision::StayOpen => {
                        json!({ "requestId": request_id, "state": "canceled", "code": "CANCELED" })
                    }
                    Decision::Stay | Decision::Close => {
                        json!({ "requestId": request_id, "state": "succeeded" })
                    }
                });
            }
            let Some(strict) = decode_strict(text) else {
                return reject(INVALID);
            };
            if let Err(code) = schema::native_first(&strict) {
                return reject(code);
            }
            envelope = strict;
        }
        // The requestId is reserved before any native dialog shows.
        let (waiting, response) = channel(1);
        let reserved = waiting.clone();
        {
            let mut session = self.session();
            if session.pending.contains_key(request_id) {
                return reject(INVALID);
            }
            // Without a session the sender drops at once, so the invoke fails with SERVICE_UNAVAILABLE in the bridge.
            if session.session_id.is_some() {
                session.pending.insert(request_id.to_string(), waiting);
            }
        }
        // Each answer from here on frees the reservation, so no request waits without a response.
        let answer = |answer: Value| {
            let mut session = self.session();
            if session
                .pending
                .get(request_id)
                .is_some_and(|sender| sender.same_channel(&reserved))
            {
                session.pending.remove(request_id);
            }
            Submitted::Answer(answer)
        };
        let rejected = |code: &str| {
            answer(json!({ "requestId": request_id, "state": "rejected", "code": code }))
        };
        let mut prepared = None;
        let body = if native_first {
            let native = self.native();
            let (Some(native), true) = (native, self.session().session_id.is_some()) else {
                return rejected("SERVICE_UNAVAILABLE");
            };
            match native.prepare(operation, &envelope["payload"]) {
                Err(code) => return rejected(code),
                Ok(None) => {
                    return answer(
                        json!({ "requestId": request_id, "state": "canceled", "code": "CANCELED" }),
                    );
                }
                Ok(Some(native)) => {
                    envelope["payload"] = native.payload.clone();
                    prepared = Some(native);
                    public_request_body(&envelope.to_string())
                }
            }
        } else {
            public_request_body(text)
        };
        let Ok(body) = body else {
            return rejected("FRAME_LIMIT");
        };
        if !(self.forward)(body) {
            return rejected("SERVICE_UNAVAILABLE");
        }
        Submitted::Waiting(response, prepared)
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
/// A progress event outside the contract §2 shape gives `None` too.
pub fn renderer_message(frame_body: &str) -> Option<ToRenderer> {
    let Value::Object(mut frame) = decode_strict(frame_body)? else {
        return None;
    };
    if frame.len() != 2 || frame.get("kind").and_then(Value::as_str) != Some("public") {
        return None;
    }
    match (frame.remove("response"), frame.remove("progress")) {
        (Some(response @ Value::Object(_)), None) => Some(ToRenderer::Response(response)),
        (None, Some(progress)) if schema::progress(&progress) => {
            Some(ToRenderer::Progress(progress))
        }
        _ => None,
    }
}

const DENIED: &str = "denied";

/// Runs one command off the async workers, because a forward can wait on the service pipe.
async fn call(
    webview: Webview,
    ipc: &Arc<Ipc>,
    operation: &'static str,
    body: InvokeBody,
) -> Result<Value, &'static str> {
    let label = webview.label().to_string();
    let url = webview.url().map_err(|_| DENIED)?.to_string();
    let submitter = Arc::clone(ipc);
    let submitted = tauri::async_runtime::spawn_blocking(move || {
        submitter.submit(&label, &url, &body, operation)
    })
    .await
    .map_err(|_| DENIED)?;
    let (response, prepared) = match submitted {
        Submitted::Answer(answer) => return Ok(answer),
        Submitted::Waiting(mut response, prepared) => (
            response.recv().await.ok_or("SERVICE_UNAVAILABLE")?,
            prepared,
        ),
        Submitted::Denied => return Err(DENIED),
    };
    match (ipc.native(), prepared) {
        (Some(native), Some(prepared)) => tauri::async_runtime::spawn_blocking(move || {
            native.finish(operation, &prepared, response)
        })
        .await
        .map_err(|_| "SERVICE_UNAVAILABLE"),
        _ => Ok(response),
    }
}

// One command per contract §3 operation. Each name equals its entry in `COMMANDS` of `src-tauri/build.rs`.
// Each takes the raw invoke body (contract §1 "Renderer request body").

#[tauri::command]
pub async fn get_environment(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "getEnvironment", request.body().clone()).await
}

#[tauri::command]
pub async fn choose_git(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "chooseGit", request.body().clone()).await
}

#[tauri::command]
pub async fn choose_repository(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "chooseRepository", request.body().clone()).await
}

#[tauri::command]
pub async fn restore_workspace(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "restoreWorkspace", request.body().clone()).await
}

#[tauri::command]
pub async fn read_workspace(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readWorkspace", request.body().clone()).await
}

#[tauri::command]
pub async fn read_entries(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readEntries", request.body().clone()).await
}

#[tauri::command]
pub async fn read_history(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readHistory", request.body().clone()).await
}

#[tauri::command]
pub async fn read_comparison(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readComparison", request.body().clone()).await
}

#[tauri::command]
pub async fn read_trust(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readTrust", request.body().clone()).await
}

#[tauri::command]
pub async fn approve_trust(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "approveTrust", request.body().clone()).await
}

#[tauri::command]
pub async fn revoke_trust(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "revokeTrust", request.body().clone()).await
}

#[tauri::command]
pub async fn apply_hunk(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "applyHunk", request.body().clone()).await
}

#[tauri::command]
pub async fn apply_file(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "applyFile", request.body().clone()).await
}

#[tauri::command]
pub async fn review_commit(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "reviewCommit", request.body().clone()).await
}

#[tauri::command]
pub async fn commit(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "commit", request.body().clone()).await
}

#[tauri::command]
pub async fn review_submodules(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "reviewSubmodules", request.body().clone()).await
}

#[tauri::command]
pub async fn update_submodules(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "updateSubmodules", request.body().clone()).await
}

#[tauri::command]
pub async fn cancel(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "cancel", request.body().clone()).await
}

#[tauri::command]
pub async fn get_operation(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "getOperation", request.body().clone()).await
}

#[tauri::command]
pub async fn request_close(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "requestClose", request.body().clone()).await
}

#[tauri::command]
pub async fn current_session(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "currentSession", request.body().clone()).await
}

#[tauri::command]
pub async fn dismiss_recovery_marker(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(
        webview,
        &ipc,
        "dismissRecoveryMarker",
        request.body().clone(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use tauri::ipc::InvokeBody;

    use crate::framing::{PUBLIC_FRAME_BODY_BYTES, PUBLIC_REQUEST_BYTES};

    // Pinned Tauri serves the bundled frontend on Windows at this origin (manager/mod.rs:335-338, webview/mod.rs:1966-1974).
    const LOCAL: &str = "http://tauri.localhost/";
    const REQUEST_ID: &str = "0f0f0f0f-0000-4000-8000-000000000001";
    const OPERATION_ID: &str = "0f0f0f0f-0000-4000-8000-000000000002";
    const SESSION_ID: &str = "0f0f0f0f-0000-4000-8000-0000000000aa";

    fn ipc() -> (Ipc, Arc<Mutex<Vec<String>>>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink: FrameSink = {
            let frames = Arc::clone(&frames);
            Arc::new(move |body: String| {
                frames.lock().expect("frames").push(body);
                true
            })
        };
        (Ipc::new(sink), frames)
    }

    type Prepare = Box<dyn Fn() -> Result<Option<Prepared>, &'static str> + Send + Sync>;

    /// Counts each native step. `prepare` answers as the test sets it. Each close request gets Stay open.
    struct FakeNative {
        prepare: Prepare,
        prepares: Mutex<usize>,
        closes: Mutex<Vec<close::Request>>,
    }

    impl NativeFirst for FakeNative {
        fn prepare(&self, _: &str, _: &Value) -> Result<Option<Prepared>, &'static str> {
            *self.prepares.lock().expect("prepares") += 1;
            (self.prepare)()
        }

        fn finish(&self, _: &str, _: &Prepared, response: Value) -> Value {
            response
        }

        fn request_close(&self, request: close::Request) -> Decision {
            self.closes.lock().expect("closes").push(request);
            Decision::StayOpen
        }
    }

    /// An `Ipc` with a running session and the fake native steps. The caller keeps the returned native alive.
    fn connected(prepare: Prepare) -> (Ipc, Arc<Mutex<Vec<String>>>, Arc<FakeNative>) {
        let (ipc, frames) = ipc();
        ipc.set_session(Some(SESSION_ID.to_string()));
        let native = Arc::new(FakeNative {
            prepare,
            prepares: Mutex::new(0),
            closes: Mutex::new(Vec::new()),
        });
        let weak: Weak<FakeNative> = Arc::downgrade(&native);
        ipc.set_native(weak);
        (ipc, frames, native)
    }

    fn pending(ipc: &Ipc) -> usize {
        ipc.session().pending.len()
    }

    /// `levels` nested arrays.
    fn nested(levels: usize) -> Value {
        (1..levels).fold(json!([]), |inner, _| json!([inner]))
    }

    fn request(operation: &str, payload: Value) -> Value {
        json!({ "version": 1, "sessionId": SESSION_ID, "requestId": REQUEST_ID, "operation": operation, "payload": payload })
    }

    /// The bridge body: the UTF-8 bytes of `JSON.stringify(envelope)` (contract §1 "Renderer request body").
    fn raw(text: &str) -> InvokeBody {
        InvokeBody::Raw(text.as_bytes().to_vec())
    }

    /// Calls the command of the envelope operation with the raw body of `envelope`.
    fn send(ipc: &Ipc, envelope: &Value) -> Outcome {
        let operation = envelope["operation"].as_str().unwrap_or("getEnvironment");
        ipc.handle(MAIN_WINDOW, LOCAL, &raw(&envelope.to_string()), operation)
    }

    fn rejected(code: &str) -> Outcome {
        Outcome::Answer(json!({ "requestId": REQUEST_ID, "state": "rejected", "code": code }))
    }

    fn rejected_without_id(code: &str) -> Outcome {
        Outcome::Answer(json!({ "requestId": null, "state": "rejected", "code": code }))
    }

    /// The `public` frame body that carries `envelope` unchanged.
    fn frame_of(envelope: &str) -> String {
        format!("{{\"kind\":\"public\",\"request\":{envelope}}}")
    }

    #[test]
    fn a_json_invoke_body_is_refused_and_nothing_is_forwarded() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let envelope = request("getEnvironment", json!({}));
        // The postMessage fallback sends a `Uint8Array` as a JSON number array.
        let numbers = json!(envelope.to_string().bytes().collect::<Vec<u8>>());
        for body in [InvokeBody::Json(envelope), InvokeBody::Json(numbers)] {
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &body, "getEnvironment"),
                rejected_without_id("INVALID_REQUEST")
            );
        }
        let native_first = request("chooseRepository", json!({}));
        assert_eq!(
            ipc.handle(
                MAIN_WINDOW,
                LOCAL,
                &InvokeBody::Json(native_first),
                "chooseRepository"
            ),
            rejected_without_id("INVALID_REQUEST")
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn a_raw_body_above_1_mib_gets_frame_limit_before_any_parse() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        // Not JSON: a parse first would give INVALID_REQUEST.
        let above = InvokeBody::Raw(vec![b'x'; PUBLIC_REQUEST_BYTES + 1]);
        for operation in ["getEnvironment", "chooseGit", "currentSession"] {
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &above, operation),
                rejected_without_id("FRAME_LIMIT"),
                "{operation}"
            );
        }
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn a_raw_body_of_exactly_1_mib_is_forwarded_byte_for_byte() {
        let (ipc, frames) = ipc();
        // Spaces and key order that a parse and a new encoding would not keep.
        let head = format!(
            r#"{{ "payload" : {{ }} , "operation" : "getEnvironment" , "requestId" : "{REQUEST_ID}" , "sessionId" : "{SESSION_ID}" , "version" : 1"#
        );
        let body = format!(
            "{head}{}}}",
            " ".repeat(PUBLIC_REQUEST_BYTES - head.len() - 1)
        );
        assert_eq!(body.len(), PUBLIC_REQUEST_BYTES);
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), "getEnvironment"),
            Outcome::Forwarded
        );
        let frames = frames.lock().expect("frames");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], frame_of(&body));
        assert_eq!(frames[0].len(), PUBLIC_FRAME_BODY_BYTES);
    }

    #[test]
    fn a_read_entries_request_is_forwarded_byte_for_byte() {
        let (ipc, frames) = ipc();
        let mut envelope = request(
            "readEntries",
            json!({ "snapshotId": OPERATION_ID, "cursor": OPERATION_ID }),
        );
        envelope["repositoryId"] = json!(OPERATION_ID);
        envelope["repositoryGeneration"] = json!(0);
        let body = envelope.to_string();
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), "readEntries"),
            Outcome::Forwarded
        );
        assert_eq!(*frames.lock().expect("frames"), vec![frame_of(&body)]);
    }

    /// Contract §3: each operation of `src/contracts/operations.ts` has its handler in `lib.rs` and its grant in the capability.
    #[test]
    fn each_contract_operation_has_its_handler_and_its_grant() {
        let read = |path: &str| {
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).expect(path)
        };
        let contract = read("../src/contracts/operations.ts");
        let (list, _) = contract
            .split_once("OPERATION_NAMES = [")
            .and_then(|(_, rest)| rest.split_once(']'))
            .expect("OPERATION_NAMES");
        let names: Vec<&str> = list.split('"').skip(1).step_by(2).collect();
        assert_eq!(names, OPERATIONS);
        let lib = read("src/lib.rs");
        let capability: Value =
            serde_json::from_str(&read("capabilities/main.json")).expect("capability");
        let grants = capability["permissions"].as_array().expect("permissions");
        for operation in OPERATIONS {
            let command: String = operation
                .chars()
                .flat_map(|c| {
                    let word = c.is_ascii_uppercase().then_some('_');
                    word.into_iter().chain([c.to_ascii_lowercase()])
                })
                .collect();
            assert!(
                lib.contains(&format!("ipc::{command},")),
                "handler of {operation}"
            );
            let grant = format!("allow-{}", command.replace('_', "-"));
            assert!(grants.contains(&json!(grant)), "grant of {operation}");
        }
    }

    #[test]
    fn a_body_that_is_not_utf8_json_or_has_no_valid_request_id_gets_invalid_request_without_an_id()
    {
        let (ipc, frames) = ipc();
        let mut no_id = request("getEnvironment", json!({}));
        no_id["requestId"] = json!("request-1");
        for body in [
            InvokeBody::Raw(b"{".to_vec()),
            InvokeBody::Raw(b"{\"a\":\"\xff\"}".to_vec()),
            InvokeBody::Raw(b"[]".to_vec()),
            raw(&no_id.to_string()),
        ] {
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &body, "getEnvironment"),
                rejected_without_id("INVALID_REQUEST"),
                "{body:?}"
            );
        }
        assert!(frames.lock().expect("frames").is_empty());
    }

    #[test]
    fn an_operation_other_than_the_command_operation_gets_invalid_request_and_no_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let body = request("chooseGit", json!({})).to_string();
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), "getEnvironment"),
            rejected("INVALID_REQUEST"),
            "a chooseGit envelope through get_environment skips no native step"
        );
        let body = request("getEnvironment", json!({})).to_string();
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), "readWorkspace"),
            rejected("INVALID_REQUEST")
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn duplicate_keys_deep_nesting_and_unsafe_integers_reach_the_service_unchanged() {
        let (ipc, frames) = ipc();
        let envelope = |payload: &str, generation: &str| {
            format!(
                r#"{{"version":1,"sessionId":"{SESSION_ID}","requestId":"{REQUEST_ID}","operation":"readWorkspace","repositoryId":"{OPERATION_ID}"{generation},"payload":{payload}}}"#
            )
        };
        let bodies = [
            envelope(r#"{"refresh":false,"refresh":true,"check":"full"}"#, ""),
            envelope(&json!({ "pad": nested(17) }).to_string(), ""),
            envelope("{}", r#","repositoryGeneration":9007199254740992"#),
        ];
        for body in &bodies {
            // Only the service strict decoder refuses these bodies (contract §1).
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &raw(body), "readWorkspace"),
                Outcome::Forwarded,
                "{body}"
            );
        }
        let frames = frames.lock().expect("frames");
        let expected: Vec<String> = bodies.iter().map(|body| frame_of(body)).collect();
        assert_eq!(*frames, expected);
    }

    #[test]
    fn a_native_first_envelope_outside_its_generated_type_gets_its_code_before_any_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let mut version = request("chooseGit", json!({}));
        version["version"] = json!(2);
        for (envelope, code) in [
            (
                request("chooseRepository", json!({ "path": "C:\\repo" })),
                "INVALID_REQUEST",
            ),
            (
                request("restoreWorkspace", json!({ "bootstrapId": OPERATION_ID })),
                "INVALID_REQUEST",
            ),
            (
                request("chooseGit", json!({ "executablePath": "C:\\evil.exe" })),
                "INVALID_REQUEST",
            ),
            (
                request("dismissRecoveryMarker", json!({ "markerId": "marker-1" })),
                "INVALID_REQUEST",
            ),
            (
                request("dismissRecoveryMarker", json!({})),
                "INVALID_REQUEST",
            ),
            (version, "PROTOCOL_VERSION"),
        ] {
            assert_eq!(send(&ipc, &envelope), rejected(code), "{envelope}");
        }
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn request_close_is_decided_natively_without_a_session_and_never_forwarded() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        ipc.set_session(None);
        assert_eq!(
            send(
                &ipc,
                &request("requestClose", json!({ "choice": "closeIfIdle" }))
            ),
            Outcome::Answer(
                json!({ "requestId": REQUEST_ID, "state": "canceled", "code": "CANCELED" })
            )
        );
        assert_eq!(
            *native.closes.lock().expect("closes"),
            [close::Request::CloseIfIdle]
        );
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn a_request_close_payload_outside_the_contract_is_refused_before_any_decision() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        for payload in [json!({}), json!({ "choice": "close" })] {
            assert_eq!(
                send(&ipc, &request("requestClose", payload)),
                rejected("INVALID_REQUEST")
            );
        }
        assert!(native.closes.lock().expect("closes").is_empty());
        assert!(frames.lock().expect("frames").is_empty());
    }

    #[test]
    fn a_native_first_body_with_a_duplicate_key_gets_invalid_request_before_any_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let body = format!(
            r#"{{"version":1,"sessionId":"{SESSION_ID}","requestId":"{REQUEST_ID}","operation":"chooseRepository","payload":{{"path":"C:\\repo"}},"payload":{{}}}}"#
        );
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), "chooseRepository"),
            rejected("INVALID_REQUEST")
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn a_native_first_request_forwards_the_envelope_with_the_native_payload() {
        let (ipc, frames, native) = connected(Box::new(|| {
            Ok(Some(Prepared {
                payload: json!({ "bootstrapId": OPERATION_ID }),
                path: None,
            }))
        }));
        assert_eq!(
            send(&ipc, &request("chooseRepository", json!({}))),
            Outcome::Forwarded
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 1);
        let frames = frames.lock().expect("frames");
        let frame: Value = serde_json::from_str(&frames[0]).expect("frame");
        assert_eq!(
            frame,
            json!({ "kind": "public", "request": request("chooseRepository", json!({ "bootstrapId": OPERATION_ID })) })
        );
    }

    #[test]
    fn a_prepared_request_above_1_mib_gets_frame_limit_and_leaves_no_pending_request() {
        let (ipc, frames, _native) = connected(Box::new(|| {
            Ok(Some(Prepared {
                payload: json!({ "bootstrapId": "a".repeat(PUBLIC_REQUEST_BYTES) }),
                path: None,
            }))
        }));
        assert_eq!(
            send(&ipc, &request("chooseRepository", json!({}))),
            rejected("FRAME_LIMIT")
        );
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn a_failed_forward_gets_service_unavailable_and_leaves_no_pending_request() {
        let ipc = Ipc::new(Arc::new(|_| false));
        ipc.set_session(Some(SESSION_ID.to_string()));
        assert_eq!(
            send(&ipc, &request("getEnvironment", json!({}))),
            rejected("SERVICE_UNAVAILABLE")
        );
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    #[test]
    fn a_repeated_request_id_is_refused_before_any_native_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Err("UNSUPPORTED_REPOSITORY")));
        assert_eq!(
            send(&ipc, &request("getEnvironment", json!({}))),
            Outcome::Forwarded
        );
        assert_eq!(
            send(&ipc, &request("chooseRepository", json!({}))),
            rejected("INVALID_REQUEST"),
            "the requestId is in flight"
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        let other = json!({ "version": 1, "sessionId": SESSION_ID, "requestId": OPERATION_ID, "operation": "chooseRepository", "payload": {} });
        assert_eq!(
            send(&ipc, &other),
            Outcome::Answer(
                json!({ "requestId": OPERATION_ID, "state": "rejected", "code": "UNSUPPORTED_REPOSITORY" })
            ),
            "a refused identity read"
        );
        assert_eq!(pending(&ipc), 1, "the refusal frees its requestId");
        assert_eq!(frames.lock().expect("frames").len(), 1);
    }

    #[test]
    fn a_request_from_a_remote_webview_or_another_window_is_denied() {
        let (ipc, frames) = ipc();
        let valid = raw(&request("getEnvironment", json!({})).to_string());
        assert_eq!(
            ipc.handle(MAIN_WINDOW, LOCAL, &valid, "getEnvironment"),
            Outcome::Forwarded,
            "the main local window"
        );
        assert_eq!(
            ipc.handle(
                MAIN_WINDOW,
                "https://tauri.localhost/index.html",
                &valid,
                "getEnvironment"
            ),
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
                ipc.handle(MAIN_WINDOW, url, &valid, "getEnvironment"),
                Outcome::Denied,
                "remote webview {url}"
            );
        }
        for label in ["settings", "Main", ""] {
            assert_eq!(
                ipc.handle(label, LOCAL, &valid, "getEnvironment"),
                Outcome::Denied,
                "window {label:?}"
            );
        }
        let json_body = InvokeBody::Json(request("getEnvironment", json!({})));
        assert_eq!(
            ipc.handle("settings", LOCAL, &json_body, "getEnvironment"),
            Outcome::Denied,
            "the caller check comes first"
        );
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
            let body = request(operation, json!({})).to_string();
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), "getEnvironment"),
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
            (
                "a phase outside data-model §7",
                with("phase", json!("push")),
            ),
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
        ipc.set_session(Some(SESSION_ID.to_string()));
        let Outcome::Answer(first) = send(&ipc, &current) else {
            panic!("an answer")
        };
        assert_eq!(
            (first["requestId"].as_str(), first["state"].as_str()),
            (Some(REQUEST_ID), Some("succeeded"))
        );
        assert_eq!(first["result"]["sessionId"], SESSION_ID);
        assert_eq!(
            first["result"]["textScale"], 1.0,
            "the factor before any read"
        );
        ipc.text_scale().set(1.5);
        ipc.set_session(Some("0f0f0f0f-0000-4000-8000-0000000000bb".to_string()));
        let Outcome::Answer(after) = send(&ipc, &current) else {
            panic!("an answer")
        };
        assert_eq!(
            after["result"]["sessionId"], "0f0f0f0f-0000-4000-8000-0000000000bb",
            "the new ID after a restart"
        );
        assert_eq!(after["result"]["textScale"], 1.5);
        ipc.set_session(None);
        assert_eq!(
            send(&ipc, &current),
            Outcome::Answer(json!({
                "requestId": REQUEST_ID, "state": "rejected", "code": "SERVICE_UNAVAILABLE",
                "result": { "textScale": 1.5 },
            })),
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
