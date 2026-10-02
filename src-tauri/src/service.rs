// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

use crate::bootstrap::Contexts;
use crate::env_sanitize::sanitize;
use crate::framing::{FrameError, read_frame, write_frame};
use crate::ipc::{Ipc, MAIN_WINDOW, ToRenderer, renderer_message};
use crate::jobs::{Job, Supervisor};
use crate::process_requests::{
    CHUNK_BYTES, Config, Owned, ProcessRequests, decode_strict, is_identifier, wait,
};
use crate::spawn::{Input, SpawnRequest, spawn};

/// tauri-build copies `externalBin` next to the application executable without the target triple (tauri-build lib.rs:140-167).
/// The NSIS bundle installs it beside `arbareto.exe` too.
const SIDECAR: &str = "arbareto-git.exe";
/// Interim bound of the handshake reply. T063 sets the startup order and its bound.
const HANDSHAKE_WAIT: Duration = Duration::from_secs(10);
/// The progress event of the main window. Contract §2 names no channel for progress events.
const PROGRESS_EVENT: &str = "operation-progress";

/// The compiled Git service, its Job, and the frame routes of its pipes (contract §1 and §6).
pub struct Service {
    app: AppHandle,
    pub ipc: Arc<Ipc>,
    requests: Arc<ProcessRequests>,
    jobs: Arc<Supervisor>,
    contexts: Arc<Contexts>,
    stdin: Arc<Mutex<Option<File>>>,
    job: Mutex<Option<Job>>,
    closing: AtomicBool,
}

impl Service {
    /// Starts the service and sends the startup handshake. A failed start or handshake leaves no session (contract §2).
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
            stdin,
            job: Mutex::new(None),
            closing: AtomicBool::new(false),
        });
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
        let me = Arc::clone(self);
        let stdout = spawned.stdout;
        std::thread::spawn(move || me.read(stdout, &handshake));
        let me = Arc::clone(self);
        std::thread::spawn(move || me.watch(process));

        write(&self.stdin, &handshake_frame());
        match reply.recv_timeout(HANDSHAKE_WAIT) {
            Ok(Some(session_id)) => self.ipc.set_session(Some(session_id)),
            // A failed handshake ends the service. A missing reply ends it here.
            _ => drop(lock(&self.job).take()),
        }
    }

    /// Reads the service frames until end-of-file.
    fn read(&self, mut stdout: File, handshake: &mpsc::Sender<Option<String>>) {
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
    fn route(&self, body: &str, handshake: &mpsc::Sender<Option<String>>) {
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
            // T063 routes `mutation` frames to the T059 marker store and `trust` frames to the T059 record store.
            _ => {}
        }
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
        self.contexts.restart("");
        self.ipc.set_session(None);
        // T063 adds the unresolved recovery markers.
        let _ = self
            .app
            .emit_to(MAIN_WINDOW, "service-stopped", json!({ "markers": [] }));
    }

    /// Application close: the operation Jobs, then the lingering Jobs, then the service Job (contract §6 "Lingering Jobs").
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.jobs.close_all();
        drop(lock(&self.job).take());
        self.jobs.shutdown();
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

/// The startup handshake (contract §6 "Startup handshake").
// T063 replaces the fixed values: the platform scope, the WebView2 version, the build commit, the markers, and the trust records.
fn handshake_frame() -> String {
    json!({
        "kind": "handshake",
        "handshake": {
            "version": 1,
            "restarted": false,
            "platformScope": "other",
            "osBuild": os_build(),
            "webView2Version": "",
            "buildIdentity": {
                "version": env!("CARGO_PKG_VERSION"),
                "commit": "0".repeat(40),
                "signing": "unsigned",
            },
            "markers": [],
            "unloadedMarkers": 0,
            "trustRecords": [],
        },
    })
    .to_string()
}

/// The OS build number from `RtlGetVersion`, or 0 when the call fails.
fn os_build() -> u32 {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a live local, and its size field matches the structure.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.is_ok() {
        info.dwBuildNumber
    } else {
        0
    }
}
