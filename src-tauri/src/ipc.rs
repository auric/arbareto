// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tauri::async_runtime::{Receiver, Sender, channel};
use tauri::ipc::{InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{State, Webview};

use crate::close::{self, Decision};
use crate::framing::{PUBLIC_REQUEST_BYTES, public_request_body};
use crate::process_requests::{decode_strict, is_identifier};
use crate::schema;
use crate::settings;
use crate::text_scale::{self, Current};

/// The label of the only window that may call the public operations (contract §1).
pub const MAIN_WINDOW: &str = "main";

/// Contract §3: the closed allowlist of public operations, as `src/contracts/operations.ts` lists them.
pub const OPERATIONS: [&str; 65] = [
    "getEnvironment",
    "chooseGit",
    "chooseRepository",
    "restoreWorkspace",
    "listRecentRepositories",
    "openRecentRepository",
    "removeRecentRepository",
    "readWorkspace",
    "readEntries",
    "openHistory",
    "loadHistory",
    "readHistoryRows",
    "searchHistory",
    "closeHistory",
    "readRefs",
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
    // Feature 003 contract Δ1.
    "readTracking",
    "reviewSync",
    "sync",
    "clone",
    "connectInTerminal",
    "readSyncSettings",
    "setSshClient",
    "setDefaultPullAction",
    "chooseSyncPath",
    "clearSyncPath",
    "launchPuttygen",
    // Feature 004 contract Δ1.
    "readBranches",
    "readWorktrees",
    "readGitSettings",
    "reviewWorkbench",
    "runWorkbench",
    "applyFiles",
    "openWorktree",
    "revealPath",
    "setSwitchChoice",
    "chooseWorktreeFolder",
    // Feature 005 contract Δ1.
    "readCommitChanges",
    "readCommitFile",
    "readBlame",
    "readIgnoreFile",
    "previewIgnore",
    "openSubmodule",
    // Feature 006 contract Δ1.
    "listDictionaries",
    "readDictionary",
    "downloadDictionary",
    "importDictionary",
    "removeDictionary",
    "setSpelling",
    "openLicenceLink",
    // Feature 007 contracts/release.md §5.
    "openReleaseLink",
];

/// Contract §3: the shell runs these first. The shell answers `requestClose` itself and never forwards it.
/// Feature 004 contract Δ1: only the `worktree-add` form of `reviewWorkbench` is native-first, so `submit` decides it by its action.
const NATIVE_FIRST: [&str; 23] = [
    "requestClose",
    "chooseGit",
    "chooseRepository",
    "restoreWorkspace",
    "dismissRecoveryMarker",
    "listRecentRepositories",
    "openRecentRepository",
    "removeRecentRepository",
    // Feature 003 contract Δ1.
    "clone",
    "readSyncSettings",
    "setSshClient",
    "setDefaultPullAction",
    "chooseSyncPath",
    "clearSyncPath",
    "launchPuttygen",
    // Feature 004 contract Δ1.
    "openWorktree",
    "setSwitchChoice",
    "chooseWorktreeFolder",
    // Feature 005 contract Δ1.
    "openSubmodule",
    // Feature 006 contract Δ1.
    "importDictionary",
    "setSpelling",
    "openLicenceLink",
    // Feature 007 contracts/release.md §5.
    "openReleaseLink",
];

/// Contract §3 "Recent repositories" and feature 003, 004, and 006 contract Δ1: the shell answers these itself and never forwards them.
const NATIVE_ANSWERS: [&str; 13] = [
    "listRecentRepositories",
    "removeRecentRepository",
    "readSyncSettings",
    "setSshClient",
    "setDefaultPullAction",
    "chooseSyncPath",
    "clearSyncPath",
    "launchPuttygen",
    "setSwitchChoice",
    "chooseWorktreeFolder",
    "setSpelling",
    "openLicenceLink",
    // Feature 007 contracts/release.md §5.
    "openReleaseLink",
];

/// Feature 004 contract Δ1: the `reviewWorkbench` action whose path the shell binds first.
const WORKTREE_ADD: &str = "worktree-add";

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

/// A native step that ends the request before the forward.
#[derive(Debug, PartialEq)]
pub enum Ended {
    /// The renderer gets `rejected` with the code.
    Rejected(&'static str),
    /// The renderer gets `failed` with the code and the result (contract §9).
    Failed(&'static str, Value),
}

impl From<&'static str> for Ended {
    fn from(code: &'static str) -> Ended {
        Ended::Rejected(code)
    }
}

/// The native steps of a native-first operation (contract §3). Both steps can show a dialog, so they block.
pub trait NativeFirst: Send + Sync {
    /// Runs before the forward. `Ok(None)` is a canceled dialog.
    fn prepare(&self, operation: &str, payload: &Value) -> Result<Option<Prepared>, Ended>;
    /// Answers a `NATIVE_ANSWERS` operation with its result. `Ok(None)` is a canceled picker.
    fn answer(&self, operation: &str, payload: &Value) -> Result<Option<Value>, Ended>;
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
        let native_first = NATIVE_FIRST.contains(&operation)
            || (operation == "reviewWorkbench" && request["payload"]["action"] == WORKTREE_ADD);
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
            // Contract §3: the list, the removal, and the settings operations need no service session.
            if NATIVE_ANSWERS.contains(&operation) {
                let Some(native) = self.native() else {
                    return reject("SERVICE_UNAVAILABLE");
                };
                return Submitted::Answer(match native.answer(operation, &strict["payload"]) {
                    Ok(Some(result)) => {
                        json!({ "requestId": request_id, "state": "succeeded", "result": result })
                    }
                    Ok(None) => {
                        json!({ "requestId": request_id, "state": "canceled", "code": "CANCELED" })
                    }
                    Err(Ended::Rejected(code)) => {
                        json!({ "requestId": request_id, "state": "rejected", "code": code })
                    }
                    Err(Ended::Failed(code, result)) => {
                        json!({ "requestId": request_id, "state": "failed", "code": code, "result": result })
                    }
                });
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
            // Feature 004 contract Δ6: the `worktreeAdd` binding takes the `repositoryId` of the envelope.
            let mut payload = envelope["payload"].clone();
            if operation == "reviewWorkbench" {
                payload["repositoryId"] = envelope["repositoryId"].clone();
            }
            match native.prepare(operation, &payload) {
                Err(Ended::Rejected(code)) => return rejected(code),
                Err(Ended::Failed(code, result)) => {
                    return answer(
                        json!({ "requestId": request_id, "state": "failed", "code": code, "result": result }),
                    );
                }
                Ok(None) => {
                    return answer(
                        json!({ "requestId": request_id, "state": "canceled", "code": "CANCELED" }),
                    );
                }
                Ok(Some(native)) => {
                    envelope["payload"] = native.payload.clone();
                    // Contract §3 `openRecentRepository`: the service gets the request as `restoreWorkspace`.
                    if operation == "openRecentRepository" {
                        envelope["operation"] = json!("restoreWorkspace");
                    }
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

/// Feature 006 contract Δ5: `src/contracts/limits.ts` `DICTIONARY_CHUNK_BYTES`.
const DICTIONARY_CHUNK_BYTES: u64 = 1_048_576;
/// Feature 006 data-model §2: `src/contracts/dictionaries.ts` `DICTIONARY_FILE_NAMES`.
const DICTIONARY_FILE_NAMES: [&str; 5] =
    ["index.aff", "index.dic", "license", "licence", "readme.md"];

/// Feature 006 contract Δ1: a `succeeded` `readDictionary` response reaches the renderer as the raw chunk body.
/// Every other response stays JSON. A result outside the `DictionaryChunk` rules gives `SERVICE_UNAVAILABLE`.
fn dictionary_response(response: Value) -> Result<InvokeResponseBody, &'static str> {
    if response["state"] != "succeeded" {
        return Ok(InvokeResponseBody::Json(response.to_string()));
    }
    dictionary_chunk(&response["result"])
        .map(InvokeResponseBody::Raw)
        .ok_or("SERVICE_UNAVAILABLE")
}

/// The `DictionaryChunk` rules of `ReadDictionaryResult` in `src/contracts/envelope.ts`.
/// The body is the file size as a 4-byte little-endian integer, then the decoded chunk.
pub(crate) fn dictionary_chunk(result: &Value) -> Option<Vec<u8>> {
    let size = result["size"]
        .as_u64()
        .filter(|size| (1..=settings::DICTIONARY_LANGUAGE_BYTES).contains(size))?;
    let offset = result["offset"]
        .as_u64()
        .filter(|offset| offset % DICTIONARY_CHUNK_BYTES == 0 && *offset < size)?;
    // The base64 length of DICTIONARY_CHUNK_BYTES bounds the decode.
    let text = result["bytes"].as_str().filter(|text| {
        u64::try_from(text.len()).is_ok_and(|n| n <= DICTIONARY_CHUNK_BYTES.div_ceil(3) * 4)
    })?;
    let fits = settings::has_keys(result, &["language", "file", "size", "offset", "bytes"])
        && result["language"]
            .as_str()
            .is_some_and(settings::is_language_id)
        && result["file"]
            .as_str()
            .is_some_and(|file| DICTIONARY_FILE_NAMES.contains(&file));
    if !fits {
        return None;
    }
    let mut body = u32::try_from(size).ok()?.to_le_bytes().to_vec();
    STANDARD.decode_vec(text, &mut body).ok()?;
    let chunk = u64::try_from(body.len() - 4).ok()?;
    (chunk == DICTIONARY_CHUNK_BYTES.min(size - offset)).then_some(body)
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
pub async fn list_recent_repositories(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(
        webview,
        &ipc,
        "listRecentRepositories",
        request.body().clone(),
    )
    .await
}

#[tauri::command]
pub async fn open_recent_repository(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(
        webview,
        &ipc,
        "openRecentRepository",
        request.body().clone(),
    )
    .await
}

#[tauri::command]
pub async fn remove_recent_repository(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(
        webview,
        &ipc,
        "removeRecentRepository",
        request.body().clone(),
    )
    .await
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
pub async fn open_history(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "openHistory", request.body().clone()).await
}

#[tauri::command]
pub async fn load_history(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "loadHistory", request.body().clone()).await
}

#[tauri::command]
pub async fn read_history_rows(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readHistoryRows", request.body().clone()).await
}

#[tauri::command]
pub async fn search_history(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "searchHistory", request.body().clone()).await
}

#[tauri::command]
pub async fn close_history(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "closeHistory", request.body().clone()).await
}

#[tauri::command]
pub async fn read_refs(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readRefs", request.body().clone()).await
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

#[tauri::command]
pub async fn read_tracking(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readTracking", request.body().clone()).await
}

#[tauri::command]
pub async fn review_sync(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "reviewSync", request.body().clone()).await
}

#[tauri::command]
pub async fn sync(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "sync", request.body().clone()).await
}

#[tauri::command]
pub async fn clone(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "clone", request.body().clone()).await
}

#[tauri::command]
pub async fn connect_in_terminal(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "connectInTerminal", request.body().clone()).await
}

