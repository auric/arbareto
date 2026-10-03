// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::bootstrap::{Contexts, read_identity};
use crate::dialogs::{self, Chosen, Dialogs, Proposal, Registered};
use crate::env_sanitize::sanitize;
use crate::framing::{FrameError, read_frame, write_frame};
use crate::ipc::{Ipc, MAIN_WINDOW, NativeFirst, ToRenderer, renderer_message};
use crate::jobs::{Job, Supervisor};
use crate::process_requests::{
    CHUNK_BYTES, Code, Config, Fields, Owned, ProcessRequests, decode_strict, identifier,
    is_identifier, keys, path, wait,
};
use crate::settings::{
    self, Confirm, MUTATIONS, Marker, Markers, SavedGit, Settings, Started, StartedReply, Trust,
    is_hex,
};
use crate::spawn::{Input, SpawnRequest, spawn};

/// tauri-build copies `externalBin` next to the application executable without the target triple (tauri-build lib.rs:140-167).
/// The NSIS bundle installs it beside `arbareto.exe` too.
const SIDECAR: &str = "arbareto-git.exe";
/// The contract sets no bound for the handshake reply. A missing reply counts as a failed handshake (contract §2).
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// The progress event of the main window. Contract §2 names no channel for progress events.
const PROGRESS_EVENT: &str = "operation-progress";

const INVALID: Code = "INVALID_REQUEST";
const UNAVAILABLE: Code = "SERVICE_UNAVAILABLE";

/// The native facts of the startup handshake (contract §6 "Startup handshake").
pub struct Facts {
    pub platform_scope: &'static str,
    pub os_build: u32,
    pub webview2_version: String,
}

/// The native settings, recovery markers, and trust records (data-model §1, contract §6 and §7).
pub struct Stores {
    pub settings_path: PathBuf,
    pub settings: Mutex<Settings>,
    pub markers: Markers,
    pub trust: Trust,
}

/// The compiled Git service, its Job, and the frame routes of its pipes (contract §1 and §6).
pub struct Service {
    app: AppHandle,
    pub ipc: Arc<Ipc>,
    requests: Arc<ProcessRequests>,
    jobs: Arc<Supervisor>,
    contexts: Arc<Contexts>,
    dialogs: Arc<Dialogs>,
    stores: OnceLock<Stores>,
    stdin: Arc<Mutex<Option<File>>>,
    job: Mutex<Option<Job>>,
    /// The handshake reply, until `connect` takes it. `None` after a failed launch.
    handshake: Mutex<Option<mpsc::Receiver<Option<String>>>>,
    /// The count of service exits. A dialog result from before an exit changes nothing.
    exits: AtomicU64,
    closing: AtomicBool,
}

