// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::bootstrap::{Contexts, PhysicalIdentity};
use crate::close::{self, Decision, Owner, Running};
use crate::dialogs::{self, Chosen, Dialogs, Native, Proposal, Registered, WslProposal};
use crate::env_sanitize::sanitize;
use crate::framing::{FrameError, read_frame, write_frame};
use crate::ipc::{
    FrameSink, Ipc, MAIN_WINDOW, NativeFirst, Prepared, ToRenderer, renderer_message,
};
use crate::jobs::{Job, Supervisor};
use crate::lifecycle::{self, Action, Event, Host};
use crate::process_requests::{
    CHUNK_BYTES, Config, ConfirmedGit, Owned, ProcessRequests, ReplySink, WALK_DEADLINE_MS,
    decode_strict, is_identifier, wait,
};
use crate::schema::mutation_reply::RefusedCode as MutationCode;
use crate::schema::mutation_request::MutationRequest;
use crate::schema::trust_reply::ConfirmRunReplyResult;
use crate::schema::{self, reply, trust_request::TrustRequest};
use crate::settings::{
    self, Confirm, Damaged, Marker, Markers, SavedGit, Settings, Started, StartedReply, Trust,
};
use crate::spawn::{Input, SpawnRequest, spawn};

/// tauri-build copies `externalBin` next to the application executable without the target triple (tauri-build lib.rs:140-167).
/// The NSIS bundle installs it beside `arbareto.exe` too.
const SIDECAR: &str = "arbareto-git.exe";
/// The contract sets no bound for the handshake reply. A missing reply counts as a failed handshake (contract §2).
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// The progress event of the main window. Contract §2 names no channel for progress events.
const PROGRESS_EVENT: &str = "operation-progress";