#[tauri::command]
pub async fn read_sync_settings(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readSyncSettings", request.body().clone()).await
}

#[tauri::command]
pub async fn set_ssh_client(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "setSshClient", request.body().clone()).await
}

#[tauri::command]
pub async fn set_default_pull_action(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(
        webview,
        &ipc,
        "setDefaultPullAction",
        request.body().clone(),
    )
    .await
}

#[tauri::command]
pub async fn choose_sync_path(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "chooseSyncPath", request.body().clone()).await
}

#[tauri::command]
pub async fn clear_sync_path(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "clearSyncPath", request.body().clone()).await
}

#[tauri::command]
pub async fn read_branches(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readBranches", request.body().clone()).await
}

#[tauri::command]
pub async fn read_worktrees(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readWorktrees", request.body().clone()).await
}

#[tauri::command]
pub async fn read_git_settings(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readGitSettings", request.body().clone()).await
}

#[tauri::command]
pub async fn review_workbench(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "reviewWorkbench", request.body().clone()).await
}

#[tauri::command]
pub async fn run_workbench(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "runWorkbench", request.body().clone()).await
}

#[tauri::command]
pub async fn apply_files(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "applyFiles", request.body().clone()).await
}

#[tauri::command]
pub async fn open_worktree(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "openWorktree", request.body().clone()).await
}