impl Service {
    /// Starts the service process. `connect` sends the startup handshake later (plan.md "Cold-start critical path").
    pub fn start(app: &AppHandle) -> Result<Arc<Service>, Box<dyn std::error::Error>> {
        // The application-owned launch directory, never a repository (contract §7).
        let launch_directory = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&launch_directory)?;
        let environment = sanitize(std::env::vars_os().collect());
        let jobs = Supervisor::start()?;
        let contexts = Arc::new(Contexts::new(""));
        let stdin: Arc<Mutex<Option<File>>> = Arc::default();
        let sink = {
            let stdin = Arc::clone(&stdin);
            Arc::new(move |body: String| write(&stdin, &body))
        };
        let requests = ProcessRequests::new(
            Config {
                launch_directory: launch_directory.clone(),
                base_environment: environment.clone(),
                argument_prefix: Vec::new(),
            },
            Arc::clone(&contexts),
            Arc::clone(&jobs),
            sink.clone(),
        );
        let service = Arc::new(Service {
            app: app.clone(),
            ipc: Arc::new(Ipc::new(sink)),
            requests,
            jobs,
            contexts,
            dialogs: Arc::new(Dialogs::new(app.clone())),
            stores: OnceLock::new(),
            stdin,
            job: Mutex::new(None),
            handshake: Mutex::new(None),
            exits: AtomicU64::new(0),
            closing: AtomicBool::new(false),
        });
        let native: Weak<Service> = Arc::downgrade(&service);
        let native: Weak<dyn NativeFirst> = native;
        service.ipc.set_native(native);
        let me = Arc::downgrade(&service);
        service
            .requests
            .set_git_confirmation(Box::new(move |path, version| {
                me.upgrade()
                    .map_or(Registered::Declined, |me| me.confirm_git(path, version))
            }));
        service.launch(&launch_directory, &environment);
        Ok(service)
    }

    fn launch(self: &Arc<Self>, launch_directory: &Path, environment: &[(OsString, OsString)]) {
        let Ok(program) = std::env::current_exe().map(|exe| exe.with_file_name(SIDECAR)) else {
            return;
        };
        let Ok(job) = Job::create() else {
            return;
        };
        let Ok(spawned) = spawn(
            &SpawnRequest {
                program: &program,
                arguments: &[],
                environment,
                current_dir: launch_directory,
                wsl: false,
                input: Input::Stream,
            },
            &mut |process| job.assign(process),
        ) else {
            return;
        };
        let process = Owned(spawned.process);
        *lock(&self.job) = Some(job);
        *lock(&self.stdin) = spawned.stdin;

        let mut stderr = spawned.stderr;
        // The shell retains no service stderr byte, which stays within the §5 diagnostic bound.
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; CHUNK_BYTES];
            while matches!(stderr.read(&mut buffer), Ok(read) if read > 0) {}
        });
        let (handshake, reply) = mpsc::channel();
        *lock(&self.handshake) = Some(reply);
        let me = Arc::clone(self);
        let stdout = spawned.stdout;
        std::thread::spawn(move || me.read(stdout, &handshake));
        let me = Arc::clone(self);
        std::thread::spawn(move || me.watch(process));
    }

    /// Sends the startup handshake and waits for its reply. False means that no service session runs (contract §2).
    pub fn connect(&self, facts: &Facts, stores: Stores) -> bool {
        let stores = self.stores.get_or_init(|| stores);
        let Some(reply) = lock(&self.handshake).take() else {
            return false;
        };
        write(&self.stdin, &self.handshake_frame(facts, stores));
        match reply.recv_timeout(HANDSHAKE_WAIT) {
            Ok(Some(session_id)) => {
                self.ipc.set_session(Some(session_id));
                true
            }
            // A failed handshake ends the service. A missing reply ends it here.
            _ => {
                drop(lock(&self.job).take());
                false
            }
        }
    }

    /// The startup handshake (contract §6 "Startup handshake"). Each handshake rescans the markers and the records.
    fn handshake_frame(&self, facts: &Facts, stores: &Stores) -> String {
        let scan = stores.markers.scan();
        let mut handshake = json!({
            "version": 1,
            "restarted": false,
            "platformScope": facts.platform_scope,
            "osBuild": facts.os_build,
            "webView2Version": facts.webview2_version,
            "buildIdentity": {
                "version": env!("CARGO_PKG_VERSION"),
                "commit": env!("ARBARETO_BUILD_IDENTITY"),
                "signing": "unsigned",
            },
            "markers": scan.markers.iter().map(Marker::handshake).collect::<Vec<_>>(),
            "unloadedMarkers": scan.unloaded,
            "trustRecords": stores.trust.records(),
        });
        let settings = lock(&stores.settings).clone();
        if let Some(saved_git) = dialogs::startup_context(&settings, &self.contexts, Instant::now())
        {
            handshake["savedGit"] = saved_git;
        }
        json!({ "kind": "handshake", "handshake": handshake }).to_string()
    }

    /// Reads the service frames until end-of-file.
    fn read(self: &Arc<Self>, mut stdout: File, handshake: &mpsc::Sender<Option<String>>) {
        loop {
            match read_frame(&mut stdout) {
                Ok(Some(body)) => self.route(&body, handshake),
                Err(FrameError::InvalidUtf8) => {}
                // A length above the frame bound leaves the body unread, so the pipe loses its frame boundary.
                Err(FrameError::FrameLimit) => {
                    drop(lock(&self.job).take());
                    return;
                }
                Ok(None) | Err(_) => return,
            }
        }
    }

    /// Multiplexes the frame kinds of contract §1. No `process`, `mutation`, `trust`, or `handshake` frame reaches the renderer.
    fn route(self: &Arc<Self>, body: &str, handshake: &mpsc::Sender<Option<String>>) {
        match renderer_message(body) {
            Some(ToRenderer::Response(response)) => return self.ipc.deliver(response),
            Some(ToRenderer::Progress(progress)) => {
                let _ = self.app.emit_to(MAIN_WINDOW, PROGRESS_EVENT, progress);
                return;
            }
            None => {}
        }
        let Some(frame) = decode_strict(body) else {
            return;
        };
        match frame.get("kind").and_then(Value::as_str) {
            Some("process") => self.requests.handle(body),
            Some("handshake") => {
                let _ = handshake.send(session_id(&frame));
            }
            Some("mutation") => self.mutation(&frame),
            Some("trust") => self.trust(&frame),
            _ => {}
        }
    }

    /// Writes one `{"kind":"<kind>","<kind>":{…}}` frame.
    fn send(&self, kind: &str, body: Value) {
        let mut frame = Map::new();
        frame.insert("kind".to_string(), json!(kind));
        frame.insert(kind.to_string(), body);
        write(&self.stdin, &Value::Object(frame).to_string());
    }

    /// The `mutation` frames of contract §6 "Channel frames".
    fn mutation(&self, frame: &Value) {
        let (Some(stores), Some(request)) = (self.stores.get(), body(frame, "mutation")) else {
            return;
        };
        let call_id = call_id(request);
        let handled = match request.get("type").and_then(Value::as_str) {
            Some("started") => call_id
                .ok_or(INVALID)
                .and_then(|call_id| self.started(stores, request, call_id)),
            Some("ended") => {
                keys(request, &["type", "operationId", "endProcesses"], &[]).and_then(|()| {
                    let operation_id = identifier(&request["operationId"])?;
                    let end_processes = request["endProcesses"].as_bool().ok_or(INVALID)?;
                    self.requests.ended(operation_id, end_processes);
                    stores.markers.ended(operation_id);
                    Ok(())
                })
            }
            Some("resolved") => keys(request, &["type", "markerId"], &[]).and_then(|()| {
                stores.markers.resolved(identifier(&request["markerId"])?);
                Ok(())
            }),
            _ => Err(INVALID),
        };
        if let (Err(code), Some(call_id)) = (handled, call_id) {
            self.send("mutation", refused(call_id, code));
        }
    }

    /// Replies only after the marker file is flushed, or with the failure class (contract §6 "Recovery markers").
    fn started(&self, stores: &Stores, request: &Fields, call_id: &str) -> Result<(), Code> {
        keys(
            request,
            &[
                "type",
                "callId",
                "operationId",
                "repositoryId",
                "kind",
                "worktreeRoot",
                "commonDirectory",
            ],
            &[],
        )?;
        let operation_id = identifier(&request["operationId"])?;
        identifier(&request["repositoryId"])?;
        let kind = request["kind"]
            .as_str()
            .filter(|kind| MUTATIONS.contains(kind))
            .ok_or(INVALID)?;
        let worktree_root = path(&request["worktreeRoot"])?;
        let common_directory = path(&request["commonDirectory"])?;
        let reply = stores.markers.started(&Started {
            operation_id,
            kind,
            worktree_root: &worktree_root,
            common_directory: &common_directory,
        });
        if let StartedReply::Marker(_) = reply
            && let Ok(identity) = read_identity(&common_directory)
        {
            self.requests.tag(operation_id, identity);
        }
        self.send("mutation", reply.reply(call_id));
        Ok(())
    }

    /// The `trust` frames of contract §6 "Channel frames".
    fn trust(self: &Arc<Self>, frame: &Value) {
        let (Some(stores), Some(request)) = (self.stores.get(), body(frame, "trust")) else {
            return;
        };
        let Some(call_id) = call_id(request) else {
            return;
        };
        let handled = match request.get("type").and_then(Value::as_str) {
            Some("confirm") => {
                confirm_request(request).map(|confirm| self.confirm_trust(confirm, call_id))
            }
            Some("revoke") => {
                keys(request, &["type", "callId", "commonDirectory"], &[]).and_then(|()| {
                    let common_directory = path(&request["commonDirectory"])?;
                    let ended = stores
                        .trust
                        .revoke(&common_directory, |tag| self.jobs.revoke(tag));
                    self.send(
                        "trust",
                        json!({ "type": "revoke", "callId": call_id, "endedProcesses": ended }),
                    );
                    Ok(())
                })
            }
            // T228 builds the `confirmRun` dialog. Until then, the shell answers as Cancel.
            Some("confirmRun") => {
                self.send(
                    "trust",
                    json!({ "type": "confirmRun", "callId": call_id, "result": "declined" }),
                );
                Ok(())
            }
            _ => Err(INVALID),
        };
        if let Err(code) = handled {
            self.send("trust", refused(call_id, code));
        }
    }

    /// Shows the trust confirmation on its own thread, so the frame reader keeps running.
    /// A service exit closes the dialog as Cancel, and the store then writes and deletes no record (contract §6).
    fn confirm_trust(self: &Arc<Self>, request: Confirm, call_id: &str) {
        let me = Arc::clone(self);
        let call_id = call_id.to_string();
        let exits = self.exits.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            let Some(stores) = me.stores.get() else {
                return;
            };
            let current = || me.exits.load(Ordering::SeqCst) == exits;
            let confirmed = stores.trust.confirm(&request, |request| {
                dialogs::confirm_trust(&*me.dialogs, request) && current()
            });
            if current() {
                me.send("trust", confirmed.reply(&call_id));
            }
        });
    }

    /// The Git selection confirmation of a `register` request with `confirm: true`.
    /// It names the stored version when the candidate is the saved path (contract §3 "Git proposal").
    fn confirm_git(&self, executable_path: &Path, version: &str) -> Registered {
        let saved = self
            .stores
            .get()
            .and_then(|stores| lock(&stores.settings).git.clone());
        let stored_version = saved
            .as_ref()
            .filter(|git| git.executable_path == executable_path)
            .map(|git| git.version.as_str());
        dialogs::confirm_git(
            &*self.dialogs,
            &Proposal {
                executable_path,
                version,
                stored_version,
            },
            &self.contexts,
            Instant::now(),
        )
    }

    /// Persists the Git selection after the service success and Use this Git (data-model §1).
    fn save_git(&self, stores: &Stores, result: &Value) {
        let Some(git_id) = result["gitInstallationId"].as_str() else {
            return;
        };
        let Some(digest) = result["digest"]
            .as_str()
            .filter(|digest| is_hex(digest, 64))
        else {
            return;
        };
        let Some((executable_path, version)) = self.requests.take_confirmed_git(git_id) else {
            return;
        };
        let mut settings = lock(&stores.settings);
        settings.git = Some(SavedGit {
            executable_path,
            version,
            digest: digest.to_string(),
        });
        let _ = settings::save(&stores.settings_path, &settings);
    }

    /// Waits for the service exit. The shell never restarts the service by itself.
    fn watch(&self, process: Owned) {
        while !wait(process.0, Duration::from_secs(3600)) {}
        drop(process);
        lock(&self.stdin).take();
        drop(lock(&self.job).take());
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        self.requests.service_exited();
        self.exits.fetch_add(1, Ordering::SeqCst);
        self.dialogs.cancel_open();
        self.contexts.restart("");
        self.ipc.set_session(None);
        let markers: Vec<Value> = self
            .stores
            .get()
            .map(|stores| {
                stores.markers.service_exited();
                stores
                    .markers
                    .scan()
                    .markers
                    .iter()
                    .map(renderer_marker)
                    .collect()
            })
            .unwrap_or_default();
        let _ = self.app.emit_to(
            MAIN_WINDOW,
            "service-stopped",
            json!({ "markers": markers }),
        );
    }

    /// Application close: the operation Jobs, then the lingering Jobs, then the service Job (contract §6 "Lingering Jobs").
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.jobs.close_all();
        drop(lock(&self.job).take());
        self.jobs.shutdown();
    }
}