const INVALID: &str = "INVALID_REQUEST";
const UNAVAILABLE: &str = "SERVICE_UNAVAILABLE";

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
    /// A frame walk holds a clone until its reply (contract §6 "Walks").
    pub markers: Arc<Markers>,
    pub trust: Arc<Trust>,
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
    facts: OnceLock<Facts>,
    launch_directory: PathBuf,
    environment: Vec<(OsString, OsString)>,
    /// The frame reader and the exit watch of the last launch. A new launch joins them first.
    threads: Mutex<Vec<JoinHandle<()>>>,
    /// True from a completed handshake to the next service exit. Guarded together with `exits`.
    connected: Mutex<bool>,
    /// The running mutations of `requestClose` (contract §6 "Recovery markers").
    running: Arc<Running>,
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
        let forward: FrameSink = {
            let stdin = Arc::clone(&stdin);
            Arc::new(move |body: String| write(&stdin, &body))
        };
        let replies: ReplySink = {
            let stdin = Arc::clone(&stdin);
            Arc::new(move |body: String| {
                write(&stdin, &body);
            })
        };
        let requests = ProcessRequests::new(
            Config {
                launch_directory: launch_directory.clone(),
                base_environment: environment.clone(),
                argument_prefix: Vec::new(),
                walk_deadline: Duration::from_millis(WALK_DEADLINE_MS),
            },
            Arc::clone(&contexts),
            Arc::clone(&jobs),
            replies,
        );
        let service = Arc::new(Service {
            app: app.clone(),
            ipc: Arc::new(Ipc::new(forward)),
            requests,
            jobs,
            contexts,
            dialogs: Arc::new(Dialogs::new(app.clone())),
            stores: OnceLock::new(),
            facts: OnceLock::new(),
            launch_directory,
            environment,
            threads: Mutex::default(),
            connected: Mutex::new(false),
            running: Arc::default(),
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
            .set_git_confirmation(Box::new(move |selected, path, version| {
                me.upgrade().map_or(Registered::Declined, |me| {
                    me.confirm_git(selected, path, version)
                })
            }));
        let me = Arc::downgrade(&service);
        service
            .requests
            .set_wsl_confirmation(Box::new(move |distro, git, version| {
                me.upgrade().is_some_and(|me| {
                    dialogs::confirm_wsl_git(
                        &*me.dialogs,
                        &WslProposal {
                            distro,
                            git,
                            version,
                        },
                    )
                })
            }));
        let me = Arc::downgrade(&service);
        service.requests.set_wsl_store(Box::new(move |git| {
            if let Some(stores) = me.upgrade().as_ref().and_then(|me| me.stores.get()) {
                let mut saved = lock(&stores.settings);
                settings::remember_wsl_git(&mut saved, git);
                let _ = settings::save(&stores.settings_path, &saved);
            }
        }));
        let me = Arc::downgrade(&service);
        service.requests.set_wsl_saved(Box::new(move || {
            me.upgrade()
                .as_ref()
                .and_then(|me| me.stores.get())
                .map(|stores| lock(&stores.settings).wsl_gits.clone())
                .unwrap_or_default()
        }));
        let me = Arc::downgrade(&service);
        service.requests.set_startup_git(Box::new(move |git| {
            if let Some(stores) = me.upgrade().as_ref().and_then(|me| me.stores.get()) {
                save_startup_git(stores, git);
            }
        }));
        service.launch();
        Ok(service)
    }

    /// Starts one service process. False is a failed start.
    /// It runs on no thread of the last launch, because it joins them.
    fn launch(self: &Arc<Self>) -> bool {
        // A late exit cleanup of the last process would clear the pipes and the Job of the new one.
        let threads = std::mem::take(&mut *lock(&self.threads));
        for thread in threads {
            let _ = thread.join();
        }
        let Ok(program) = std::env::current_exe().map(|exe| exe.with_file_name(SIDECAR)) else {
            return false;
        };
        let Ok(job) = Job::create() else {
            return false;
        };
        let Ok(spawned) = spawn(
            &SpawnRequest {
                program: &program,
                arguments: &[],
                environment: &self.environment,
                current_dir: &self.launch_directory,
                wsl: false,
                input: Input::Stream,
            },
            job.handle(),
        ) else {
            return false;
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
        let reader = std::thread::spawn(move || me.read(stdout, &handshake));
        let me = Arc::clone(self);
        let watch = std::thread::spawn(move || me.watch(process));
        lock(&self.threads).extend([reader, watch]);
        true
    }

    /// Sends the startup handshake and waits for its reply. An error means that no service session runs (contract §2).
    pub fn connect(&self, facts: Facts, stores: Stores) -> Result<(), Event> {
        self.facts.get_or_init(|| facts);
        self.stores.get_or_init(|| stores);
        self.open_session(false)
    }

    fn open_session(&self, restarted: bool) -> Result<(), Event> {
        let (Some(facts), Some(stores)) = (self.facts.get(), self.stores.get()) else {
            return Err(Event::StartFailed);
        };
        let Some(reply) = lock(&self.handshake).take() else {
            return Err(Event::StartFailed);
        };
        let exits = self.exits.load(Ordering::SeqCst);
        write(
            &self.stdin,
            &handshake_frame(facts, stores, &self.contexts, restarted),
        );
        if let Ok(Some(session_id)) = reply.recv_timeout(HANDSHAKE_WAIT) {
            let mut connected = lock(&self.connected);
            // An exit after the reply already ran its cleanup, so this session never runs.
            if self.exits.load(Ordering::SeqCst) == exits {
                *connected = true;
                self.ipc.set_session(Some(session_id));
                return Ok(());
            }
        }
        // A failed handshake ends the service. A missing reply ends it here.
        drop(lock(&self.job).take());
        Err(Event::HandshakeFailed)
    }

    /// Shows one lifecycle dialog and runs the action of its result.
    /// Lifecycle dialogs use their own `Dialogs`, so a service exit never cancels them.
    fn act(self: &Arc<Self>, dialog: lifecycle::Dialog) {
        let pressed = Dialogs::new(self.app.clone()).confirm(&lifecycle::confirmation(dialog));
        match lifecycle::action(dialog, pressed) {
            Action::RestartService => {
                lifecycle::restart_service(self);
            }
            Action::ReloadWindow => {
                if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.reload();
                }
            }
            Action::RestartArbareto => {
                self.end(close::Request::Window, true);
            }
            Action::CloseArbareto => {
                self.end(close::Request::Window, false);
            }
        }
    }

    /// Application close under the close rules (plan.md "Close during mutation").
    /// `relaunch` starts the application again after the close.
    fn end(&self, request: close::Request, relaunch: bool) -> Decision {
        let decision = close::decide(request, &self.running, &*self.dialogs);
        match decision {
            Decision::Close => {
                self.close();
                if relaunch {
                    self.app.request_restart();
                } else {
                    self.app.exit(0);
                }
            }
            Decision::StayOpen => {
                if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.set_focus();
                }
            }
            Decision::Stay => {}
        }
        decision
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
        if let (Some(stores), Some(request)) = (self.stores.get(), body(frame, "mutation"))
            && let Some(reply) = mutation(&stores.markers, &self.running, &self.requests, request)
        {
            self.send("mutation", reply);
        }
    }

    /// The `trust` frames of contract §6 "Channel frames".
    fn trust(self: &Arc<Self>, frame: &Value) {
        let (Some(stores), Some(request)) = (self.stores.get(), body(frame, "trust")) else {
            return;
        };
        let Some(call_id) = call_id(request) else {
            return;
        };
        let handled = schema::trust_request(request).map(|request| match request {
            TrustRequest::Confirm {
                worktree_root,
                git_directory,
                common_directory,
                git_selected_path,
                fingerprint,
                persist,
                bound,
                ..
            } => self.confirm_trust(
                Confirm {
                    worktree_root: PathBuf::from(worktree_root.as_str()),
                    git_directory: PathBuf::from(git_directory.as_str()),
                    common_directory: PathBuf::from(common_directory.as_str()),
                    git_selected_path: PathBuf::from(git_selected_path.as_str()),
                    fingerprint: fingerprint.to_string(),
                    persist,
                    bound: bound.map(|bound| bound.to_string()),
                },
                call_id,
            ),
            TrustRequest::Revoke {
                common_directory, ..
            } => {
                let reply = revoke(
                    &stores.trust,
                    &self.requests,
                    &self.jobs,
                    call_id,
                    Path::new(common_directory.as_str()),
                );
                if let Some(reply) = reply {
                    self.send("trust", reply);
                }
            }
            TrustRequest::ConfirmRun {
                submodule_paths,
                program_count,
                unchecked_count,
                ..
            } => {
                let paths = submodule_paths.into_iter().map(String::from).collect();
                // `trust_request` refused a negative count.
                let unchecked = u64::try_from(unchecked_count).unwrap_or(0);
                self.confirm_run(paths, program_count.get(), unchecked, call_id);
            }
        });
        if let Err(code) = handled {
            self.send("trust", reply::trust_refused(call_id, code));
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
            let confirmed = stores.trust.confirm_with(
                &request,
                &|path| me.requests.read_physical_identity(path),
                |request| dialogs::confirm_trust(&*me.dialogs, request) && current(),
            );
            if current() {
                me.send("trust", confirmed.reply(&call_id));
            }
        });
    }

    /// Shows the `confirmRun` confirmation on its own thread (contract §12 "Trust"). It writes no trust record.
    /// A service exit closes the dialog as Cancel, and its result goes nowhere.
    fn confirm_run(
        self: &Arc<Self>,
        paths: Vec<String>,
        program_count: u64,
        unchecked_count: u64,
        call_id: &str,
    ) {
        let me = Arc::clone(self);
        let call_id = call_id.to_string();
        let exits = self.exits.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            let current = || me.exits.load(Ordering::SeqCst) == exits;
            let approved =
                dialogs::confirm_run(&*me.dialogs, &paths, program_count, unchecked_count);
            let result = if approved && current() {
                ConfirmRunReplyResult::Approved
            } else {
                ConfirmRunReplyResult::Declined
            };
            if current() {
                me.send("trust", reply::confirm_run(&call_id, result));
            }
        });
    }

    /// The Git selection confirmation of a `register` request with `confirm: true`.
    /// It names the stored version when the probed file is the saved resolved path (contract §3 "Git proposal").
    fn confirm_git(
        &self,
        selected_path: &Path,
        executable_path: &Path,
        version: &str,
    ) -> Registered {
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
                selected_path,
                executable_path,
                version,
                stored_version,
            },
            &self.contexts,
            Instant::now(),
        )
    }

    /// Waits for the service exit. The shell never restarts the service by itself.
    fn watch(self: &Arc<Self>, process: Owned) {
        while !wait(process.0, Duration::from_secs(3600)) {}
        drop(process);
        lock(&self.stdin).take();
        drop(lock(&self.job).take());
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        // Without a completed handshake, the `connect` caller shows the dialog.
        let connected = {
            let mut connected = lock(&self.connected);
            self.exits.fetch_add(1, Ordering::SeqCst);
            std::mem::take(&mut *connected)
        };
        self.requests.service_exited();
        // The operation Jobs closed, so no mutation counts as running (contract §6 "Recovery markers").
        self.running.service_exited();
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
        if connected {
            lifecycle::handle(self, Event::ServiceExited);
        }
    }

    /// Application close: the operation Jobs, then the lingering Jobs, then the service Job (contract §6 "Lingering Jobs").
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        close::shut_down(self);
        self.jobs.shutdown();
    }
}