#[tauri::command]
pub async fn reveal_path(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "revealPath", request.body().clone()).await
}

#[tauri::command]
pub async fn set_switch_choice(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "setSwitchChoice", request.body().clone()).await
}

#[tauri::command]
pub async fn choose_worktree_folder(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(
        webview,
        &ipc,
        "chooseWorktreeFolder",
        request.body().clone(),
    )
    .await
}

#[tauri::command]
pub async fn read_commit_changes(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readCommitChanges", request.body().clone()).await
}

#[tauri::command]
pub async fn read_commit_file(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readCommitFile", request.body().clone()).await
}

#[tauri::command]
pub async fn read_blame(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readBlame", request.body().clone()).await
}

#[tauri::command]
pub async fn read_ignore_file(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "readIgnoreFile", request.body().clone()).await
}

#[tauri::command]
pub async fn preview_ignore(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "previewIgnore", request.body().clone()).await
}

#[tauri::command]
pub async fn open_submodule(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "openSubmodule", request.body().clone()).await
}

#[tauri::command]
pub async fn list_dictionaries(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "listDictionaries", request.body().clone()).await
}

#[tauri::command]
pub async fn read_dictionary(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Response, &'static str> {
    let response = call(webview, &ipc, "readDictionary", request.body().clone()).await?;
    dictionary_response(response).map(Response::new)
}

#[tauri::command]
pub async fn download_dictionary(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "downloadDictionary", request.body().clone()).await
}

#[tauri::command]
pub async fn import_dictionary(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "importDictionary", request.body().clone()).await
}

#[tauri::command]
pub async fn remove_dictionary(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "removeDictionary", request.body().clone()).await
}

#[tauri::command]
pub async fn set_spelling(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "setSpelling", request.body().clone()).await
}

#[tauri::command]
pub async fn open_licence_link(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "openLicenceLink", request.body().clone()).await
}

#[tauri::command]
pub async fn open_release_link(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "openReleaseLink", request.body().clone()).await
}