impl NativeFirst for Service {
    fn prepare(&self, operation: &str, payload: &Value) -> Result<Option<Value>, &'static str> {
        let stores = self.stores.get().ok_or(UNAVAILABLE)?;
        let now = Instant::now();
        let chosen = match operation {
            "chooseGit" => {
                let saved = lock(&stores.settings).git.clone();
                dialogs::choose_git(&*self.dialogs, saved.as_ref(), &self.contexts, now)
            }
            "chooseRepository" => dialogs::choose_repository(&*self.dialogs, &self.contexts, now),
            "restoreWorkspace" => {
                let settings = lock(&stores.settings).clone();
                dialogs::restore_workspace(&settings, &self.contexts, now)
            }
            "dismissRecoveryMarker" => {
                let marker_id = payload["markerId"].as_str().ok_or(INVALID)?;
                let marker = stores.markers.get(marker_id).ok_or("UNKNOWN_TARGET")?;
                let bootstrap_id = dialogs::dismissal_context(&marker, &self.contexts, now)?;
                return Ok(Some(
                    json!({ "markerId": marker_id, "bootstrapId": bootstrap_id }),
                ));
            }
            _ => return Err(UNAVAILABLE),
        };
        Ok(match chosen {
            Chosen::Canceled => None,
            Chosen::Context { bootstrap_id, path } if operation == "chooseGit" => Some(
                json!({ "bootstrapId": bootstrap_id, "executablePath": path.to_string_lossy() }),
            ),
            Chosen::Context { bootstrap_id, .. } => Some(json!({ "bootstrapId": bootstrap_id })),
        })
    }

    fn finish(&self, operation: &str, payload: &Value, response: Value) -> Value {
        let Some(stores) = self
            .stores
            .get()
            .filter(|_| response["state"] == "succeeded")
        else {
            return response;
        };
        match operation {
            "chooseGit" => {
                self.save_git(stores, &response["result"]);
                response
            }
            // Contract §6 "Dismissal": the confirmation follows an allowed service result.
            "dismissRecoveryMarker" => {
                let marker_id = payload["markerId"].as_str().unwrap_or_default();
                let mut accepted = false;
                let dismissed = stores.markers.dismiss(marker_id, |marker| {
                    accepted = dialogs::confirm_dismissal(&*self.dialogs, marker);
                    accepted
                });
                if dismissed {
                    return response;
                }
                let (state, code) = if accepted {
                    ("failed", "RECOVERY_MARKER_FAILED")
                } else {
                    ("canceled", "CANCELED")
                };
                let mut answer = response;
                if let Some(fields) = answer.as_object_mut() {
                    fields.remove("result");
                    fields.insert("state".to_string(), json!(state));
                    fields.insert("code".to_string(), json!(code));
                }
                answer
            }
            _ => response,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Writes one frame. A failed write closes the service stdin.
fn write(stdin: &Mutex<Option<File>>, body: &str) {
    let mut stdin = lock(stdin);
    if let Some(pipe) = stdin.as_mut()
        && write_frame(pipe, body).is_err()
    {
        *stdin = None;
    }
}

/// The reply `{"kind":"handshake","handshake":{"sessionId":"<ID>"}}`. A failure reply gives `None`.
fn session_id(frame: &Value) -> Option<String> {
    let reply = frame.get("handshake")?.as_object()?;
    let session_id = reply.get("sessionId")?.as_str()?;
    (frame.as_object()?.len() == 2 && reply.len() == 1 && is_identifier(session_id))
        .then(|| session_id.to_string())
}

/// The inner object of a `{"kind":"<kind>","<kind>":{…}}` frame.
fn body<'a>(frame: &'a Value, kind: &str) -> Option<&'a Fields> {
    if frame.as_object()?.len() != 2 {
        return None;
    }
    frame.get(kind)?.as_object()
}