impl Owner for Service {
    fn close_operation_jobs(&self) {
        self.jobs.service_exited();
    }

    fn close_lingering_jobs(&self) {
        self.jobs.close_all();
    }

    fn close_service_job(&self) {
        drop(lock(&self.job).take());
    }
}

impl Host for Arc<Service> {
    /// The dialog blocks, so it runs on its own thread.
    fn show(&self, dialog: lifecycle::Dialog) {
        let me = Arc::clone(self);
        std::thread::spawn(move || me.act(dialog));
    }

    fn log(&self, entry: &str) {
        eprintln!("{entry}");
    }

    fn start_service(&self) -> bool {
        self.launch()
    }

    fn handshake(&self, restarted: bool) -> bool {
        self.open_session(restarted).is_ok()
    }

    fn send_service_session(&self) {
        let _ = self.app.emit_to(MAIN_WINDOW, "service-session", ());
    }
}

impl NativeFirst for Service {
    fn prepare(&self, operation: &str, payload: &Value) -> Result<Option<Prepared>, &'static str> {
        let stores = self.stores.get().ok_or(UNAVAILABLE)?;
        prepare(stores, &*self.dialogs, &self.contexts, operation, payload)
    }

    fn finish(&self, operation: &str, prepared: &Prepared, response: Value) -> Value {
        match self.stores.get() {
            Some(stores) => finish(
                stores,
                &*self.dialogs,
                &self.requests,
                operation,
                prepared,
                response,
            ),
            None => response,
        }
    }

    fn request_close(&self, request: close::Request) -> Decision {
        self.end(request, false)
    }
}

/// The startup handshake (contract §6 "Startup handshake"). Each handshake rescans the markers and the records.
fn handshake_frame(facts: &Facts, stores: &Stores, contexts: &Contexts, restarted: bool) -> String {
    let scan = stores.markers.scan();
    let mut handshake = json!({
        "version": 1,
        "restarted": restarted,
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
        "damagedMarkers": scan.damaged.iter().map(Damaged::handshake).collect::<Vec<_>>(),
        "trustRecords": stores.trust.records(),
    });
    let settings = lock(&stores.settings).clone();
    if let Some(saved_git) = dialogs::startup_context(&settings, contexts, Instant::now()) {
        handshake["savedGit"] = saved_git;
    }
    json!({ "kind": "handshake", "handshake": handshake }).to_string()
}

/// The native step before the forward (contract §3). `Ok(None)` is a canceled dialog.
fn prepare(
    stores: &Stores,
    native: &dyn Native,
    contexts: &Contexts,
    operation: &str,
    payload: &Value,
) -> Result<Option<Prepared>, &'static str> {
    let now = Instant::now();
    let chosen = match operation {
        "chooseGit" => {
            let saved = lock(&stores.settings).git.clone();
            dialogs::choose_git(native, saved.as_ref(), contexts, now)
        }
        "chooseRepository" => dialogs::choose_repository(native, contexts, now),
        "restoreWorkspace" => {
            let settings = lock(&stores.settings).clone();
            dialogs::restore_workspace(&settings, contexts, now)
        }
        "dismissRecoveryMarker" => {
            let marker_id = payload["markerId"].as_str().ok_or(INVALID)?;
            // Without a context, the service allows the dismissal without discovery (contract §6 "Dismissal").
            let bootstrap_id = match stores.markers.get(marker_id) {
                Some(marker) => dialogs::dismissal_context(&marker, contexts, now)?,
                None if stores.markers.damaged(marker_id).is_some() => None,
                None => return Err("UNKNOWN_TARGET"),
            };
            let payload = match bootstrap_id {
                Some(bootstrap_id) => json!({ "markerId": marker_id, "bootstrapId": bootstrap_id }),
                None => json!({ "markerId": marker_id }),
            };
            return Ok(Some(Prepared {
                payload,
                path: None,
            }));
        }
        _ => return Err(UNAVAILABLE),
    };
    let (bootstrap_id, path) = match chosen {
        Chosen::Canceled => return Ok(None),
        Chosen::Refused(code) => return Err(code),
        Chosen::Context { bootstrap_id, path } => (bootstrap_id, path),
    };
    let payload = if operation == "chooseGit" {
        json!({ "bootstrapId": bootstrap_id, "executablePath": path.to_string_lossy() })
    } else {
        json!({ "bootstrapId": bootstrap_id })
    };
    Ok(Some(Prepared {
        payload,
        path: Some(path),
    }))
}