#[tauri::command]
pub async fn launch_puttygen(
    webview: Webview,
    ipc: State<'_, Arc<Ipc>>,
    request: Request<'_>,
) -> Result<Value, &'static str> {
    call(webview, &ipc, "launchPuttygen", request.body().clone()).await
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

    type Prepare = Box<dyn Fn() -> Result<Option<Prepared>, Ended> + Send + Sync>;

    fn putty_result() -> Value {
        json!({ "reason": "missing", "program": "puttygen", "path": "C:\\PuTTY\\puttygen.exe" })
    }

    /// Counts each native step. `prepare` answers as the test sets it. Each close request gets Stay open.
    struct FakeNative {
        prepare: Prepare,
        prepares: Mutex<usize>,
        /// The operation and the payload of each `prepare` call.
        prepared: Mutex<Vec<(String, Value)>>,
        closes: Mutex<Vec<close::Request>>,
    }

    impl NativeFirst for FakeNative {
        fn prepare(&self, operation: &str, payload: &Value) -> Result<Option<Prepared>, Ended> {
            *self.prepares.lock().expect("prepares") += 1;
            self.prepared
                .lock()
                .expect("prepared")
                .push((operation.to_string(), payload.clone()));
            (self.prepare)()
        }

        /// `chooseSyncPath` cancels, and `launchPuttygen` fails with `PUTTY_UNAVAILABLE`.
        fn answer(&self, operation: &str, payload: &Value) -> Result<Option<Value>, Ended> {
            *self.prepares.lock().expect("prepares") += 1;
            match (operation, payload.get("entryId")) {
                (_, Some(_)) => Err(Ended::Rejected("UNKNOWN_TARGET")),
                ("chooseSyncPath", _) => Ok(None),
                ("launchPuttygen", _) => Err(Ended::Failed("PUTTY_UNAVAILABLE", putty_result())),
                _ => Ok(Some(json!({ "operation": operation, "entries": [] }))),
            }
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
            prepared: Mutex::new(Vec::new()),
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
    fn a_raw_body_above_2_mib_gets_frame_limit_before_any_parse() {
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
    fn a_raw_body_of_exactly_2_mib_is_forwarded_byte_for_byte() {
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

    /// Feature 002 contract Δ1: the shell reads only `operation` and `requestId` of the five history bodies.
    /// Payloads outside the service schemas reach the service byte for byte.
    #[test]
    fn the_five_history_requests_are_forwarded_byte_for_byte_whatever_their_payload() {
        const FIVE: [&str; 5] = [
            "openHistory",
            "loadHistory",
            "readHistoryRows",
            "searchHistory",
            "closeHistory",
        ];
        for operation in FIVE {
            assert!(OPERATIONS.contains(&operation), "{operation}");
            assert!(!NATIVE_FIRST.contains(&operation), "{operation}");
        }
        let text = "\u{e9}".repeat(512) + "x";
        assert_eq!(text.len(), 1025);
        let cases = [
            ("openHistory", json!({ "scope": "branch" })),
            (
                "loadHistory",
                json!({ "viewId": OPERATION_ID, "need": { "row": 4_000_001 } }),
            ),
            (
                "readHistoryRows",
                json!({ "viewId": OPERATION_ID, "mode": "full", "at": { "row": 0 }, "count": 513, "text": "none" }),
            ),
            (
                "searchHistory",
                json!({ "viewId": OPERATION_ID, "text": text }),
            ),
            ("closeHistory", json!({ "viewId": "view", "extra": 1 })),
        ];
        for (operation, payload) in cases {
            let (ipc, frames) = ipc();
            let mut envelope = request(operation, payload);
            envelope["repositoryId"] = json!(OPERATION_ID);
            // Spaces that a parse and a new encoding would not keep.
            let body = envelope.to_string().replacen(':', " : ", 1);
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), operation),
                Outcome::Forwarded,
                "{operation}"
            );
            assert_eq!(
                *frames.lock().expect("frames"),
                vec![frame_of(&body)],
                "{operation}"
            );
        }
    }

    /// Feature 002 T025 (contract Δ6): this case covers only the routing by `requestId`.
    /// T055 owns the end-to-end check of a `succeeded` response after a process `cancel`.
    #[test]
    fn a_succeeded_response_of_an_operation_reaches_the_renderer_by_its_request_id() {
        let (ipc, _frames) = ipc();
        ipc.set_session(Some(SESSION_ID.to_string()));
        let mut envelope = request(
            "loadHistory",
            json!({ "viewId": OPERATION_ID, "need": { "end": true } }),
        );
        envelope["repositoryId"] = json!(OPERATION_ID);
        let Submitted::Waiting(mut renderer, None) = ipc.submit(
            MAIN_WINDOW,
            LOCAL,
            &raw(&envelope.to_string()),
            "loadHistory",
        ) else {
            panic!("the shell forwards loadHistory");
        };
        assert!(
            renderer.try_recv().is_err(),
            "no response before the service sends one"
        );
        let frame = json!({
            "kind": "public",
            "response": { "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "succeeded", "result": { "rows": 2, "complete": false } },
        });
        let Some(ToRenderer::Response(response)) = renderer_message(&frame.to_string()) else {
            panic!("a public response frame");
        };
        ipc.deliver(response.clone());
        assert_eq!(renderer.try_recv().ok(), Some(response));
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
            let permission = format!("permissions/autogenerated/{command}.toml");
            assert!(
                read(&permission).contains(&format!("identifier = \"{grant}\"")),
                "{permission}"
            );
        }
    }

    /// Feature 003 contract Δ1. The four service operations reach the service byte for byte.
    #[test]
    fn the_four_feature_003_service_requests_are_forwarded_byte_for_byte() {
        let four = [
            ("readTracking", json!({})),
            ("reviewSync", json!({ "action": "fetch-all" })),
            (
                "sync",
                json!({ "syncReviewToken": OPERATION_ID, "start": true }),
            ),
            ("connectInTerminal", json!({ "operationId": OPERATION_ID })),
        ];
        for (operation, payload) in four {
            assert!(OPERATIONS.contains(&operation), "{operation}");
            assert!(!NATIVE_FIRST.contains(&operation), "{operation}");
            let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
            let body = request(operation, payload).to_string();
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), operation),
                Outcome::Forwarded,
                "{operation}"
            );
            assert_eq!(
                *frames.lock().expect("frames"),
                vec![frame_of(&body)],
                "{operation}"
            );
            assert_eq!(*native.prepares.lock().expect("prepares"), 0, "{operation}");
        }
    }

    /// Feature 003 contract Δ1: `clone` is native-first, so the service gets the payload of the native step.
    #[test]
    fn a_clone_runs_its_native_step_and_forwards_the_native_payload() {
        assert!(NATIVE_FIRST.contains(&"clone"));
        let native_payload = json!({ "url": "https://example.test/a.git", "bootstrapId": OPERATION_ID, "cloneId": SESSION_ID });
        let forwarded = native_payload.clone();
        let (ipc, frames, native) = connected(Box::new(move || {
            Ok(Some(Prepared {
                payload: forwarded.clone(),
                path: None,
            }))
        }));
        let clone = request(
            "clone",
            json!({ "url": "https://example.test/a.git", "destination": "C:\\src\\a", "keyFile": "none" }),
        );
        assert_eq!(send(&ipc, &clone), Outcome::Forwarded);
        assert_eq!(*native.prepares.lock().expect("prepares"), 1);
        let frames = frames.lock().expect("frames");
        let frame: Value = serde_json::from_str(&frames[0]).expect("frame");
        assert_eq!(
            frame,
            json!({ "kind": "public", "request": request("clone", native_payload) })
        );
    }

    /// Feature 003 contract Δ1 and Δ3: the shell answers the six settings operations itself, also without a service session.
    /// The native answer gives `succeeded`, `canceled` for a canceled picker, or `failed` with its result.
    #[test]
    fn the_six_settings_operations_are_answered_natively_and_never_forwarded() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        ipc.set_session(None);
        for (operation, payload) in [
            ("readSyncSettings", json!({})),
            ("setSshClient", json!({ "kind": "plink" })),
            ("setDefaultPullAction", json!({ "action": "fetch" })),
            ("clearSyncPath", json!({ "target": "cloneFolder" })),
        ] {
            assert!(NATIVE_FIRST.contains(&operation), "{operation}");
            assert_eq!(
                send(&ipc, &request(operation, payload)),
                Outcome::Answer(
                    json!({ "requestId": REQUEST_ID, "state": "succeeded", "result": { "operation": operation, "entries": [] } })
                ),
                "{operation}"
            );
        }
        assert_eq!(
            send(
                &ipc,
                &request("chooseSyncPath", json!({ "target": "plink" }))
            ),
            Outcome::Answer(
                json!({ "requestId": REQUEST_ID, "state": "canceled", "code": "CANCELED" })
            )
        );
        assert_eq!(
            send(&ipc, &request("launchPuttygen", json!({}))),
            Outcome::Answer(
                json!({ "requestId": REQUEST_ID, "state": "failed", "code": "PUTTY_UNAVAILABLE", "result": putty_result() })
            )
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 6);
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0);
    }

    /// Feature 003 contract Δ1: the Rust checks of the clone URL and the `chooseSyncPath` target fields run on the live path.
    #[test]
    fn the_feature_003_rust_checks_refuse_before_any_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let destination = "C:\\src\\a";
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        for envelope in [
            // 2,049 two-byte characters: 4,098 UTF-8 bytes in 2,049 UTF-16 units.
            request(
                "clone",
                json!({ "url": "\u{e9}".repeat(2049), "destination": destination, "keyFile": "none" }),
            ),
            request(
                "clone",
                json!({ "url": "https://example.test/a\n.git", "destination": destination, "keyFile": "none" }),
            ),
            request(
                "clone",
                json!({ "url": "https://example.test/a.git", "destination": "\\\\?\\C:\\src\\a", "keyFile": "none" }),
            ),
            request(
                "chooseSyncPath",
                json!({ "target": "remoteKey", "worktreeKey": key }),
            ),
            request(
                "chooseSyncPath",
                json!({ "target": "plink", "worktreeKey": key, "remote": "origin" }),
            ),
            request(
                "clearSyncPath",
                json!({ "target": "cloneFolder", "remote": "origin" }),
            ),
        ] {
            assert_eq!(
                send(&ipc, &envelope),
                rejected("INVALID_REQUEST"),
                "{envelope}"
            );
        }
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
    }

    /// Feature 004 contract Δ1: the service operations reach the service byte for byte, and no native step runs.
    /// `revealPath` reaches the service, which sends the private `reveal` request. Only the `worktree-add` review is native-first.
    #[test]
    fn the_feature_004_service_requests_are_forwarded_byte_for_byte() {
        let target = |mut envelope: Value, generation: bool| {
            envelope["repositoryId"] = json!(OPERATION_ID);
            if generation {
                envelope["repositoryGeneration"] = json!(3);
            }
            envelope
        };
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let cases = [
            target(request("readBranches", json!({})), true),
            target(request("readWorktrees", json!({})), true),
            target(request("readGitSettings", json!({})), false),
            request("readGitSettings", json!({})),
            target(
                request(
                    "reviewWorkbench",
                    json!({ "action": "switch", "target": { "ref": "refs/heads/main" }, "choice": "keep" }),
                ),
                true,
            ),
            target(
                request(
                    "reviewWorkbench",
                    json!({ "action": "create-branch", "name": "topic", "start": oid, "switchTo": true }),
                ),
                true,
            ),
            target(
                request(
                    "runWorkbench",
                    json!({ "workbenchToken": OPERATION_ID, "start": true }),
                ),
                false,
            ),
            target(
                request(
                    "applyFiles",
                    json!({ "snapshotId": OPERATION_ID, "entryIds": [SESSION_ID], "direction": "stage", "kind": "selected" }),
                ),
                false,
            ),
            request(
                "revealPath",
                json!({ "repositoryId": OPERATION_ID, "entryId": SESSION_ID }),
            ),
        ];
        for envelope in cases {
            let operation = envelope["operation"]
                .as_str()
                .expect("operation")
                .to_string();
            assert!(OPERATIONS.contains(&operation.as_str()), "{operation}");
            let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
            let body = envelope.to_string();
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), &operation),
                Outcome::Forwarded,
                "{envelope}"
            );
            assert_eq!(
                *frames.lock().expect("frames"),
                vec![frame_of(&body)],
                "{operation}"
            );
            assert_eq!(*native.prepares.lock().expect("prepares"), 0, "{operation}");
        }
        for operation in [
            "revealPath",
            "readGitSettings",
            "runWorkbench",
            "applyFiles",
        ] {
            assert!(!NATIVE_FIRST.contains(&operation), "{operation}");
        }
    }

    /// Feature 004 contract Δ1 and data-model §13: the shell answers `setSwitchChoice` itself, also without a service session.
    #[test]
    fn set_switch_choice_is_answered_natively_and_never_forwarded() {
        assert!(NATIVE_FIRST.contains(&"setSwitchChoice"));
        assert!(NATIVE_ANSWERS.contains(&"setSwitchChoice"));
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        for session in [Some(SESSION_ID.to_string()), None] {
            ipc.set_session(session);
            for choice in ["keep", "stash"] {
                assert_eq!(
                    send(
                        &ipc,
                        &request("setSwitchChoice", json!({ "choice": choice }))
                    ),
                    Outcome::Answer(
                        json!({ "requestId": REQUEST_ID, "state": "succeeded", "result": { "operation": "setSwitchChoice", "entries": [] } })
                    ),
                    "{choice}"
                );
            }
        }
        assert_eq!(*native.prepares.lock().expect("prepares"), 4);
        assert!(
            native.prepared.lock().expect("prepared").is_empty(),
            "no prepare step"
        );
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0);
    }

    /// Feature 004 contract Δ1 and Δ3: the shell answers `chooseWorktreeFolder` itself and never forwards it.
    #[test]
    fn choose_worktree_folder_is_answered_natively_and_never_forwarded() {
        assert!(NATIVE_FIRST.contains(&"chooseWorktreeFolder"));
        assert!(NATIVE_ANSWERS.contains(&"chooseWorktreeFolder"));
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        assert_eq!(
            send(
                &ipc,
                &request(
                    "chooseWorktreeFolder",
                    json!({ "repositoryId": OPERATION_ID })
                )
            ),
            Outcome::Answer(
                json!({ "requestId": REQUEST_ID, "state": "succeeded", "result": { "operation": "chooseWorktreeFolder", "entries": [] } })
            )
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 1);
        assert!(native.prepared.lock().expect("prepared").is_empty());
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0);
    }

    /// Feature 004 contract Δ1 and Δ3: `openWorktree` and the `worktree-add` review run their native step.
    /// The step of the review gets the `repositoryId` of the envelope. The service gets the native payload.
    #[test]
    fn open_worktree_and_the_worktree_add_review_forward_the_native_payload() {
        let native_payload = json!({ "repositoryId": OPERATION_ID, "bootstrapId": SESSION_ID });
        let forwarded = native_payload.clone();
        let (ipc, frames, native) = connected(Box::new(move || {
            Ok(Some(Prepared {
                payload: forwarded.clone(),
                path: None,
            }))
        }));
        let open = request(
            "openWorktree",
            json!({ "repositoryId": OPERATION_ID, "path": "/home/u/repo-wt" }),
        );
        assert_eq!(send(&ipc, &open), Outcome::Forwarded);
        let mut review = request(
            "reviewWorkbench",
            json!({ "action": "worktree-add", "branch": { "existing": "refs/heads/topic" }, "path": "C:\\src\\wt" }),
        );
        review["repositoryId"] = json!(OPERATION_ID);
        review["repositoryGeneration"] = json!(3);
        let mut second = review.clone();
        second["requestId"] = json!(SESSION_ID);
        assert_eq!(send(&ipc, &second), Outcome::Forwarded);
        assert_eq!(
            *native.prepared.lock().expect("prepared"),
            vec![
                ("openWorktree".to_string(), open["payload"].clone()),
                (
                    "reviewWorkbench".to_string(),
                    json!({ "action": "worktree-add", "branch": { "existing": "refs/heads/topic" }, "path": "C:\\src\\wt", "repositoryId": OPERATION_ID }),
                ),
            ]
        );
        let frames = frames.lock().expect("frames");
        let frame = |at: usize| -> Value { serde_json::from_str(&frames[at]).expect("frame") };
        assert_eq!(
            frame(0),
            json!({ "kind": "public", "request": request("openWorktree", native_payload.clone()) })
        );
        let mut expected = second.clone();
        expected["payload"] = native_payload;
        assert_eq!(frame(1), json!({ "kind": "public", "request": expected }));
    }

    /// Feature 004 contract Δ1: the checks that typify drops refuse before any dialog.
    /// The path rule, a branch name of 1 to 255 UTF-8 bytes, an existing branch under `refs/heads/`, and the stored switch choices.
    #[test]
    fn the_feature_004_rust_checks_refuse_before_any_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let review = |payload: Value| {
            let mut envelope = request("reviewWorkbench", payload);
            envelope["repositoryId"] = json!(OPERATION_ID);
            envelope["repositoryGeneration"] = json!(3);
            envelope
        };
        let add = |branch: Value, path: &str| {
            review(json!({ "action": "worktree-add", "branch": branch, "path": path }))
        };
        let wide = "\u{e9}".repeat(128);
        assert_eq!(wide.len(), 256);
        let mut bound = add(json!({ "existing": "refs/heads/topic" }), "C:\\src\\wt");
        bound["payload"]["bootstrapId"] = json!(SESSION_ID);
        for envelope in [
            add(json!({ "existing": "refs/heads/topic" }), "src\\wt"),
            add(
                json!({ "existing": "refs/heads/topic" }),
                "\\\\?\\C:\\src\\wt",
            ),
            add(json!({ "existing": "refs/heads/topic" }), ""),
            add(json!({ "new": wide, "start": oid }), "C:\\src\\wt"),
            add(json!({ "new": "", "start": oid }), "C:\\src\\wt"),
            add(json!({ "existing": "refs/tags/v1" }), "C:\\src\\wt"),
            add(json!({ "existing": "refs/heads/" }), "C:\\src\\wt"),
            add(json!({ "existing": "topic" }), "C:\\src\\wt"),
            bound,
            request("setSwitchChoice", json!({ "choice": "discard" })),
            request("setSwitchChoice", json!({})),
            request("chooseWorktreeFolder", json!({})),
            request(
                "chooseWorktreeFolder",
                json!({ "repositoryId": OPERATION_ID, "path": "C:\\src" }),
            ),
            request(
                "openWorktree",
                json!({ "repositoryId": OPERATION_ID, "path": "" }),
            ),
            request("openWorktree", json!({ "path": "C:\\src\\wt" })),
        ] {
            assert_eq!(
                send(&ipc, &envelope),
                rejected("INVALID_REQUEST"),
                "{envelope}"
            );
        }
        let good = add(
            json!({ "new": "\u{e9}".repeat(127), "start": oid }),
            "C:\\src\\wt",
        );
        assert!(schema::native_first(&good).is_ok(), "254 bytes pass");
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
    }

    // ---- Feature 006 (contract Δ1, Δ3, Δ7) ----

    /// Feature 006 contract Δ1: the four dictionary service operations reach the service byte for byte, and no native step runs.
    #[test]
    fn the_feature_006_service_requests_are_forwarded_byte_for_byte() {
        let cases = [
            request("listDictionaries", json!({})),
            request(
                "readDictionary",
                json!({ "language": "uk", "file": "index.dic", "offset": 1_048_576 }),
            ),
            request("downloadDictionary", json!({ "language": "uk" })),
            request("removeDictionary", json!({ "language": "uk" })),
        ];
        for envelope in cases {
            let operation = envelope["operation"]
                .as_str()
                .expect("operation")
                .to_string();
            assert!(OPERATIONS.contains(&operation.as_str()), "{operation}");
            assert!(!NATIVE_FIRST.contains(&operation.as_str()), "{operation}");
            let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
            let body = envelope.to_string();
            assert_eq!(
                ipc.handle(MAIN_WINDOW, LOCAL, &raw(&body), &operation),
                Outcome::Forwarded,
                "{envelope}"
            );
            assert_eq!(
                *frames.lock().expect("frames"),
                vec![frame_of(&body)],
                "{operation}"
            );
            assert_eq!(*native.prepares.lock().expect("prepares"), 0, "{operation}");
        }
    }

    /// Feature 006 contract Δ1: a `readDictionary` success reaches the renderer as the file size and the chunk bytes.
    /// Every other response stays the same JSON. A result outside the `DictionaryChunk` rules gives `SERVICE_UNAVAILABLE`.
    #[test]
    fn a_read_dictionary_success_reaches_the_renderer_as_the_raw_size_and_chunk() {
        let succeeded = |result: Value| json!({ "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "succeeded", "result": result });
        let chunk = |file: &str, size: u64, offset: u64, bytes: &str| json!({ "language": "uk", "file": file, "size": size, "offset": offset, "bytes": bytes });
        let raw = |result: Value| match dictionary_response(succeeded(result)) {
            Ok(InvokeResponseBody::Raw(body)) => body,
            other => panic!("raw body expected: {other:?}"),
        };
        assert_eq!(
            raw(chunk("index.aff", 3, 0, "U0VU")),
            [3, 0, 0, 0, b'S', b'E', b'T']
        );
        let full = vec![b'a'; 1_048_576];
        let size = DICTIONARY_CHUNK_BYTES + 3;
        let first = raw(chunk(
            "index.dic",
            size,
            0,
            &crate::process_requests::encode_base64(&full),
        ));
        assert_eq!(first[..4], 1_048_579_u32.to_le_bytes());
        assert_eq!(first[4..], full[..]);
        assert_eq!(
            raw(chunk("index.dic", size, DICTIONARY_CHUNK_BYTES, "U0VU")),
            [3, 0, 16, 0, b'S', b'E', b'T']
        );
        for response in [
            json!({ "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "failed", "code": "DICTIONARY_UNAVAILABLE", "result": { "reason": "changed" } }),
            json!({ "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "canceled", "code": "CANCELED" }),
            json!({ "requestId": REQUEST_ID, "state": "rejected", "code": "BUSY" }),
            json!({ "requestId": REQUEST_ID, "state": "unknown", "code": "STATE_UNKNOWN" }),
        ] {
            match dictionary_response(response.clone()) {
                Ok(InvokeResponseBody::Json(text)) => {
                    assert_eq!(
                        serde_json::from_str::<Value>(&text).expect("JSON"),
                        response
                    );
                }
                other => panic!("JSON expected for {response}: {other:?}"),
            }
        }
        let good = chunk("index.aff", 3, 0, "U0VU");
        let with = |key: &str, value: Value| {
            let mut result = good.clone();
            result[key] = value;
            result
        };
        let mut without_file = good.clone();
        without_file.as_object_mut().expect("object").remove("file");
        // One base64 group above the 1,398,104 characters of DICTIONARY_CHUNK_BYTES.
        let above = "A".repeat(4 * 349_527);
        for result in [
            json!("U0VU"),
            with("sha256", json!("")),
            without_file,
            with("language", json!("UK")),
            with("file", json!("entry.json")),
            with("size", json!(0)),
            with("size", json!(3.5)),
            with("size", json!(12_582_913)),
            with("offset", json!(1)),
            with("offset", json!(DICTIONARY_CHUNK_BYTES)),
            with("bytes", json!("U0V!")),
            with("bytes", json!("U0VUVA==")),
            with("bytes", json!(above)),
            with("size", json!(4)),
        ] {
            assert_eq!(
                dictionary_response(succeeded(result.clone())).err(),
                Some("SERVICE_UNAVAILABLE"),
                "{result}"
            );
        }
    }

    /// Feature 006 contract Δ1 and Δ3: the shell answers `setSpelling` and `openLicenceLink` itself, also without a service session.
    #[test]
    fn set_spelling_and_open_licence_link_are_answered_natively_and_never_forwarded() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        let cases = [
            (
                "setSpelling",
                json!({ "enabled": false, "languages": ["uk", "en"] }),
            ),
            ("openLicenceLink", json!({ "language": "en" })),
            // Feature 007 contracts/release.md §5.
            ("openReleaseLink", json!({ "target": "tag-source" })),
        ];
        for session in [Some(SESSION_ID.to_string()), None] {
            ipc.set_session(session);
            for (operation, payload) in &cases {
                assert!(
                    NATIVE_FIRST.contains(operation) && NATIVE_ANSWERS.contains(operation),
                    "{operation}"
                );
                assert_eq!(
                    send(&ipc, &request(operation, payload.clone())),
                    Outcome::Answer(
                        json!({ "requestId": REQUEST_ID, "state": "succeeded", "result": { "operation": operation, "entries": [] } })
                    ),
                    "{operation}"
                );
            }
        }
        assert_eq!(*native.prepares.lock().expect("prepares"), 6);
        assert!(
            native.prepared.lock().expect("prepared").is_empty(),
            "no prepare step"
        );
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0);
    }

    /// Feature 006 contract Δ3 `importDictionary`: the native step runs first, and the service gets the native payload.
    #[test]
    fn import_dictionary_runs_its_native_step_and_forwards_the_native_payload() {
        assert!(NATIVE_FIRST.contains(&"importDictionary"));
        assert!(!NATIVE_ANSWERS.contains(&"importDictionary"));
        let native_payload = json!({ "language": "uk", "folder": "D:\\dictionaries\\uk" });
        let forwarded = native_payload.clone();
        let (ipc, frames, native) = connected(Box::new(move || {
            Ok(Some(Prepared {
                payload: forwarded.clone(),
                path: None,
            }))
        }));
        let envelope = request("importDictionary", json!({ "language": "uk" }));
        assert_eq!(send(&ipc, &envelope), Outcome::Forwarded);
        assert_eq!(
            *native.prepared.lock().expect("prepared"),
            vec![("importDictionary".to_string(), json!({ "language": "uk" }))]
        );
        let frames = frames.lock().expect("frames");
        let frame: Value = serde_json::from_str(&frames[0]).expect("frame");
        assert_eq!(
            frame,
            json!({ "kind": "public", "request": request("importDictionary", native_payload) })
        );
    }

    /// Feature 006 data-model §8 and contract Δ3: the checks that typify drops, and the strict payloads, refuse before any dialog.
    #[test]
    fn the_feature_006_rust_checks_refuse_before_any_dialog() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        for envelope in [
            request(
                "setSpelling",
                json!({ "enabled": true, "languages": ["en", "uk", "de", "fr"] }),
            ),
            request(
                "setSpelling",
                json!({ "enabled": true, "languages": ["uk", "uk"] }),
            ),
            request("setSpelling", json!({ "enabled": "yes", "languages": [] })),
            request(
                "setSpelling",
                json!({ "enabled": true, "languages": ["EN"] }),
            ),
            request(
                "openLicenceLink",
                json!({ "language": "en", "url": "https://example.test/" }),
            ),
            request(
                "openReleaseLink",
                json!({ "target": "tag-source", "url": "https://example.test/" }),
            ),
            request("openReleaseLink", json!({ "target": "release" })),
            request("openReleaseLink", json!({})),
            request(
                "importDictionary",
                json!({ "language": "uk", "folder": "C:\\uk" }),
            ),
            request("importDictionary", json!({})),
        ] {
            assert_eq!(
                send(&ipc, &envelope),
                rejected("INVALID_REQUEST"),
                "{envelope}"
            );
        }
        assert_eq!(*native.prepares.lock().expect("prepares"), 0, "no dialog");
        assert!(frames.lock().expect("frames").is_empty());
    }

    /// Feature 006 contract Δ7: the renderer CSP admits WebAssembly compilation and the app origin.
    /// Every other directive keeps its earlier value.
    #[test]
    fn the_csp_admits_wasm_compilation_and_the_app_origin_and_keeps_every_other_directive() {
        let config: Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"))
                .expect("tauri.conf.json"),
        )
        .expect("JSON");
        assert_eq!(
            config["app"]["security"]["csp"],
            json!({
                "default-src": "'self'",
                "script-src": "'self' 'wasm-unsafe-eval'",
                "style-src": "'self'",
                "style-src-elem": "'self' 'unsafe-inline'",
                "style-src-attr": "'unsafe-inline'",
                "connect-src": "ipc: http://ipc.localhost 'self'",
                "object-src": "'none'",
                "base-uri": "'none'",
                "form-action": "'none'",
            })
        );
    }

    /// Feature 002 plan.md P7 and contract Δ3 "readHistory": no allowlist entry, command, handler, or grant remains.
    #[test]
    fn the_allowlist_has_no_read_history() {
        let read = |path: &str| {
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).expect(path)
        };
        assert!(!OPERATIONS.contains(&"readHistory"));
        assert!(!read("build.rs").contains("\"read_history\""));
        assert!(!read("src/lib.rs").contains("ipc::read_history,"));
        let capability: Value =
            serde_json::from_str(&read("capabilities/main.json")).expect("capability");
        let grants = capability["permissions"].as_array().expect("permissions");
        assert!(!grants.contains(&json!("allow-read-history")));
        assert!(
            !Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("permissions/autogenerated/read_history.toml")
                .exists()
        );
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

    /// Contract §3 `openRecentRepository`: the shell forwards it as `restoreWorkspace` with the native payload.
    #[test]
    fn an_open_of_a_recent_entry_forwards_as_restore_workspace() {
        let (ipc, frames, _native) = connected(Box::new(|| {
            Ok(Some(Prepared {
                payload: json!({ "bootstrapId": OPERATION_ID }),
                path: None,
            }))
        }));
        let open = request("openRecentRepository", json!({ "entryId": OPERATION_ID }));
        assert_eq!(send(&ipc, &open), Outcome::Forwarded);
        let frames = frames.lock().expect("frames");
        let frame: Value = serde_json::from_str(&frames[0]).expect("frame");
        assert_eq!(
            frame,
            json!({ "kind": "public", "request": request("restoreWorkspace", json!({ "bootstrapId": OPERATION_ID })) })
        );
    }

    /// Contract §9: a not-found Windows folder ends `failed` before any forward.
    #[test]
    fn a_failed_native_step_answers_failed_with_its_result_and_forwards_nothing() {
        let result = json!({ "reason": "absent", "path": "C:\\gone" });
        let failed = result.clone();
        let (ipc, frames, _native) = connected(Box::new(move || {
            Err(Ended::Failed("REPOSITORY_UNAVAILABLE", failed.clone()))
        }));
        let open = request("openRecentRepository", json!({ "entryId": OPERATION_ID }));
        assert_eq!(
            send(&ipc, &open),
            Outcome::Answer(
                json!({ "requestId": REQUEST_ID, "state": "failed", "code": "REPOSITORY_UNAVAILABLE", "result": result })
            )
        );
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0, "no request waits for a response");
    }

    /// Contract §3: the shell answers the list and a removal itself, also without a service session.
    #[test]
    fn the_recent_list_and_a_removal_are_answered_natively_and_never_forwarded() {
        let (ipc, frames, native) = connected(Box::new(|| Ok(None)));
        ipc.set_session(None);
        assert_eq!(
            send(&ipc, &request("listRecentRepositories", json!({}))),
            Outcome::Answer(
                json!({ "requestId": REQUEST_ID, "state": "succeeded", "result": { "operation": "listRecentRepositories", "entries": [] } })
            )
        );
        assert_eq!(
            send(
                &ipc,
                &request("removeRecentRepository", json!({ "entryId": OPERATION_ID }))
            ),
            rejected("UNKNOWN_TARGET")
        );
        assert_eq!(
            send(
                &ipc,
                &request("removeRecentRepository", json!({ "path": "C:\\repo" }))
            ),
            rejected("INVALID_REQUEST"),
            "the generated type refuses another field"
        );
        assert_eq!(*native.prepares.lock().expect("prepares"), 2);
        assert!(frames.lock().expect("frames").is_empty());
        assert_eq!(pending(&ipc), 0);
    }

    #[test]
    fn a_prepared_request_above_2_mib_gets_frame_limit_and_leaves_no_pending_request() {
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
        let (ipc, frames, native) =
            connected(Box::new(|| Err(Ended::Rejected("UNSUPPORTED_REPOSITORY"))));
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
            // Feature 002 plan.md P7: the 001 operation is retired.
            "readHistory",
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
        let valid = json!({ "requestId": REQUEST_ID, "operationId": OPERATION_ID, "state": "accepted", "phase": "fetch", "path": "libs/a", "counters": { "index": 1 }, "stalled": true });
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