fn call_id(request: &Fields) -> Option<&str> {
    request
        .get("callId")
        .and_then(Value::as_str)
        .filter(|id| is_identifier(id))
}

fn refused(call_id: &str, code: Code) -> Value {
    json!({ "type": "refused", "callId": call_id, "code": code })
}

/// The `confirm` trust frame. `bound` comes only with `persist: false`.
fn confirm_request(request: &Fields) -> Result<Confirm, Code> {
    keys(
        request,
        &[
            "type",
            "callId",
            "worktreeRoot",
            "gitDirectory",
            "commonDirectory",
            "gitInstallationDigest",
            "fingerprint",
            "persist",
        ],
        &["bound"],
    )?;
    let digest = |key: &str| {
        request[key]
            .as_str()
            .filter(|digest| is_hex(digest, 64))
            .map(str::to_string)
            .ok_or(INVALID)
    };
    let persist = request["persist"].as_bool().ok_or(INVALID)?;
    let bound = match (persist, request.get("bound")) {
        (true, None) => None,
        (false, Some(bound)) => Some(
            bound
                .as_str()
                .filter(|bound| dialogs::is_bound(bound))
                .ok_or(INVALID)?
                .to_string(),
        ),
        _ => return Err(INVALID),
    };
    Ok(Confirm {
        worktree_root: path(&request["worktreeRoot"])?,
        git_directory: path(&request["gitDirectory"])?,
        common_directory: path(&request["commonDirectory"])?,
        git_installation_digest: digest("gitInstallationDigest")?,
        fingerprint: digest("fingerprint")?,
        persist,
        bound,
    })
}

/// The renderer form of a marker: exactly `markerId`, `kind`, `startedAt`, and `worktreeRoot` (contract §3 `getEnvironment`).
fn renderer_marker(marker: &Marker) -> Value {
    json!({
        "markerId": marker.marker_id,
        "kind": marker.kind,
        "startedAt": marker.started_at,
        "worktreeRoot": marker.worktree_root.to_string_lossy(),
    })
}