/// The native step after the service response. It returns the response for the renderer.
fn finish(
    stores: &Stores,
    native: &dyn Native,
    requests: &ProcessRequests,
    operation: &str,
    prepared: &Prepared,
    response: Value,
) -> Value {
    if response["state"] != "succeeded" {
        return response;
    }
    match operation {
        "chooseGit" => {
            save_git(stores, requests, &response["result"]);
            response
        }
        // Data-model §1: the settings keep the last explicitly opened repository, from the native context.
        "chooseRepository" => {
            if let Some(path) = &prepared.path {
                let mut settings = lock(&stores.settings);
                settings.last_repository = Some(path.clone());
                let _ = settings::save(&stores.settings_path, &settings);
            }
            response
        }
        // Contract §6 "Dismissal": the confirmation follows an allowed service result.
        "dismissRecoveryMarker" => {
            let marker_id = prepared.payload["markerId"].as_str().unwrap_or_default();
            let mut accepted = false;
            let dismissed = if stores.markers.damaged(marker_id).is_some() {
                stores.markers.dismiss_damaged(marker_id, |damaged| {
                    accepted = dialogs::confirm_damaged_dismissal(native, damaged);
                    accepted
                })
            } else {
                stores.markers.dismiss(marker_id, |marker| {
                    accepted = dialogs::confirm_dismissal(native, marker);
                    accepted
                })
            };
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

/// Persists the Git selection after the service success and Use this Git (data-model §1).
fn save_git(stores: &Stores, requests: &ProcessRequests, result: &Value) {
    let Some(git_id) = result["gitInstallationId"].as_str() else {
        return;
    };
    if let Some(confirmed) = requests.take_confirmed_git(git_id) {
        store_git(stores, confirmed);
    }
}

/// Persists the Git that a startup context registered (contract §6 "Startup contexts").
/// It keeps the saved selected path. An unchanged Git writes nothing.
fn save_startup_git(stores: &Stores, git: ConfirmedGit) {
    let saved = lock(&stores.settings).git.clone();
    let unchanged = saved.is_some_and(|saved| {
        (saved.executable_path, saved.version, saved.digest)
            == (
                git.executable_path.clone(),
                git.version.clone(),
                git.digest.clone(),
            )
    });
    if !unchanged {
        store_git(stores, git);
    }
}

fn store_git(stores: &Stores, git: ConfirmedGit) {
    let mut settings = lock(&stores.settings);
    settings.git = Some(SavedGit {
        selected_path: git.selected_path,
        executable_path: git.executable_path,
        version: git.version,
        digest: git.digest,
    });
    let _ = settings::save(&stores.settings_path, &settings);
}

/// The `mutation` frames of contract §6 "Channel frames". Returns the reply. `ended` and `resolved` get none.
/// The walk of `started` sends its reply later (contract §6 "Walks").
fn mutation(
    markers: &Arc<Markers>,
    running: &Arc<Running>,
    requests: &ProcessRequests,
    request: &Value,
) -> Option<Value> {
    let call_id = call_id(request);
    let handled = schema::mutation_request(request).and_then(|request| match request {
        MutationRequest::Started {
            operation_id,
            kind,
            worktree_root,
            common_directory,
            ..
        } => {
            let call_id = call_id.ok_or(MutationCode::InvalidRequest)?;
            let common = PathBuf::from(common_directory.as_str());
            // A service exit after the frame read changes the epoch, and the late finish then takes no mutex.
            let epoch = markers.epoch();
            let (markers, running, call) = (
                Arc::clone(markers),
                Arc::clone(running),
                call_id.to_string(),
            );
            let started_kind = kind;
            let (operation, kind) = (operation_id.to_string(), kind.to_string());
            let worktree = PathBuf::from(worktree_root.as_str());
            requests.frame_walk(
                "mutation",
                reply::started_deadline,
                call_id,
                &operation_id,
                common.clone(),
                move |requests, identity| {
                    let started = Started {
                        operation_id: &operation,
                        kind: &kind,
                        worktree_root: &worktree,
                        common_directory: &common,
                    };
                    let (reply, marked) =
                        self::started(&markers, requests, &started, &call, epoch, identity);
                    if marked {
                        running.started(&operation, started_kind);
                    }
                    reply
                },
            )?;
            Ok(None)
        }
        MutationRequest::Ended {
            operation_id,
            end_processes,
        } => {
            requests.ended(&operation_id, end_processes)?;
            markers.ended(&operation_id);
            running.ended(&operation_id);
            Ok(None)
        }
        MutationRequest::Resolved { marker_id } => {
            markers.resolved(&marker_id);
            Ok(None)
        }
    });
    match (handled, call_id) {
        (Ok(reply), _) => reply,
        (Err(code), Some(call_id)) => Some(reply::mutation_refused(call_id, code)),
        (Err(_), None) => None,
    }
}

/// The `trust` frame `revoke` (contract §7 "Trust approval store"). Returns the reply, or `None` when its walk sends it later.
fn revoke(
    trust: &Arc<Trust>,
    requests: &ProcessRequests,
    jobs: &Arc<Supervisor>,
    call_id: &str,
    common_directory: &Path,
) -> Option<Value> {
    // The path match needs no identity, so it comes before the walk (contract §6 "Walks").
    trust.revoke_path(common_directory);
    if !requests.identity_read_needed(common_directory, |guid| trust.holds_guid(guid)) {
        return Some(reply::revoke(call_id, 0));
    }
    let (trust, jobs, call) = (Arc::clone(trust), Arc::clone(jobs), call_id.to_string());
    let walked = requests.frame_walk(
        "trust",
        reply::revoke_deadline,
        call_id,
        "",
        common_directory.to_path_buf(),
        move |_, identity| {
            let ended = trust.revoke_identity(identity.as_ref(), |tag| jobs.revoke(tag));
            reply::revoke(&call, ended)
        },
    );
    walked
        .err()
        .map(|code| reply::trust_refused(call_id, code.into()))
}

/// Replies only after the marker file is flushed, or with the failure class (contract §6 "Recovery markers").
/// True when the reply carries a marker ID.
fn started(
    markers: &Markers,
    requests: &ProcessRequests,
    started: &Started,
    call_id: &str,
    epoch: u64,
    identity: Option<PhysicalIdentity>,
) -> (Value, bool) {
    let reply = markers.started_with(started, epoch, &|_| identity.clone());
    // The tag is the identity that named the mutex (contract §6 "Lingering Jobs").
    let marked = if let StartedReply::Marker { identity, .. } = &reply {
        requests.tag(started.operation_id, identity.clone());
        true
    } else {
        false
    };
    (reply.reply(call_id), marked)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Writes one frame. A failed write closes the service stdin. False means that the service did not get the whole frame.
fn write(stdin: &Mutex<Option<File>>, body: &str) -> bool {
    let mut stdin = lock(stdin);
    let Some(pipe) = stdin.as_mut() else {
        return false;
    };
    let written = write_frame(pipe, body).is_ok();
    if !written {
        *stdin = None;
    }
    written
}

/// The reply `{"kind":"handshake","handshake":{"sessionId":"<ID>"}}`. A failure reply gives `None`.
fn session_id(frame: &Value) -> Option<String> {
    let reply = frame.get("handshake")?.as_object()?;
    let session_id = reply.get("sessionId")?.as_str()?;
    (frame.as_object()?.len() == 2 && reply.len() == 1 && is_identifier(session_id))
        .then(|| session_id.to_string())
}

/// The inner object of a `{"kind":"<kind>","<kind>":{…}}` frame.
fn body<'a>(frame: &'a Value, kind: &str) -> Option<&'a Value> {
    if frame.as_object()?.len() != 2 {
        return None;
    }
    frame.get(kind).filter(|body| body.is_object())
}

fn call_id(request: &Value) -> Option<&str> {
    request
        .get("callId")
        .and_then(Value::as_str)
        .filter(|id| is_identifier(id))
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

#[cfg(test)]
mod tests {
    use super::*;

    use crate::schema::mutation_request::StartedKind;

    use crate::bootstrap::tests::Hold;
    use crate::dialogs::tests::{Fake, Press};
    use crate::jobs::tests::{Fixture, eventually};
    use crate::process_requests::tests::uuid;

    const CALL: &str = "0f0f0f0f-0000-4000-8000-0000000000cc";
    const REPOSITORY: &str = "0f0f0f0f-0000-4000-8000-0000000000dd";
    const FIRST: &str = "0f0f0f0f-0000-4000-8000-0000000000e1";
    const SECOND: &str = "0f0f0f0f-0000-4000-8000-0000000000e2";
    const THIRD: &str = "0f0f0f0f-0000-4000-8000-0000000000e3";

    /// The frames that the process requests of a test shell send.
    type Sent = Arc<(Mutex<Vec<Value>>, std::sync::Condvar)>;

    /// The native stores, contexts, and process requests of one test shell. The fixture folder drops last.
    struct Shell {
        stores: Stores,
        contexts: Arc<Contexts>,
        requests: Arc<ProcessRequests>,
        jobs: Arc<Supervisor>,
        running: Arc<Running>,
        sent: Sent,
        fixture: Fixture,
    }

    impl Shell {
        fn new() -> Shell {
            Shell::with_deadline(Duration::from_millis(WALK_DEADLINE_MS))
        }

        fn with_deadline(walk_deadline: Duration) -> Shell {
            let fixture = Fixture::new();
            let launch_directory = fixture.path("launch");
            std::fs::create_dir_all(&launch_directory).expect("launch directory");
            let contexts = Arc::new(Contexts::new(""));
            let jobs = Supervisor::start().expect("start the supervisor");
            let sent: Sent = Arc::default();
            let sink: ReplySink = {
                let sent = Arc::clone(&sent);
                Arc::new(move |body: String| {
                    let (list, changed) = &*sent;
                    list.lock()
                        .expect("sent")
                        .push(serde_json::from_str(&body).expect("frame"));
                    changed.notify_all();
                })
            };
            let requests = ProcessRequests::new(
                Config {
                    launch_directory,
                    base_environment: Vec::new(),
                    argument_prefix: Vec::new(),
                    walk_deadline,
                },
                Arc::clone(&contexts),
                Arc::clone(&jobs),
                sink,
            );
            Shell {
                stores: Stores {
                    settings_path: fixture.path("settings.json"),
                    settings: Mutex::new(Settings::default()),
                    markers: Arc::new(Markers::open(&fixture.path("recovery"))),
                    trust: Arc::new(Trust::open(&fixture.path("trust"))),
                },
                contexts,
                requests,
                jobs,
                running: Arc::default(),
                sent,
                fixture,
            }
        }

        /// Takes the first sent frame for `call`. `None` after 10 s.
        fn take_sent(&self, call: &str) -> Option<Value> {
            let (list, changed) = &*self.sent;
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut list = list.lock().expect("sent");
            loop {
                let found = list.iter().position(|frame| {
                    frame
                        .as_object()
                        .and_then(|frame| frame.values().find_map(|v| v.get("callId")))
                        == Some(&json!(call))
                });
                if let Some(at) = found {
                    return Some(list.remove(at));
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return None;
                }
                list = changed.wait_timeout(list, left).expect("sent").0;
            }
        }

        /// The reply body of a frame handler: its return value, or the frame that a walk sends later.
        fn answer(&self, kind: &str, call: &str, returned: Option<Value>) -> Option<Value> {
            returned.or_else(|| self.take_sent(call).map(|frame| frame[kind].clone()))
        }

        fn folder(&self, name: &str) -> PathBuf {
            let path = self.fixture.path(name);
            std::fs::create_dir_all(&path).expect("folder");
            path
        }

        fn prepare(
            &self,
            native: &Fake,
            operation: &str,
            payload: Value,
        ) -> Result<Option<Prepared>, &'static str> {
            prepare(&self.stores, native, &self.contexts, operation, &payload)
        }

        fn finish(
            &self,
            native: &Fake,
            operation: &str,
            prepared: &Prepared,
            response: Value,
        ) -> Value {
            finish(
                &self.stores,
                native,
                &self.requests,
                operation,
                prepared,
                response,
            )
        }

        fn mutation(&self, request: Value) -> Option<Value> {
            mutation(
                &self.stores.markers,
                &self.running,
                &self.requests,
                &request,
            )
        }

        fn started(&self, operation: &str, worktree: &Path) -> Option<Value> {
            let returned = self.mutation(started_frame(CALL, operation, worktree));
            self.answer("mutation", CALL, returned)
        }

        fn ended(&self, operation: &str) -> Option<Value> {
            self.mutation(
                json!({ "type": "ended", "operationId": operation, "endProcesses": false }),
            )
        }

        fn marker_files(&self) -> usize {
            std::fs::read_dir(self.fixture.path("recovery"))
                .expect("recovery folder")
                .count()
        }
    }

    impl Drop for Shell {
        fn drop(&mut self) {
            self.jobs.close_all();
            self.jobs.shutdown();
        }
    }

    #[test]
    fn a_refused_identity_read_rejects_with_its_code_and_a_canceled_picker_cancels() {
        let shell = Shell::new();
        let deleted = shell.fixture.path("deleted-after-pick");
        let picked = Fake {
            folder: Some(deleted.clone()),
            ..Fake::default()
        };
        assert_eq!(
            shell.prepare(&picked, "chooseRepository", json!({})),
            Err("UNSUPPORTED_REPOSITORY")
        );
        lock(&shell.stores.settings).last_repository = Some(deleted);
        assert_eq!(
            shell.prepare(&Fake::default(), "restoreWorkspace", json!({})),
            Err("UNSUPPORTED_REPOSITORY"),
            "a deleted last repository"
        );
        assert_eq!(
            shell.prepare(&Fake::default(), "chooseRepository", json!({})),
            Ok(None),
            "a canceled picker"
        );
        let repository = shell.folder("repo");
        let picked = Fake {
            folder: Some(repository.clone()),
            ..Fake::default()
        };
        let prepared = shell
            .prepare(&picked, "chooseRepository", json!({}))
            .expect("prepare")
            .expect("a context");
        let bootstrap_id = prepared.payload["bootstrapId"]
            .as_str()
            .expect("bootstrapId");
        assert_eq!(prepared.payload, json!({ "bootstrapId": bootstrap_id }));
        assert_eq!(prepared.path, Some(repository));
    }

    #[test]
    fn a_startup_registration_saves_the_new_resolved_file_version_and_digest_and_keeps_the_selected_path()
     {
        let shell = Shell::new();
        let wrapper = shell.folder("Git\\cmd").join("git.exe");
        std::fs::write(&wrapper, "wrapper").expect("wrapper");
        let old = shell
            .fixture
            .path("Git\\mingw64\\libexec\\git-core\\git.exe");
        let new = shell
            .fixture
            .path("Git\\ucrt64\\libexec\\git-core\\git.exe");
        let (old_digest, new_digest) = ("a".repeat(64), "b".repeat(64));
        lock(&shell.stores.settings).git = Some(SavedGit {
            selected_path: wrapper.clone(),
            executable_path: old,
            version: "2.55.0.windows.3".to_string(),
            digest: old_digest,
        });
        let upgraded = ConfirmedGit {
            selected_path: wrapper.clone(),
            executable_path: new.clone(),
            version: "2.56.0.windows.1".to_string(),
            digest: new_digest.clone(),
        };
        save_startup_git(&shell.stores, upgraded.clone());
        let expected = SavedGit {
            selected_path: wrapper.clone(),
            executable_path: new.clone(),
            version: "2.56.0.windows.1".to_string(),
            digest: new_digest.clone(),
        };
        assert_eq!(
            settings::load(&shell.stores.settings_path).git,
            Some(expected.clone())
        );
        assert_eq!(lock(&shell.stores.settings).git, Some(expected));
        // The next handshake carries the saved fields, so the next start reports no update.
        let saved = dialogs::startup_context(
            &lock(&shell.stores.settings).clone(),
            &shell.contexts,
            Instant::now(),
        )
        .expect("savedGit");
        assert_eq!(
            (
                &saved["selectedPath"],
                &saved["executablePath"],
                &saved["version"],
                &saved["digest"]
            ),
            (
                &json!(wrapper),
                &json!(new),
                &json!("2.56.0.windows.1"),
                &json!(new_digest)
            )
        );
        // An unchanged Git writes nothing.
        std::fs::remove_file(&shell.stores.settings_path).expect("remove settings");
        save_startup_git(&shell.stores, upgraded);
        assert!(
            !shell.stores.settings_path.exists(),
            "an unchanged Git writes no file"
        );
    }

    #[test]
    fn a_successful_choose_repository_saves_the_native_context_path() {
        let shell = Shell::new();
        let repository = shell.folder("repo");
        let picked = Fake {
            folder: Some(repository.clone()),
            ..Fake::default()
        };
        let prepared = shell
            .prepare(&picked, "chooseRepository", json!({}))
            .expect("prepare")
            .expect("a context");
        let failed =
            json!({ "requestId": CALL, "state": "failed", "code": "REPOSITORY_UNAVAILABLE" });
        assert_eq!(
            shell.finish(&picked, "chooseRepository", &prepared, failed.clone()),
            failed
        );
        assert_eq!(
            settings::load(&shell.stores.settings_path).last_repository,
            None,
            "a failed result saves nothing"
        );
        // The service result never names the path that the shell saves.
        let succeeded = json!({ "requestId": CALL, "state": "succeeded", "result": { "repositoryId": REPOSITORY, "worktreeRoot": "C:\\elsewhere" } });
        assert_eq!(
            shell.finish(&picked, "chooseRepository", &prepared, succeeded.clone()),
            succeeded
        );
        assert_eq!(
            lock(&shell.stores.settings).last_repository,
            Some(repository.clone())
        );
        assert_eq!(
            settings::load(&shell.stores.settings_path).last_repository,
            Some(repository),
            "the settings file holds the path"
        );
    }

    #[test]
    fn a_dismissal_of_a_deleted_repository_forwards_only_the_marker_id() {
        let shell = Shell::new();
        let worktree = shell.folder("repo");
        shell.folder("repo\\.git");
        let reply = shell.started(FIRST, &worktree).expect("started reply");
        let marker_id = reply["markerId"].as_str().expect("markerId").to_string();
        assert_eq!(shell.ended(FIRST), None);
        let dismiss = json!({ "markerId": marker_id });
        let prepared = shell
            .prepare(&Fake::default(), "dismissRecoveryMarker", dismiss.clone())
            .expect("prepare")
            .expect("payload");
        assert!(
            prepared.payload["bootstrapId"].is_string(),
            "an existing repository gets a discovery context"
        );
        std::fs::remove_dir_all(&worktree).expect("delete the repository");
        let prepared = shell
            .prepare(&Fake::default(), "dismissRecoveryMarker", dismiss.clone())
            .expect("prepare")
            .expect("payload");
        assert_eq!(
            prepared,
            Prepared {
                payload: dismiss,
                path: None
            }
        );
        let allowed = json!({ "requestId": CALL, "state": "succeeded", "result": {} });
        let native = Fake::pressing(&[Press::Label("Dismiss")]);
        assert_eq!(
            shell.finish(&native, "dismissRecoveryMarker", &prepared, allowed.clone()),
            allowed
        );
        assert_eq!(shell.marker_files(), 0, "Dismiss deletes the marker file");
    }

    #[test]
    fn the_handshake_lists_damaged_markers_apart_from_the_unloaded_count() {
        let shell = Shell::new();
        std::fs::write(shell.folder("recovery").join("broken.json"), "{").expect("write");
        let facts = Facts {
            platform_scope: "other",
            os_build: 26200,
            webview2_version: "154.0.4258.53".to_string(),
        };
        let frame: Value = serde_json::from_str(&handshake_frame(
            &facts,
            &shell.stores,
            &shell.contexts,
            false,
        ))
        .expect("JSON");
        let handshake = &frame["handshake"];
        let mut keys: Vec<&str> = handshake
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "buildIdentity",
                "damagedMarkers",
                "markers",
                "osBuild",
                "platformScope",
                "restarted",
                "trustRecords",
                "unloadedMarkers",
                "version",
                "webView2Version"
            ]
        );
        assert_eq!(handshake["markers"], json!([]));
        assert_eq!(handshake["unloadedMarkers"], json!(0));
        let damaged = handshake["damagedMarkers"].as_array().expect("array");
        assert_eq!(damaged.len(), 1);
        assert_eq!(damaged[0]["fileName"], json!("broken.json"));
        assert!(damaged[0]["markerId"].as_str().is_some_and(is_identifier));
        assert_eq!(damaged[0].as_object().map(|fields| fields.len()), Some(2));
    }

    #[test]
    fn the_handshake_frame_fits_the_generated_handshake_type() {
        let shell = Shell::new();
        std::fs::write(shell.folder("recovery").join("broken.json"), "{").expect("write");
        let facts = Facts {
            platform_scope: "qualification-target",
            os_build: 26200,
            webview2_version: "154.0.4258.53".to_string(),
        };
        for restarted in [false, true] {
            let frame: Value = serde_json::from_str(&handshake_frame(
                &facts,
                &shell.stores,
                &shell.contexts,
                restarted,
            ))
            .expect("JSON");
            assert_eq!(
                crate::schema::handshake(&frame["handshake"]).map(drop),
                Ok(())
            );
            assert_eq!(frame["handshake"]["restarted"], json!(restarted));
        }
    }

    #[test]
    fn the_restarted_handshake_carries_the_markers_and_a_new_saved_git_context() {
        let shell = Shell::new();
        std::fs::write(shell.folder("recovery").join("broken.json"), "{").expect("write");
        let git = shell.fixture.path("git.exe");
        std::fs::write(&git, "").expect("git file");
        lock(&shell.stores.settings).git = Some(SavedGit {
            selected_path: git.clone(),
            executable_path: git,
            version: "2.55.0.windows.1".to_string(),
            digest: "0".repeat(64),
        });
        let facts = Facts {
            platform_scope: "qualification-target",
            os_build: 26200,
            webview2_version: "154.0.4258.53".to_string(),
        };
        let frame = |restarted| -> Value {
            serde_json::from_str(&handshake_frame(
                &facts,
                &shell.stores,
                &shell.contexts,
                restarted,
            ))
            .expect("JSON")
        };
        let first = frame(false);
        let restarted = frame(true)["handshake"].clone();
        assert_eq!(restarted["restarted"], json!(true));
        assert_eq!(
            restarted["damagedMarkers"].as_array().map(Vec::len),
            Some(1)
        );
        let first_id = first["handshake"]["savedGit"]["bootstrapId"].as_str();
        let restarted_id = restarted["savedGit"]["bootstrapId"].as_str();
        assert!(restarted_id.is_some_and(is_identifier), "{restarted}");
        assert_ne!(first_id, restarted_id, "a new startup context");
    }

    #[test]
    fn a_damaged_marker_dismissal_forwards_only_the_marker_id_and_deletes_after_dismiss() {
        let shell = Shell::new();
        std::fs::write(shell.folder("recovery").join("broken.json"), "{").expect("write");
        let marker_id = shell.stores.markers.scan().damaged[0].marker_id.clone();
        let dismiss = json!({ "markerId": marker_id });
        let prepared = shell
            .prepare(&Fake::default(), "dismissRecoveryMarker", dismiss.clone())
            .expect("prepare")
            .expect("payload");
        assert_eq!(
            prepared,
            Prepared {
                payload: dismiss,
                path: None
            }
        );
        let allowed = json!({ "requestId": CALL, "state": "succeeded", "result": {} });
        assert_eq!(
            shell.finish(
                &Fake::pressing(&[Press::Label("Cancel")]),
                "dismissRecoveryMarker",
                &prepared,
                allowed.clone()
            ),
            json!({ "requestId": CALL, "state": "canceled", "code": "CANCELED" })
        );
        assert_eq!(shell.marker_files(), 1, "Cancel keeps the file");
        let native = Fake::pressing(&[Press::Label("Dismiss")]);
        assert_eq!(
            shell.finish(&native, "dismissRecoveryMarker", &prepared, allowed.clone()),
            allowed
        );
        assert_eq!(shell.marker_files(), 0, "Dismiss deletes the file");
    }

    #[test]
    fn a_started_frame_without_a_readable_identity_gets_failure_other_and_starts_nothing() {
        let shell = Shell::new();
        assert_eq!(
            shell.started(FIRST, &shell.fixture.path("gone")),
            Some(
                json!({ "type": "started", "callId": CALL, "failure": "other", "folder": shell.fixture.path("recovery") })
            )
        );
        assert_eq!(shell.marker_files(), 0, "no marker");
        assert_eq!(
            shell.requests.ended(FIRST, false),
            Err(crate::process_requests::Code::InvalidRequest),
            "no started mutation"
        );
    }

    #[test]
    fn a_mutation_counts_as_running_from_its_marker_reply_to_ended() {
        let shell = Shell::new();
        assert!(shell.started(FIRST, &shell.fixture.path("gone")).is_some());
        assert!(shell.running.kinds().is_empty(), "a failure reply");
        let worktree = shell.folder("repo");
        shell.folder("repo\\.git");
        assert!(shell.started(SECOND, &worktree).expect("reply")["markerId"].is_string());
        assert_eq!(shell.running.kinds(), [StartedKind::Commit]);
        assert_eq!(
            shell.started(THIRD, &worktree),
            Some(json!({ "type": "started", "callId": CALL, "busy": true }))
        );
        assert_eq!(shell.ended(THIRD), None);
        assert_eq!(shell.running.kinds(), [StartedKind::Commit], "a busy reply");
        assert_eq!(shell.ended(SECOND), None);
        assert!(shell.running.kinds().is_empty(), "ended");
    }

    #[test]
    fn only_an_ended_frame_after_a_marker_reply_releases_the_mutex() {
        let shell = Shell::new();
        let worktree = shell.folder("repo");
        shell.folder("repo\\.git");
        let busy = Some(json!({ "type": "started", "callId": CALL, "busy": true }));
        assert!(shell.started(FIRST, &worktree).expect("reply")["markerId"].is_string());
        assert_eq!(shell.started(SECOND, &worktree), busy, "the mutex is held");
        assert_eq!(shell.ended(SECOND), None);
        assert_eq!(
            shell.started(THIRD, &worktree),
            busy,
            "a busy mutation ends nothing"
        );
        assert_eq!(shell.ended(FIRST), None);
        assert!(
            shell.started(THIRD, &worktree).expect("reply")["markerId"].is_string(),
            "ended released the mutex"
        );
    }

    fn started_frame(call: &str, operation: &str, worktree: &Path) -> Value {
        json!({
            "type": "started", "callId": call, "operationId": operation, "repositoryId": REPOSITORY,
            "kind": "commit", "worktreeRoot": worktree, "commonDirectory": worktree.join(".git"),
        })
    }

    /// Runs `handler` on another thread. False when it still runs after 5 s. The hold then goes, so the thread ends.
    fn returns_at_once<T: Send>(
        hold: &mut Option<Hold>,
        handler: impl FnOnce() -> T + Send,
    ) -> (bool, T) {
        std::thread::scope(|scope| {
            let handle = scope.spawn(handler);
            let returned = eventually(Duration::from_secs(5), || handle.is_finished());
            if !returned {
                hold.take();
            }
            (returned, handle.join().expect("handler"))
        })
    }

    #[test]
    fn a_started_frame_whose_open_waits_never_blocks_the_reader_and_replies_deadline() {
        let shell = Shell::with_deadline(Duration::from_secs(2));
        let worktree = shell.folder("repo");
        let common = shell.folder("repo\\.git");
        let mut hold = Some(Hold::new(&common));
        let call = uuid();
        let (returned, reply) = returns_at_once(&mut hold, || {
            shell.mutation(started_frame(&call, FIRST, &worktree))
        });
        assert!(returned, "the frame reader never waits on the open");
        assert_eq!(reply, None, "the walk sends the reply");
        assert_eq!(
            shell.take_sent(&call),
            Some(
                json!({ "kind": "mutation", "mutation": { "type": "started", "callId": call, "deadline": "deadline" } })
            )
        );
        assert_eq!(shell.marker_files(), 0, "no marker");
        drop(hold);
        assert!(
            shell.started(SECOND, &worktree).expect("reply")["markerId"].is_string(),
            "the deadline took no mutex"
        );
    }

    /// Writes a stored trust record of the worktree with that common directory.
    fn approve(shell: &Shell, worktree: &Path, git_directory: &Path, common: &Path) {
        let confirmed = shell.stores.trust.confirm_with(
            &Confirm {
                worktree_root: worktree.to_path_buf(),
                git_directory: git_directory.to_path_buf(),
                common_directory: common.to_path_buf(),
                git_selected_path: shell.fixture.path("git.exe"),
                fingerprint: "a".repeat(64),
                persist: true,
                bound: None,
            },
            &crate::bootstrap::native_identity,
            |_| true,
        );
        assert!(
            matches!(confirmed, settings::Confirmed::Approved { record: Some(_) }),
            "stored"
        );
    }

    #[test]
    fn a_revoke_frame_deletes_the_path_records_at_once_and_replies_deadline_while_its_open_waits() {
        let shell = Shell::with_deadline(Duration::from_secs(2));
        let main = shell.folder("main");
        let common = shell.folder("main\\.git");
        let link = shell.fixture.path("link");
        assert!(
            crate::process_requests::tests::junction(&link, &common),
            "junction"
        );
        let linked = shell.folder("linked");
        let linked_git = shell.folder("linked\\gitdir");
        approve(&shell, &main, &common, &common);
        approve(&shell, &linked, &linked_git, &link);
        assert_eq!(shell.stores.trust.records().len(), 2);
        let mut hold = Some(Hold::new(&common));
        let call = uuid();
        let (returned, reply) = returns_at_once(&mut hold, || {
            revoke(
                &shell.stores.trust,
                &shell.requests,
                &shell.jobs,
                &call,
                &common,
            )
        });
        assert!(returned, "the frame reader never waits on the open");
        assert_eq!(reply, None, "the walk sends the reply");
        assert_eq!(
            shell.stores.trust.records().len(),
            1,
            "the record with that path goes before the walk"
        );
        assert_eq!(
            shell.take_sent(&call),
            Some(
                json!({ "kind": "trust", "trust": { "type": "revoke", "callId": call, "deadline": "deadline" } })
            )
        );
        assert_eq!(
            shell.stores.trust.records().len(),
            1,
            "the record with only that identity stays at the deadline"
        );
        drop(hold);
        let again = uuid();
        let returned = revoke(
            &shell.stores.trust,
            &shell.requests,
            &shell.jobs,
            &again,
            &common,
        );
        assert_eq!(
            shell.answer("trust", &again, returned),
            Some(json!({ "type": "revoke", "callId": again, "endedProcesses": 0 }))
        );
        assert!(
            shell.stores.trust.records().is_empty(),
            "the identity match goes"
        );
    }
}
